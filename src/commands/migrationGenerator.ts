/**
 * AI Migration Generator (Phase 4.6)
 *
 * Generates a complete PostgreSQL migration (forward + rollback) from a
 * plain-English change description, using the AI chat assistant and
 * NotebookBuilder to produce a ready-to-use .pgsql notebook.
 */
import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { getDatabaseConnection, NotebookBuilder, MarkdownUtils, ErrorHandlers } from './helper';
import { ConnectionManager } from '../services/ConnectionManager';
import { AssistantGateway } from '../services/assistant/AssistantGateway';

// ─── Public command entry point ───────────────────────────────────────────────

export async function cmdMigrationGenerator(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    // ── Step 1: Collect the change description ──────────────────────────────
    const userDescription = await vscode.window.showInputBox({
      title: 'AI Migration Generator',
      prompt: 'Describe the schema change in plain English',
      placeHolder:
        'e.g. Add a soft-delete column deleted_at timestamp to the orders table',
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length < 5 ? 'Please provide a more detailed description.' : undefined
    });

    if (!userDescription) {
      return; // User cancelled
    }

    // ── Step 2: Resolve connection / schema ──────────────────────────────────
    let database: string;
    let schema: string;
    let connectionId: string;
    let connectionName: string;
    let metadata: any;
    let releaseClient: (() => void) | undefined;
    let pgClient: any;

    if (item?.connectionId && item?.databaseName) {
      // Called from tree context menu — use the item's connection
      const conn = await getDatabaseConnection(item);
      pgClient = conn.client;
      metadata = conn.metadata;
      releaseClient = conn.release;
      database = item.databaseName;
      schema = item.schema || 'public';
      connectionId = item.connectionId;
      connectionName = metadata.name || connectionId;
    } else {
      // No tree item — ask the user to pick a connection
      const connections: any[] = vscode.workspace
        .getConfiguration()
        .get('postgresExplorer.connections') || [];

      if (connections.length === 0) {
        vscode.window.showWarningMessage(
          'No PostgreSQL connections configured. Please add a connection first.'
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        connections.map(c => ({
          label: c.name || `${c.host}:${c.port}`,
          description: c.host,
          detail: `User: ${c.username}`,
          connection: c
        })),
        { placeHolder: 'Select the target connection', ignoreFocusOut: true }
      );
      if (!picked) { return; }

      const dbInput = await vscode.window.showInputBox({
        title: 'Target database',
        prompt: 'Enter the database name',
        placeHolder: 'e.g. myapp_production',
        value: picked.connection.database || '',
        ignoreFocusOut: true
      });
      if (!dbInput) { return; }

      const schemaInput = await vscode.window.showInputBox({
        title: 'Target schema',
        prompt: 'Enter the schema name',
        placeHolder: 'e.g. public',
        value: 'public',
        ignoreFocusOut: true
      });
      if (schemaInput === undefined) { return; }

      const conn = picked.connection;
      database = dbInput.trim();
      schema = schemaInput.trim() || 'public';
      connectionId = conn.id;
      connectionName = conn.name || conn.host;

      try {
        pgClient = await ConnectionManager.getInstance().getPooledClient({
          id: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          database,
          name: conn.name
        });
        releaseClient = () => pgClient.release();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not connect to "${connectionName}": ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      metadata = {
        connectionId,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        database,
        databaseName: database,
        name: connectionName
      };
    }

    // ── Step 3: Gather schema context ────────────────────────────────────────
    let schemaContext = '';
    try {
      schemaContext = await fetchRelevantSchemaContext(
        pgClient,
        database,
        schema,
        userDescription
      );
    } catch (err) {
      // Non-fatal — proceed without schema context
      schemaContext = '(Could not fetch schema context — please review the migration carefully.)';
    } finally {
      if (releaseClient) { releaseClient(); }
    }

    // ── Step 4: Build the AI prompt ──────────────────────────────────────────
    const aiPrompt = buildMigrationPrompt(
      database,
      schema,
      userDescription,
      schemaContext
    );

    // ── Step 5: Create the notebook with placeholder cells ───────────────────
    const markdownHeader =
      MarkdownUtils.header(
        `Migration: ${truncate(userDescription, 60)}`,
        `Generated by AI Migration Generator · Target: **${connectionName}** / **${database}** (schema: **${schema}**)`
      ) +
      MarkdownUtils.infoBox(
        'Review the forward and rollback migrations below before executing. ' +
        'Always test in a non-production environment first.'
      ) +
      MarkdownUtils.warningBox(
        'The SQL cells below are placeholders. Copy the AI-generated SQL from the chat panel ' +
        'into the appropriate cells, then execute them inside a transaction.'
      );

    const forwardPlaceholder =
      `-- Forward Migration\n` +
      `-- Paste AI-generated forward migration SQL here\n` +
      `-- BEGIN;\n` +
      `-- \n` +
      `-- Your migration SQL\n` +
      `-- \n` +
      `-- COMMIT;`;

    const rollbackPlaceholder =
      `-- Rollback Migration\n` +
      `-- Paste AI-generated rollback SQL here\n` +
      `-- BEGIN;\n` +
      `-- \n` +
      `-- Your rollback SQL\n` +
      `-- \n` +
      `-- COMMIT;`;

    await new NotebookBuilder(metadata)
      .addMarkdown(markdownHeader)
      .addMarkdown('##### Forward Migration')
      .addSql(forwardPlaceholder)
      .addMarkdown('##### Rollback Migration')
      .addSql(rollbackPlaceholder)
      .show();

    // ── Step 6: Send prompt to AI chat panel ─────────────────────────────────
    await sendPromptToChat(aiPrompt);

  } catch (err) {
    await ErrorHandlers.handleCommandError(err, 'AI Migration Generator');
  }
}

// ─── Send to chat view ────────────────────────────────────────────────────────

async function sendPromptToChat(prompt: string): Promise<void> {
  try {
    await AssistantGateway.getInstance().invoke({
      intent: 'reviewMigration',
      items: [],
      draftText: prompt,
      send: 'draft',
    });
    vscode.window.setStatusBarMessage(
      'AI Migration Generator: prompt attached to SQL Assistant. Review and press Send.',
      5000
    );
    return;
  } catch {
    // Fall through to fallback
  }

  // Fallback: show the prompt in a VS Code information message with a "Copy" button
  const choice = await vscode.window.showInformationMessage(
    `Migration prompt ready. Copy it to your AI assistant.`,
    'Copy Prompt'
  );
  if (choice === 'Copy Prompt') {
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.setStatusBarMessage('Migration prompt copied to clipboard', 5000);
  }
}

// ─── Schema context fetcher ───────────────────────────────────────────────────

/**
 * Heuristically identifies table names mentioned in the description and fetches
 * their column lists and constraint summaries from PostgreSQL catalogs.
 */
async function fetchRelevantSchemaContext(
  client: any,
  database: string,
  schema: string,
  description: string
): Promise<string> {
  // Pull all tables in the schema to see which ones match words in the description
  const allTablesResult = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema]
  );

  const allTables: string[] = allTablesResult.rows.map((r: any) => r.table_name as string);
  const words = description.toLowerCase().split(/\W+/).filter(w => w.length > 2);

  // Find tables that match any word in the description (fuzzy: word is a substring of table name or vice versa)
  const mentionedTables = allTables.filter(t =>
    words.some(w => t.includes(w) || w.includes(t))
  );

  // Limit to at most 5 tables to keep the prompt size reasonable
  const targetTables = mentionedTables.slice(0, 5);

  if (targetTables.length === 0) {
    return `Schema "${schema}" in database "${database}" — no specific tables identified from description.\n` +
      `All tables in schema: ${allTables.slice(0, 30).join(', ')}${allTables.length > 30 ? ' ...' : ''}`;
  }

  const sections: string[] = [];

  for (const tableName of targetTables) {
    const colResult = await client.query(
      `SELECT
         column_name,
         data_type,
         is_nullable,
         column_default,
         character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, tableName]
    );

    const constraintResult = await client.query(
      `SELECT
         tc.constraint_name,
         tc.constraint_type,
         pg_get_constraintdef(c.oid) as definition
       FROM information_schema.table_constraints tc
       JOIN pg_constraint c ON c.conname = tc.constraint_name
       JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = tc.table_schema
       WHERE tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, tableName]
    );

    let section = `### Table: ${schema}.${tableName}\n`;
    section += '| column | type | nullable | default |\n';
    section += '|--------|------|----------|---------|\n';
    for (const col of colResult.rows) {
      const typeStr = col.character_maximum_length
        ? `${col.data_type}(${col.character_maximum_length})`
        : col.data_type;
      section += `| ${col.column_name} | ${typeStr} | ${col.is_nullable} | ${col.column_default || '-'} |\n`;
    }

    if (constraintResult.rows.length > 0) {
      section += '\n**Constraints:**\n';
      for (const con of constraintResult.rows) {
        section += `- ${con.constraint_name} (${con.constraint_type}): ${con.definition}\n`;
      }
    }

    sections.push(section);
  }

  return sections.join('\n\n');
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildMigrationPrompt(
  database: string,
  schema: string,
  userDescription: string,
  schemaContext: string
): string {
  return `You are a PostgreSQL migration expert. Generate a complete, safe migration for the following change.

Database: ${database}
Schema: ${schema}

CHANGE REQUEST: "${userDescription}"

RELEVANT SCHEMA CONTEXT:
${schemaContext}

Please provide:
1. A forward migration SQL (the change itself)
2. A rollback migration SQL (how to undo the change)
3. Any safety considerations (data loss risk, locking concerns, etc.)
4. Whether to use CONCURRENTLY for index operations

Format your response as:
## Migration: [brief title]

### Forward Migration
\`\`\`sql
BEGIN;

-- Your migration SQL here

COMMIT;
\`\`\`

### Rollback Migration
\`\`\`sql
BEGIN;

-- How to undo this migration

COMMIT;
\`\`\`

### Safety Notes
[Any warnings about locking, data loss, or recommended approach]`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
