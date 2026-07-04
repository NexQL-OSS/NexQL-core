/**
 * AI Index Advisor (Phase 4.2)
 *
 * Analyses the top 10 slowest queries recorded in pg_stat_statements and
 * produces index-improvement recommendations in two forms:
 *   1. A new `.pgsql` notebook with statistics tables and helper SQL.
 *   2. A pre-formatted prompt sent to the Chat Assistant (if available).
 */
import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { getDatabaseConnection, NotebookBuilder, MarkdownUtils } from './helper';
import { ErrorHandlers } from './helper';
import { AssistantGateway } from '../services/assistant/AssistantGateway';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function cmdIndexAdvisor(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  let conn: Awaited<ReturnType<typeof getDatabaseConnection>> | undefined;
  try {
    conn = await getDatabaseConnection(item);
    const { client, metadata } = conn;

    // ── Step 1: Check whether pg_stat_statements is installed ─────────────
    const extCheck = await client.query<{ available: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
       ) AS available`
    );
    const available: boolean = extCheck.rows[0]?.available ?? false;

    if (!available) {
      const choice = await vscode.window.showWarningMessage(
        'pg_stat_statements extension is not installed. ' +
          'Run: CREATE EXTENSION pg_stat_statements;',
        'Create Extension',
        'Cancel'
      );

      if (choice === 'Create Extension') {
        await _openCreateExtensionNotebook(metadata);
      }
      return;
    }

    // ── Step 2: Fetch top 10 slowest queries ──────────────────────────────
    const slowResult = await client.query<SlowQuery>(SLOW_QUERIES_SQL);
    const slowQueries: SlowQuery[] = slowResult.rows;

    if (slowQueries.length === 0) {
      vscode.window.showInformationMessage(
        'No slow queries found in pg_stat_statements ' +
          '(queries need at least 5 calls to appear).'
      );
      return;
    }

    // ── Step 3: Build AI prompt ───────────────────────────────────────────
    const prompt = _buildAiPrompt(slowQueries);

    // ── Step 4: Open result notebook ──────────────────────────────────────
    await _openAdvisorNotebook(metadata, slowQueries, prompt);

    // ── Step 5: Send prompt to Chat Assistant if available ────────────────
    await _sendToChat(prompt);
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'Index Advisor');
  } finally {
    if (conn?.release) { conn.release(); }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlowQuery {
  queryid: string;
  query: string;
  calls: string | number;
  mean_ms: string | number;
  total_ms: string | number;
  stddev_ms: string | number;
  rows: string | number;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SLOW_QUERIES_SQL = `
SELECT
  queryid::text,
  LEFT(query, 500) AS query,
  calls,
  ROUND(mean_exec_time::numeric, 2)   AS mean_ms,
  ROUND(total_exec_time::numeric, 2)  AS total_ms,
  ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
  rows
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
  AND query NOT LIKE 'BEGIN%'
  AND query NOT LIKE 'COMMIT%'
  AND query NOT LIKE 'ROLLBACK%'
  AND calls >= 5
ORDER BY mean_exec_time DESC
LIMIT 10
`.trim();

// ---------------------------------------------------------------------------
// AI Prompt builder
// ---------------------------------------------------------------------------

function _buildAiPrompt(queries: SlowQuery[]): string {
  const queryList = queries
    .map((q, idx) => {
      const truncated = String(q.query).replace(/\s+/g, ' ').trim();
      return [
        `### Query ${idx + 1}`,
        `**Query ID:** ${q.queryid}`,
        `**Mean execution time:** ${q.mean_ms} ms | **Calls:** ${q.calls} | **Total time:** ${q.total_ms} ms | **Rows:** ${q.rows}`,
        '',
        '```sql',
        truncated,
        '```',
      ].join('\n');
    })
    .join('\n\n---\n\n');

  return `You are a PostgreSQL performance expert. Analyse these slow queries and suggest missing indexes.

For each query, provide:
1. Which table(s) and column(s) are likely missing an index
2. The exact CREATE INDEX CONCURRENTLY statement
3. Estimated impact (why this index will help)
4. Any warnings (e.g., index bloat, write overhead)

Format each suggestion as:

## Query [N]: [truncated query text]
**Mean execution time:** X ms | **Calls:** N

### Suggested Index:
\`\`\`sql
CREATE INDEX CONCURRENTLY idx_tablename_column ON schema.table (column);
\`\`\`

**Rationale:** [explanation]

---

## Slow Queries (from pg_stat_statements)

${queryList}
`;
}

// ---------------------------------------------------------------------------
// Notebook helpers
// ---------------------------------------------------------------------------

/** Open a notebook that just creates the pg_stat_statements extension */
async function _openCreateExtensionNotebook(metadata: any): Promise<void> {
  await new NotebookBuilder(metadata)
    .addMarkdown(
      MarkdownUtils.header('Install pg_stat_statements') +
        MarkdownUtils.warningBox(
          'pg_stat_statements must be added to <code>shared_preload_libraries</code> ' +
            'in <code>postgresql.conf</code> and the server restarted before creating the extension.',
          'Prerequisites'
        )
    )
    .addSql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;')
    .show();
}

/** Open the main advisor notebook */
async function _openAdvisorNotebook(
  metadata: any,
  queries: SlowQuery[],
  prompt: string
): Promise<void> {
  // Build markdown stats table
  const tableRows = queries
    .map(
      (q, idx) =>
        `| ${idx + 1} | ${_escMd(String(q.query).replace(/\s+/g, ' ').substring(0, 80))} | ` +
        `${q.mean_ms} ms | ${q.calls} | ${q.total_ms} ms | ${q.rows} |`
    )
    .join('\n');

  const statsMarkdown =
    MarkdownUtils.header(
      'AI Index Advisor',
      `Top ${queries.length} slowest queries from \`pg_stat_statements\``
    ) +
    MarkdownUtils.infoBox(
      'Send the prompt below to the Chat Assistant for index recommendations. ' +
        'The chat panel should open automatically if an AI provider is configured.',
      'Index Advisor'
    ) +
    `| # | Query (truncated) | Mean time | Calls | Total time | Rows |\n` +
    `|---|-------------------|-----------|-------|------------|------|\n` +
    tableRows;

  const promptMarkdown =
    `### AI Prompt\n\n` +
    `Send to AI Chat for index recommendations →\n\n` +
    `<details><summary>View full prompt</summary>\n\n` +
    `\`\`\`\n${prompt}\n\`\`\`\n\n</details>`;

  await new NotebookBuilder(metadata)
    .addMarkdown(statsMarkdown)
    .addSql(
      '-- Run this if pg_stat_statements is not yet installed:\n' +
        'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
    )
    .addMarkdown(promptMarkdown)
    .addSql(
      '-- Full pg_stat_statements output (top 20 by mean exec time)\n' +
        'SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20;'
    )
    .show();
}

// ---------------------------------------------------------------------------
// Chat integration
// ---------------------------------------------------------------------------

async function _sendToChat(prompt: string): Promise<void> {
  try {
    await AssistantGateway.getInstance().invoke({
      intent: 'indexAdvice',
      items: [],
      draftText: prompt,
      send: 'draft',
    });
  } catch {
    // Chat assistant is optional; silently ignore if unavailable
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function _escMd(str: string): string {
  return str
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .replace(/`/g, "'");
}
