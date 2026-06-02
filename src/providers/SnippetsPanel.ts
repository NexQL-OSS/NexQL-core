/**
 * Query Snippets Library Panel (Phase 5.2)
 *
 * A webview panel showing a categorized library of PostgreSQL query snippets.
 * Supports built-in snippets, custom user snippets (stored in globalState),
 * search/filter, copy-to-clipboard, and insert-into-active-notebook.
 */
import * as vscode from 'vscode';
import { WebviewPool } from '../utils/WebviewPool';

// ─── Data Model ──────────────────────────────────────────────────────────────

interface Snippet {
  id?: string;       // only set on custom snippets
  title: string;
  description: string;
  tags: string[];
  sql: string;
  custom?: boolean;
}

interface SnippetCategory {
  category: string;
  snippets: Snippet[];
}

// ─── Built-in Snippets ────────────────────────────────────────────────────────

const BUILT_IN_SNIPPETS: SnippetCategory[] = [
  {
    category: '🔍 Query Patterns',
    snippets: [
      {
        title: 'Basic SELECT',
        description: 'Simple query with WHERE',
        tags: ['select', 'basic'],
        sql: `SELECT *\nFROM {{schema}}.{{table}}\nWHERE {{column}} = '{{value}}'\nLIMIT 100;`
      },
      {
        title: 'JOIN two tables',
        description: 'INNER JOIN pattern',
        tags: ['join'],
        sql: `SELECT a.*, b.{{col}}\nFROM {{schema}}.{{table_a}} a\nINNER JOIN {{schema}}.{{table_b}} b ON a.{{fk}} = b.{{pk}}\nWHERE a.{{condition}}\nLIMIT 100;`
      },
      {
        title: 'CTE (Common Table Expression)',
        description: 'WITH clause pattern',
        tags: ['cte', 'with'],
        sql: `WITH cte AS (\n  SELECT {{columns}}\n  FROM {{schema}}.{{table}}\n  WHERE {{condition}}\n)\nSELECT *\nFROM cte;`
      },
      {
        title: 'Window function - ROW_NUMBER',
        description: 'Rank rows per group',
        tags: ['window', 'rank'],
        sql: `SELECT\n  *,\n  ROW_NUMBER() OVER (PARTITION BY {{group_col}} ORDER BY {{order_col}} DESC) as rn\nFROM {{schema}}.{{table}};`
      },
      {
        title: 'Upsert (INSERT ON CONFLICT)',
        description: 'Insert or update',
        tags: ['upsert', 'insert'],
        sql: `INSERT INTO {{schema}}.{{table}} ({{columns}})\nVALUES ({{values}})\nON CONFLICT ({{conflict_col}}) DO UPDATE SET\n  {{column}} = EXCLUDED.{{column}},\n  updated_at = NOW();`
      }
    ]
  },
  {
    category: '📊 Aggregations',
    snippets: [
      {
        title: 'GROUP BY with HAVING',
        description: 'Aggregate with filter',
        tags: ['aggregate', 'group'],
        sql: `SELECT\n  {{group_col}},\n  COUNT(*) as total,\n  AVG({{measure}}) as avg_value,\n  SUM({{measure}}) as sum_value\nFROM {{schema}}.{{table}}\nGROUP BY {{group_col}}\nHAVING COUNT(*) > {{min_count}}\nORDER BY total DESC;`
      },
      {
        title: 'Percentiles',
        description: 'p50, p95, p99 percentiles',
        tags: ['percentile', 'stats'],
        sql: `SELECT\n  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY {{col}}) as p50,\n  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY {{col}}) as p95,\n  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY {{col}}) as p99\nFROM {{schema}}.{{table}};`
      }
    ]
  },
  {
    category: '🔧 Maintenance',
    snippets: [
      {
        title: 'Table bloat estimate',
        description: 'Check dead tuple bloat',
        tags: ['maintenance', 'bloat'],
        sql: `SELECT\n  schemaname, tablename,\n  n_dead_tup, n_live_tup,\n  ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) as dead_pct,\n  last_autovacuum, last_autoanalyze\nFROM pg_stat_user_tables\nORDER BY dead_pct DESC NULLS LAST\nLIMIT 20;`
      },
      {
        title: 'Index usage',
        description: 'Find unused indexes',
        tags: ['index', 'maintenance'],
        sql: `SELECT\n  schemaname, tablename, indexname,\n  idx_scan, idx_tup_read, idx_tup_fetch,\n  pg_size_pretty(pg_relation_size(indexrelid)) as index_size\nFROM pg_stat_user_indexes\nORDER BY idx_scan ASC\nLIMIT 20;`
      },
      {
        title: 'Long running queries',
        description: 'Queries running >5 min',
        tags: ['monitoring', 'performance'],
        sql: `SELECT\n  pid, usename, state,\n  ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric/60, 1) as minutes,\n  LEFT(query, 150) as query\nFROM pg_stat_activity\nWHERE query_start < now() - INTERVAL '5 minutes'\n  AND state != 'idle'\nORDER BY query_start ASC;`
      },
      {
        title: 'Lock waits',
        description: 'Find blocking locks',
        tags: ['locks', 'monitoring'],
        sql: `SELECT\n  blocked.pid as blocked_pid,\n  blocked.usename as blocked_user,\n  blocking.pid as blocking_pid,\n  blocking.usename as blocking_user,\n  blocked.query as blocked_query,\n  blocking.query as blocking_query\nFROM pg_stat_activity blocked\nJOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))\nWHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;`
      }
    ]
  },
  {
    category: '📋 Schema Inspection',
    snippets: [
      {
        title: 'Table column details',
        description: 'Full column info for a table',
        tags: ['schema', 'columns'],
        sql: `SELECT\n  column_name, data_type, is_nullable,\n  column_default, character_maximum_length\nFROM information_schema.columns\nWHERE table_schema = '{{schema}}' AND table_name = '{{table}}'\nORDER BY ordinal_position;`
      },
      {
        title: 'Foreign key map',
        description: 'All FK relationships in schema',
        tags: ['schema', 'fk'],
        sql: `SELECT\n  tc.table_name, kcu.column_name,\n  ccu.table_name AS foreign_table, ccu.column_name AS foreign_column,\n  tc.constraint_name\nFROM information_schema.table_constraints tc\nJOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)\nJOIN information_schema.constraint_column_usage ccu USING (constraint_name, table_schema)\nWHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '{{schema}}'\nORDER BY tc.table_name;`
      },
      {
        title: 'Table sizes',
        description: 'Size of all tables in schema',
        tags: ['schema', 'size'],
        sql: `SELECT\n  schemaname, tablename,\n  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,\n  pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,\n  pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename)) as index_size,\n  n_live_tup as row_estimate\nFROM pg_stat_user_tables\nWHERE schemaname = '{{schema}}'\nORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;`
      }
    ]
  },
  {
    category: '⚡ Performance',
    snippets: [
      {
        title: 'Cache hit ratio',
        description: 'Buffer cache effectiveness',
        tags: ['performance', 'cache'],
        sql: `SELECT\n  ROUND(100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 2) as cache_hit_ratio\nFROM pg_stat_database;`
      },
      {
        title: 'Slowest queries (pg_stat_statements)',
        description: 'Top 10 slowest by mean time',
        tags: ['performance', 'slow'],
        sql: `SELECT\n  LEFT(query, 100) as query,\n  calls, ROUND(mean_exec_time::numeric, 2) as mean_ms,\n  ROUND(total_exec_time::numeric/1000, 2) as total_sec\nFROM pg_stat_statements\nORDER BY mean_exec_time DESC\nLIMIT 10;`
      },
      {
        title: 'Missing indexes (seq scans)',
        description: 'Tables with high seq scan count',
        tags: ['performance', 'index'],
        sql: `SELECT\n  schemaname, relname as table,\n  seq_scan, seq_tup_read,\n  idx_scan, idx_tup_fetch,\n  ROUND(100.0 * seq_scan / NULLIF(seq_scan + idx_scan, 0), 1) as seq_scan_pct\nFROM pg_stat_user_tables\nWHERE seq_scan > 0\nORDER BY seq_scan DESC\nLIMIT 20;`
      }
    ]
  }
];

// ─── Storage key ──────────────────────────────────────────────────────────────

const CUSTOM_SNIPPETS_KEY = 'pgStudio.customSnippets';

// ─── Panel class ──────────────────────────────────────────────────────────────

export class SnippetsPanel {
  private static _panel: vscode.WebviewPanel | undefined;
  private static _disposables: vscode.Disposable[] = [];

  private static _disposeWebviewSubscriptions(): void {
    for (const d of SnippetsPanel._disposables) {
      d.dispose();
    }
    SnippetsPanel._disposables = [];
  }

  /** Show (or reveal) the Snippets Library panel */
  static show(context: vscode.ExtensionContext): void {
    if (SnippetsPanel._panel) {
      SnippetsPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    SnippetsPanel._disposeWebviewSubscriptions();
    const { panel, commit } = WebviewPool.getInstance().getOrCreate(
      'pgStudio.snippetsLibrary',
      'snippetsLibrary',
      'SQL Snippets Library',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      },
      {
        onDispose: () => {
          if (SnippetsPanel._panel === panel) {
            SnippetsPanel._disposeWebviewSubscriptions();
            SnippetsPanel._panel = undefined;
          }
        },
        onRecycle: (recycled) => {
          if (SnippetsPanel._panel === recycled.panel) {
            SnippetsPanel._disposeWebviewSubscriptions();
            SnippetsPanel._panel = undefined;
          }
        },
      }
    );

    SnippetsPanel._panel = panel;
    commit?.();

    // Initial render
    const customSnippets: Snippet[] = context.globalState.get(CUSTOM_SNIPPETS_KEY, []);
    panel.webview.html = SnippetsPanel._buildHtml(BUILT_IN_SNIPPETS, customSnippets);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {

        case 'insertSnippet': {
          await SnippetsPanel._insertSnippetIntoNotebook(message.sql);
          break;
        }

        case 'copySnippet': {
          await vscode.env.clipboard.writeText(message.sql);
          vscode.window.setStatusBarMessage('SQL copied to clipboard', 3000);
          break;
        }

        case 'saveCustomSnippet': {
          const snippet: Snippet = message.snippet;
          snippet.id = `custom-${Date.now()}`;
          snippet.custom = true;
          const existing: Snippet[] = context.globalState.get(CUSTOM_SNIPPETS_KEY, []);
          existing.push(snippet);
          await context.globalState.update(CUSTOM_SNIPPETS_KEY, existing);
          // Re-render with updated custom snippets
          panel.webview.html = SnippetsPanel._buildHtml(BUILT_IN_SNIPPETS, existing);
          vscode.window.setStatusBarMessage('Custom snippet saved', 3000);
          break;
        }

        case 'deleteCustomSnippet': {
          const existing: Snippet[] = context.globalState.get(CUSTOM_SNIPPETS_KEY, []);
          const updated = existing.filter(s => s.id !== message.id);
          await context.globalState.update(CUSTOM_SNIPPETS_KEY, updated);
          panel.webview.html = SnippetsPanel._buildHtml(BUILT_IN_SNIPPETS, updated);
          vscode.window.setStatusBarMessage('Custom snippet deleted', 3000);
          break;
        }
      }
    }, null, SnippetsPanel._disposables);
  }

  // ── Insert snippet into the active .pgsql notebook ────────────────────────

  private static async _insertSnippetIntoNotebook(sql: string): Promise<void> {
    // Find an open .pgsql notebook editor
    const notebookEditor = vscode.window.activeNotebookEditor;
    let targetNotebook: vscode.NotebookDocument | undefined;

    if (notebookEditor && !notebookEditor.notebook.isClosed &&
        notebookEditor.notebook.uri.fsPath.endsWith('.pgsql')) {
      targetNotebook = notebookEditor.notebook;
    } else {
      // Search open notebooks for a .pgsql file
      targetNotebook = vscode.workspace.notebookDocuments.find(
        nd => !nd.isClosed && nd.uri.fsPath.endsWith('.pgsql')
      );
    }

    if (!targetNotebook) {
      vscode.window.showWarningMessage(
        'No active .pgsql notebook found. Open a notebook first, then insert the snippet.',
        'OK'
      );
      return;
    }

    const insertIndex = targetNotebook.cellCount;
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, 'sql');
    const edit = new vscode.WorkspaceEdit();
    edit.set(targetNotebook.uri, [vscode.NotebookEdit.insertCells(insertIndex, [cell])]);
    await vscode.workspace.applyEdit(edit);

    // Reveal and focus the notebook at the new cell
    const editor = await vscode.window.showNotebookDocument(targetNotebook, { preserveFocus: false });
    if (insertIndex < targetNotebook.cellCount) {
      editor.revealRange(
        new vscode.NotebookRange(insertIndex, insertIndex + 1),
        vscode.NotebookEditorRevealType.AtTop
      );
    }

    vscode.window.setStatusBarMessage('Snippet inserted into notebook', 3000);
  }

  // ── HTML generation ───────────────────────────────────────────────────────

  private static _buildHtml(builtIn: SnippetCategory[], custom: Snippet[]): string {
    // Merge custom snippets into a "My Snippets" category (if any)
    const allCategories: SnippetCategory[] = [...builtIn];
    if (custom.length > 0) {
      allCategories.unshift({
        category: '⭐ My Snippets',
        snippets: custom
      });
    }

    const categoriesJson = JSON.stringify(allCategories);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SQL Snippets Library</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #454545);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-sec-bg: var(--vscode-button-secondaryBackground);
      --btn-sec-fg: var(--vscode-button-secondaryForeground);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --card-bg: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      --highlight: var(--vscode-editor-findMatchHighlightBackground, rgba(255,215,0,0.3));
      --kw-color: var(--vscode-symbolIcon-keywordForeground, #569cd6);
      --fn-color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
      --str-color: var(--vscode-symbolIcon-stringForeground, #ce9178);
      --placeholder-color: #e9a74c;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--bg);
      color: var(--fg);
      padding: 12px 16px;
      min-height: 100vh;
    }

    h1 {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ── Search ── */
    #search-bar {
      width: 100%;
      padding: 6px 10px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, var(--border));
      border-radius: 4px;
      font-size: 13px;
      margin-bottom: 14px;
      outline: none;
    }
    #search-bar:focus { border-color: var(--vscode-focusBorder); }

    /* ── Toolbar ── */
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }

    button {
      padding: 4px 10px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      transition: background 0.15s;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
    }
    button.secondary:hover { background: var(--btn-sec-hover); }
    button.danger {
      background: rgba(220, 53, 69, 0.15);
      color: #f88;
      border: 1px solid rgba(220,53,69,0.4);
    }
    button.danger:hover { background: rgba(220,53,69,0.3); }

    /* ── Categories / Accordion ── */
    .category {
      margin-bottom: 10px;
      border: 1px solid var(--border);
      border-radius: 5px;
      overflow: hidden;
    }

    .category-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background, var(--card-bg));
      cursor: pointer;
      user-select: none;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.03em;
    }
    .category-header:hover { background: var(--vscode-list-hoverBackground); }

    .category-chevron {
      transition: transform 0.2s;
      font-style: normal;
      font-size: 10px;
    }
    .category-header.collapsed .category-chevron { transform: rotate(-90deg); }

    .category-body {
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .category-body.hidden { display: none; }

    /* ── Snippet Card ── */
    .snippet-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 12px;
    }
    .snippet-card.hidden { display: none; }

    .snippet-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 2px;
    }

    .snippet-desc {
      font-size: 11px;
      opacity: 0.75;
      margin-bottom: 6px;
    }

    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 8px;
    }

    .tag {
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
    }

    /* ── SQL Preview ── */
    .sql-preview {
      background: var(--vscode-textBlockQuote-background, rgba(0,0,0,0.2));
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.6;
      white-space: pre;
      overflow-x: auto;
      margin-bottom: 8px;
      max-height: 140px;
      overflow-y: auto;
    }

    /* Syntax tokens */
    .kw  { color: var(--kw-color); font-weight: bold; }
    .fn  { color: var(--fn-color); }
    .str { color: var(--str-color); }
    .ph  { color: var(--placeholder-color); font-style: italic; } /* placeholders */
    .cm  { color: var(--vscode-symbolIcon-colorForeground, #6a9955); }

    .card-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    /* ── New Snippet Form ── */
    #new-snippet-form {
      background: var(--card-bg);
      border: 1px solid var(--vscode-focusBorder, var(--border));
      border-radius: 5px;
      padding: 14px;
      margin-bottom: 14px;
      display: none;
    }
    #new-snippet-form.visible { display: block; }

    #new-snippet-form h3 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 10px;
    }

    .form-row {
      margin-bottom: 8px;
    }
    .form-row label {
      display: block;
      font-size: 11px;
      opacity: 0.8;
      margin-bottom: 3px;
    }
    .form-row input, .form-row textarea, .form-row select {
      width: 100%;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, var(--border));
      border-radius: 3px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
    }
    .form-row textarea {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      resize: vertical;
      min-height: 100px;
    }
    .form-row input:focus, .form-row textarea:focus { border-color: var(--vscode-focusBorder); }

    .form-actions { display: flex; gap: 8px; margin-top: 10px; }

    #no-results {
      text-align: center;
      opacity: 0.6;
      padding: 20px;
      display: none;
    }
  </style>
</head>
<body>
  <h1>📚 SQL Snippets Library</h1>

  <input id="search-bar" type="text" placeholder="Search snippets by title or tag..." autocomplete="off" />

  <div class="toolbar">
    <button id="btn-new-snippet">+ New Snippet</button>
    <button class="secondary" id="btn-expand-all">Expand All</button>
    <button class="secondary" id="btn-collapse-all">Collapse All</button>
  </div>

  <!-- New Snippet Form -->
  <div id="new-snippet-form">
    <h3>Add Custom Snippet</h3>
    <div class="form-row">
      <label>Title *</label>
      <input id="form-title" type="text" placeholder="e.g. My custom query" />
    </div>
    <div class="form-row">
      <label>Description</label>
      <input id="form-desc" type="text" placeholder="Short description" />
    </div>
    <div class="form-row">
      <label>Tags (comma-separated)</label>
      <input id="form-tags" type="text" placeholder="e.g. select, performance" />
    </div>
    <div class="form-row">
      <label>SQL *</label>
      <textarea id="form-sql" placeholder="SELECT * FROM ..."></textarea>
    </div>
    <div class="form-actions">
      <button id="form-save">Save Snippet</button>
      <button class="secondary" id="form-cancel">Cancel</button>
    </div>
  </div>

  <div id="snippets-container"></div>
  <div id="no-results">No snippets match your search.</div>

  <script>
    const vscode = acquireVsCodeApi();

    // ── Data ──────────────────────────────────────────────────────────────────
    const ALL_CATEGORIES = ${categoriesJson};

    // ── SQL Highlighter ────────────────────────────────────────────────────────
    const SQL_KEYWORDS = [
      'SELECT','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS',
      'ON','AS','AND','OR','NOT','IN','EXISTS','BETWEEN','LIKE','IS','NULL',
      'INSERT','INTO','VALUES','UPDATE','SET','DELETE','TRUNCATE',
      'CREATE','TABLE','INDEX','VIEW','SCHEMA','DATABASE','FUNCTION','TRIGGER',
      'ALTER','DROP','ADD','COLUMN','CONSTRAINT','PRIMARY','KEY','FOREIGN',
      'REFERENCES','UNIQUE','CHECK','DEFAULT','BEGIN','COMMIT','ROLLBACK',
      'WITH','UNION','ALL','DISTINCT','ORDER','BY','GROUP','HAVING','LIMIT',
      'OFFSET','RETURNING','OVER','PARTITION','ROWS','RANGE','UNBOUNDED',
      'PRECEDING','FOLLOWING','CURRENT','ROW','RECURSIVE','MATERIALIZED',
      'CONCURRENTLY','IF','EXISTS','GRANT','REVOKE','TO','INTERVAL',
      'CASE','WHEN','THEN','ELSE','END','CAST','NULLIF','COALESCE'
    ];
    const KW_RE = new RegExp('\\\\b(' + SQL_KEYWORDS.join('|') + ')\\\\b', 'gi');
    const FN_RE = /\\b(COUNT|SUM|AVG|MIN|MAX|ROUND|EXTRACT|DATE_TRUNC|NOW|CURRENT_TIMESTAMP|LENGTH|LOWER|UPPER|TRIM|SUBSTRING|REPLACE|ARRAY_AGG|STRING_AGG|JSON_AGG|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|FIRST_VALUE|LAST_VALUE|PERCENTILE_CONT|PERCENTILE_DISC|LEFT|RIGHT|NULLIF|COALESCE|TO_CHAR|TO_DATE|CAST|pg_size_pretty|pg_relation_size|pg_total_relation_size|pg_indexes_size|cardinality|ANY)\\s*(?=\\()/gi;
    const STR_RE = /'[^']*'/g;
    const CM_RE = /--[^\\n]*/g;
    const PH_RE = /\\{\\{[^}]+\\}\\}/g;

    function highlightSql(sql) {
      // Escape HTML first
      let s = sql
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Replace in passes using placeholders to avoid double-escaping
      const segments = [];
      let idx = 0;

      // Collect all token spans
      const tokens = [];

      // Comments
      let m;
      const cRe = /--[^\\n]*/g;
      while ((m = cRe.exec(s)) !== null) tokens.push({start: m.index, end: m.index + m[0].length, cls: 'cm', text: m[0]});
      // Strings
      const sRe = /'[^']*'/g;
      while ((m = sRe.exec(s)) !== null) tokens.push({start: m.index, end: m.index + m[0].length, cls: 'str', text: m[0]});
      // Placeholders
      const phRe = /\\{\\{[^}]+\\}\\}/g;
      while ((m = phRe.exec(s)) !== null) tokens.push({start: m.index, end: m.index + m[0].length, cls: 'ph', text: m[0]});

      // Sort and deduplicate (take first encountered if overlapping)
      tokens.sort((a, b) => a.start - b.start);

      let result = '';
      let pos = 0;
      for (const tok of tokens) {
        if (tok.start < pos) continue; // skip overlapping
        // highlight keywords/functions in the plain text between tokens
        const plain = s.slice(pos, tok.start);
        result += applyKeywordFn(plain);
        result += '<span class="' + tok.cls + '">' + tok.text + '</span>';
        pos = tok.end;
      }
      result += applyKeywordFn(s.slice(pos));
      return result;
    }

    function applyKeywordFn(plain) {
      // Functions first (before keywords, so ROUND etc don't get keyword-styled)
      plain = plain.replace(/\\b(COUNT|SUM|AVG|MIN|MAX|ROUND|EXTRACT|DATE_TRUNC|NOW|CURRENT_TIMESTAMP|LENGTH|LOWER|UPPER|TRIM|SUBSTRING|REPLACE|ARRAY_AGG|STRING_AGG|JSON_AGG|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|FIRST_VALUE|LAST_VALUE|PERCENTILE_CONT|PERCENTILE_DISC|NULLIF|COALESCE|TO_CHAR|TO_DATE|pg_size_pretty|pg_relation_size|pg_total_relation_size|pg_indexes_size|cardinality|ANY)(?=\\s*\\()/gi,
        '<span class="fn">$1</span>');
      plain = plain.replace(/\\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AS|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|INSERT|INTO|VALUES|UPDATE|SET|DELETE|TRUNCATE|CREATE|TABLE|INDEX|VIEW|SCHEMA|DATABASE|FUNCTION|TRIGGER|ALTER|DROP|ADD|COLUMN|CONSTRAINT|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|CHECK|DEFAULT|BEGIN|COMMIT|ROLLBACK|WITH|UNION|ALL|DISTINCT|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|RETURNING|OVER|PARTITION|ROWS|RANGE|UNBOUNDED|PRECEDING|FOLLOWING|CURRENT|ROW|RECURSIVE|MATERIALIZED|CONCURRENTLY|IF|INTERVAL|CASE|WHEN|THEN|ELSE|END|CAST|GRANT|REVOKE|TO)\\b/gi,
        '<span class="kw">$1</span>');
      return plain;
    }

    // ── Render ────────────────────────────────────────────────────────────────
    const container = document.getElementById('snippets-container');
    const noResults = document.getElementById('no-results');

    function renderCategories(filterText) {
      const q = filterText.trim().toLowerCase();
      container.innerHTML = '';
      let totalVisible = 0;

      for (const cat of ALL_CATEGORIES) {
        const visibleSnippets = cat.snippets.filter(s => {
          if (!q) return true;
          return s.title.toLowerCase().includes(q) ||
            (s.description && s.description.toLowerCase().includes(q)) ||
            (s.tags && s.tags.some(t => t.toLowerCase().includes(q)));
        });

        if (visibleSnippets.length === 0) continue;
        totalVisible += visibleSnippets.length;

        const catDiv = document.createElement('div');
        catDiv.className = 'category';

        const header = document.createElement('div');
        header.className = 'category-header';
        header.innerHTML = \`<span>\${escHtml(cat.category)} <span style="opacity:0.6;font-weight:400;">(\${visibleSnippets.length})</span></span><i class="category-chevron">▼</i>\`;
        header.addEventListener('click', () => {
          header.classList.toggle('collapsed');
          body.classList.toggle('hidden');
        });

        const body = document.createElement('div');
        body.className = 'category-body';

        for (const snippet of visibleSnippets) {
          const card = document.createElement('div');
          card.className = 'snippet-card';

          const tagsHtml = (snippet.tags || []).map(t => \`<span class="tag">\${escHtml(t)}</span>\`).join('');
          const deleteBtn = snippet.custom
            ? \`<button class="danger btn-delete" data-id="\${escAttr(snippet.id || '')}">Delete</button>\`
            : '';

          card.innerHTML = \`
            <div class="snippet-title">\${escHtml(snippet.title)}</div>
            <div class="snippet-desc">\${escHtml(snippet.description || '')}</div>
            <div class="tags">\${tagsHtml}</div>
            <div class="sql-preview">\${highlightSql(snippet.sql)}</div>
            <div class="card-actions">
              <button class="btn-insert" data-sql="\${escAttr(snippet.sql)}">Insert into Notebook</button>
              <button class="secondary btn-copy" data-sql="\${escAttr(snippet.sql)}">Copy SQL</button>
              \${deleteBtn}
            </div>
          \`;

          body.appendChild(card);
        }

        catDiv.appendChild(header);
        catDiv.appendChild(body);
        container.appendChild(catDiv);
      }

      noResults.style.display = totalVisible === 0 && q ? 'block' : 'none';
    }

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function escAttr(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ── Event Delegation ──────────────────────────────────────────────────────
    container.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || !target.closest) return;

      const insertBtn = target.closest('.btn-insert');
      if (insertBtn) {
        const sql = insertBtn.dataset.sql || '';
        vscode.postMessage({ type: 'insertSnippet', sql });
        return;
      }

      const copyBtn = target.closest('.btn-copy');
      if (copyBtn) {
        const sql = copyBtn.dataset.sql || '';
        vscode.postMessage({ type: 'copySnippet', sql });
        // Visual feedback
        const prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = prev; }, 1500);
        return;
      }

      const deleteBtn = target.closest('.btn-delete');
      if (deleteBtn) {
        const id = deleteBtn.dataset.id;
        if (id && confirm('Delete this custom snippet?')) {
          vscode.postMessage({ type: 'deleteCustomSnippet', id });
        }
        return;
      }
    });

    // ── Search ────────────────────────────────────────────────────────────────
    const searchBar = document.getElementById('search-bar');
    searchBar.addEventListener('input', () => {
      renderCategories(searchBar.value);
    });

    // ── Expand / Collapse All ─────────────────────────────────────────────────
    document.getElementById('btn-expand-all').addEventListener('click', () => {
      document.querySelectorAll('.category-header').forEach(h => {
        h.classList.remove('collapsed');
      });
      document.querySelectorAll('.category-body').forEach(b => {
        b.classList.remove('hidden');
      });
    });

    document.getElementById('btn-collapse-all').addEventListener('click', () => {
      document.querySelectorAll('.category-header').forEach(h => {
        h.classList.add('collapsed');
      });
      document.querySelectorAll('.category-body').forEach(b => {
        b.classList.add('hidden');
      });
    });

    // ── New Snippet Form ──────────────────────────────────────────────────────
    const form = document.getElementById('new-snippet-form');

    document.getElementById('btn-new-snippet').addEventListener('click', () => {
      form.classList.toggle('visible');
      if (form.classList.contains('visible')) {
        document.getElementById('form-title').focus();
      }
    });

    document.getElementById('form-cancel').addEventListener('click', () => {
      form.classList.remove('visible');
      clearForm();
    });

    document.getElementById('form-save').addEventListener('click', () => {
      const title = document.getElementById('form-title').value.trim();
      const description = document.getElementById('form-desc').value.trim();
      const tagsRaw = document.getElementById('form-tags').value.trim();
      const sql = document.getElementById('form-sql').value.trim();

      if (!title) { alert('Title is required.'); return; }
      if (!sql) { alert('SQL is required.'); return; }

      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

      vscode.postMessage({
        type: 'saveCustomSnippet',
        snippet: { title, description, tags, sql }
      });

      form.classList.remove('visible');
      clearForm();
    });

    function clearForm() {
      document.getElementById('form-title').value = '';
      document.getElementById('form-desc').value = '';
      document.getElementById('form-tags').value = '';
      document.getElementById('form-sql').value = '';
    }

    // ── Initial render ────────────────────────────────────────────────────────
    renderCategories('');
  </script>
</body>
</html>`;
  }
}
