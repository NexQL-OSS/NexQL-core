import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { resolveTreeItemConnection } from '../utils/resolveTreeItemConnection';
import { ErrorHandlers } from '../commands/helper';
import { MODERN_WEBVIEW_BASE_CSS } from '../common/htmlStyles';
import { disposePooledOwner, WebviewPool } from '../utils/WebviewPool';

interface ColumnInfo {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  is_generated: string;
  is_identity: string;
  character_maximum_length: number | null;
}

interface DataGenerationStrategy {
  strategy: string;
  udt: string;
}

/**
 * Mock Data Generator Panel (Phase 5.4)
 *
 * A wizard-style webview panel allowing users to generate and insert mock data
 * into a PostgreSQL table. Right-click a table → "Generate Mock Data".
 *
 * Step 1: Configure row count and per-column generation strategies.
 * Step 2: Preview 5 sample rows and confirm insert.
 */
export class MockDataPanel {
  public static readonly viewType = 'pgStudio.mockData';

  private static _panels = new Map<string, MockDataPanel>();
  public readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
  }

  public dispose(isRecycling = false): void {
    if (!isRecycling) {
      this._panel.dispose();
    }
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  public static async open(
    item: DatabaseTreeItem,
    context: vscode.ExtensionContext
  ): Promise<void> {
    let conn: any;
    try {
      conn = await resolveTreeItemConnection(item);
      if (!conn) { return; }

      const { client } = conn;
      const schema = item.schema || 'public';
      const table = item.tableName || (typeof item.label === 'string' ? item.label : (item.label as any)?.label ?? '');
      const db = item.databaseName || conn.metadata?.databaseName || 'postgres';
      const connName = conn.connection?.name || `${conn.connection?.host}:${conn.connection?.port}`;

      if (!table) {
        vscode.window.showErrorMessage('Could not determine table name.');
        return;
      }

      // Fetch column info
      const columns = await MockDataPanel._fetchColumns(client, schema, table);
      if (columns.length === 0) {
        vscode.window.showWarningMessage(`No columns found for ${schema}.${table}`);
        return;
      }

      const panelKey = `mockdata:${item.connectionId}:${db}:${schema}.${table}`;
      if (MockDataPanel._panels.has(panelKey)) {
        MockDataPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
        return;
      }

      const { panel, commit } = WebviewPool.getInstance().getOrCreate(
        MockDataPanel.viewType,
        panelKey,
        `Mock Data: ${schema}.${table}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
        {
          onDispose: () => {
            disposePooledOwner(MockDataPanel._panels, panel, false);
          },
          onRecycle: (recycled) => {
            disposePooledOwner(MockDataPanel._panels, recycled.panel, true);
          },
        }
      );

      const instance = new MockDataPanel(panel);
      MockDataPanel._panels.set(panelKey, instance);
      commit?.();

      // Fetch PK columns to exclude
      const pkColumns = await MockDataPanel._fetchPkColumns(client, schema, table);

      panel.webview.html = MockDataPanel._buildHtml(schema, table, connName, db, columns, pkColumns);

      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'generatePreview': {
            const rows = MockDataPanel._generateRows(5, msg.columns, msg.strategies);
            panel.webview.postMessage({ type: 'previewData', rows, columns: msg.columns });
            break;
          }
          case 'insertRows': {
            await MockDataPanel._insertRows(
              item,
              schema,
              table,
              msg.rowCount,
              msg.columns,
              msg.strategies,
              panel
            );
            break;
          }
        }
      }, null, instance._disposables);

    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'open Mock Data Generator');
    } finally {
      if (conn?.release) { conn.release(); }
    }
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  private static async _fetchColumns(client: any, schema: string, table: string): Promise<ColumnInfo[]> {
    const res = await client.query(
      `SELECT
         column_name,
         data_type,
         udt_name,
         is_nullable,
         column_default,
         is_generated,
         is_identity,
         character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table]
    );
    return res.rows as ColumnInfo[];
  }

  private static async _fetchPkColumns(client: any, schema: string, table: string): Promise<Set<string>> {
    const res = await client.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1
         AND tc.table_name = $2`,
      [schema, table]
    );
    return new Set<string>(res.rows.map((r: any) => r.column_name));
  }

  // ---------------------------------------------------------------------------
  // Row generation (runs in extension host)
  // ---------------------------------------------------------------------------

  private static _rand(max: number): number {
    return Math.floor(Math.random() * max);
  }

  private static readonly _firstNames = [
    'Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Henry',
    'Isabella', 'Jack', 'Karen', 'Liam', 'Mia', 'Noah', 'Olivia', 'Paul',
    'Quinn', 'Rachel', 'Sam', 'Tina', 'Uma', 'Victor', 'Wendy', 'Xander'
  ];

  private static readonly _lastNames = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
    'Davis', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Hernandez', 'Moore',
    'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Clark'
  ];

  private static readonly _statuses = ['active', 'inactive', 'pending', 'archived'];

  private static _generateValue(colName: string, udtName: string, strategy: string, index: number): any {
    const r = MockDataPanel._rand.bind(MockDataPanel);
    const name = colName.toLowerCase();

    if (strategy === 'null') { return null; }
    if (strategy === 'sequence') { return index + 1; }

    if (strategy === 'fixed') {
      // Return a sensible fixed value per type
      if (udtName.includes('int')) { return 1; }
      if (udtName.includes('float') || udtName.includes('numeric')) { return 1.0; }
      if (udtName === 'bool') { return true; }
      if (udtName === 'uuid') { return '00000000-0000-0000-0000-000000000000'; }
      return 'fixed_value';
    }

    // --- Semantic detection by column name ---
    if (/email/.test(name)) { return `user${r(10000)}@example.com`; }
    if (/first.?name|firstname/.test(name)) { return MockDataPanel._firstNames[r(MockDataPanel._firstNames.length)]; }
    if (/last.?name|lastname|surname/.test(name)) { return MockDataPanel._lastNames[r(MockDataPanel._lastNames.length)]; }
    if (/(^name$|full.?name)/.test(name)) {
      return `${MockDataPanel._firstNames[r(MockDataPanel._firstNames.length)]} ${MockDataPanel._lastNames[r(MockDataPanel._lastNames.length)]}`;
    }
    if (/phone|telephone|mobile/.test(name)) { return `+1-555-${r(9000) + 1000}`; }
    if (/^uuid$/.test(name)) {
      // Generate UUID-like value without crypto
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const v = r(16);
        return (c === 'x' ? v : (v & 0x3 | 0x8)).toString(16);
      });
    }
    if (/(^age$)/.test(name)) { return r(65) + 18; }
    if (/price|amount|cost|salary/.test(name)) { return parseFloat((r(10000) / 100).toFixed(2)); }
    if (/quantity|qty|(^count$)/.test(name)) { return r(100) + 1; }
    if (/created.?at|updated.?at|timestamp/.test(name)) {
      return new Date(Date.now() - r(365 * 24 * 3600 * 1000)).toISOString();
    }
    if (/(^date$)|birth.?date|dob/.test(name)) {
      return new Date(Date.now() - r(50 * 365 * 24 * 3600 * 1000)).toISOString().slice(0, 10);
    }
    if (/description|notes|comment|body/.test(name)) { return `Sample text ${r(1000)}`; }
    if (/title|label/.test(name)) { return `Item ${r(1000)}`; }
    if (/(^status$)/.test(name)) { return MockDataPanel._statuses[r(4)]; }
    if (/url|website|link/.test(name)) { return `https://example.com/item-${r(1000)}`; }
    if (/^(is_|has_|can_|flag)/.test(name)) { return r(2) === 1; }

    // --- Type-based fallback ---
    if (/int2|int4|int8|integer|bigint|smallint/.test(udtName)) { return r(10000); }
    if (/float4|float8|numeric|decimal|real|double/.test(udtName)) {
      return parseFloat((r(10000) / 100).toFixed(2));
    }
    if (/bool/.test(udtName)) { return r(2) === 1; }
    if (/uuid/.test(udtName)) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const v = r(16);
        return (c === 'x' ? v : (v & 0x3 | 0x8)).toString(16);
      });
    }
    if (/timestamp/.test(udtName)) {
      return new Date(Date.now() - r(365 * 24 * 3600 * 1000)).toISOString();
    }
    if (/^date$/.test(udtName)) {
      return new Date(Date.now() - r(5 * 365 * 24 * 3600 * 1000)).toISOString().slice(0, 10);
    }
    if (/jsonb|json/.test(udtName)) { return JSON.stringify({ key: `value${r(1000)}` }); }
    // text, varchar, char, etc.
    return `Sample text ${r(1000)}`;
  }

  private static _generateRows(
    count: number,
    columns: string[],
    strategies: Record<string, DataGenerationStrategy>
  ): any[][] {
    const rows: any[][] = [];
    for (let i = 0; i < count; i++) {
      const row = columns.map(col => {
        const strategy = strategies[col]?.strategy || 'auto';
        const udt = strategies[col]?.udt || 'text';
        return MockDataPanel._generateValue(col, udt, strategy, i);
      });
      rows.push(row);
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Insert rows
  // ---------------------------------------------------------------------------

  private static async _insertRows(
    item: DatabaseTreeItem,
    schema: string,
    table: string,
    rowCount: number,
    columns: string[],
    strategies: Record<string, DataGenerationStrategy>,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    let conn: any;
    try {
      conn = await resolveTreeItemConnection(item);
      if (!conn) { return; }

      const { client } = conn;

      const BATCH_SIZE = 100;
      const totalBatches = Math.ceil(rowCount / BATCH_SIZE);
      let inserted = 0;

      await client.query('BEGIN');

      try {
        for (let batch = 0; batch < totalBatches; batch++) {
          const batchCount = Math.min(BATCH_SIZE, rowCount - inserted);
          const rows = MockDataPanel._generateRows(batchCount, columns, strategies);

          const colList = columns.map(c => `"${c}"`).join(', ');
          // Build multi-row parameterized INSERT
          const valuePlaceholders: string[] = [];
          const flatValues: any[] = [];
          let paramIndex = 1;

          for (const row of rows) {
            const rowPlaceholders = row.map(() => `$${paramIndex++}`).join(', ');
            valuePlaceholders.push(`(${rowPlaceholders})`);
            flatValues.push(...row);
          }

          const sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES ${valuePlaceholders.join(', ')}`;
          await client.query(sql, flatValues);

          inserted += batchCount;
          const progress = Math.round((inserted / rowCount) * 100);
          panel.webview.postMessage({ type: 'insertProgress', inserted, total: rowCount, progress });
        }

        await client.query('COMMIT');
        panel.webview.postMessage({ type: 'insertComplete', inserted });

      } catch (err: any) {
        await client.query('ROLLBACK');
        throw err;
      }

    } catch (err: any) {
      panel.webview.postMessage({ type: 'insertError', message: err.message || String(err) });
    } finally {
      if (conn?.release) { conn.release(); }
    }
  }

  // ---------------------------------------------------------------------------
  // HTML builder
  // ---------------------------------------------------------------------------

  private static _buildHtml(
    schema: string,
    table: string,
    connName: string,
    db: string,
    columns: ColumnInfo[],
    pkColumns: Set<string>
  ): string {
    // Filter out PK, generated, and identity columns
    const editableColumns = columns.filter(col => {
      if (pkColumns.has(col.column_name)) { return false; }
      if (col.is_generated === 'ALWAYS') { return false; }
      if (col.is_identity === 'YES') { return false; }
      if (col.column_default && /nextval\(/.test(col.column_default)) { return false; }
      return true;
    });

    // Build strategies JSON for each column
    const strategiesJson = JSON.stringify(
      Object.fromEntries(editableColumns.map(col => [col.column_name, {
        strategy: 'auto',
        udt: col.udt_name
      }]))
    );

    const columnRows = editableColumns.map(col => {
      const colName = col.column_name;
      const colType = col.data_type;
      const udtName = col.udt_name;
      // Compute preview for auto strategy
      const preview = MockDataPanel._generateValue(colName, udtName, 'auto', 0);
      const previewStr = preview === null ? 'NULL' : String(preview).slice(0, 40);

      return `
        <tr data-col="${colName}" data-udt="${udtName}">
          <td class="col-name">${colName}</td>
          <td class="col-type">${colType}</td>
          <td>
            <select class="strategy-select" data-col="${colName}"
              onchange="updateStrategy('${colName}', this.value)">
              <option value="auto" selected>Auto-detect</option>
              <option value="random">Random</option>
              <option value="sequence">Sequence</option>
              <option value="null">NULL</option>
              <option value="fixed">Fixed</option>
            </select>
          </td>
          <td class="preview-cell" id="preview-${colName}">${escapeHtml(previewStr)}</td>
        </tr>`;
    }).join('\n');

    // Build preview table header
    const previewHeaders = editableColumns.map(col =>
      `<th>${col.column_name}</th>`
    ).join('\n');

    const editableColsJson = JSON.stringify(editableColumns.map(c => c.column_name));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mock Data Generator</title>
  <style>
    ${MODERN_WEBVIEW_BASE_CSS}
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
    }

    h2 {
      margin: 0 0 4px 0;
      font-size: 1.2em;
      font-weight: 600;
    }

    .subtitle {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 16px;
      font-size: 0.9em;
    }

    /* Wizard steps */
    .step { display: none; }
    .step.active { display: block; }

    /* Step indicator */
    .step-indicator {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
    }
    .step-dot {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 0.85em;
      border: 2px solid transparent;
    }
    .step-dot.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-focusBorder);
    }
    .step-dot.done {
      background: var(--vscode-charts-green, #4caf50);
      color: #fff;
    }
    .step-label {
      line-height: 28px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .step-sep {
      line-height: 28px;
      color: var(--vscode-descriptionForeground);
    }

    /* Row count */
    .row-count-section {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }
    .row-count-section label {
      font-weight: 600;
      white-space: nowrap;
    }
    .row-count-section input[type=number] {
      width: 100px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-size: var(--vscode-font-size);
    }

    /* Column config table */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    th {
      background: var(--vscode-editorGroupHeader-tabsBackground);
      color: var(--vscode-foreground);
      padding: 6px 8px;
      text-align: left;
      font-weight: 600;
      font-size: 0.85em;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      vertical-align: middle;
      font-size: 0.9em;
    }
    tr:hover td { background: var(--vscode-list-hoverBackground); }

    .col-name { font-weight: 600; }
    .col-type { color: var(--vscode-descriptionForeground); font-family: monospace; }
    .preview-cell { color: var(--vscode-descriptionForeground); font-family: monospace; font-size: 0.85em; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    select.strategy-select {
      padding: 3px 6px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 3px;
      font-size: var(--vscode-font-size);
      cursor: pointer;
    }

    /* Preview table (step 2) */
    .preview-table-wrap {
      overflow-x: auto;
      margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .preview-table-wrap table { margin: 0; }
    .preview-table-wrap td { font-family: monospace; font-size: 0.82em; white-space: nowrap; }

    /* Buttons */
    .btn {
      padding: 6px 16px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }

    .btn-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 12px;
    }

    /* Progress */
    .progress-wrap {
      display: none;
      margin: 12px 0;
    }
    .progress-bar-bg {
      width: 100%;
      height: 8px;
      background: var(--vscode-progressBar-background, #333);
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: var(--vscode-button-background);
      border-radius: 4px;
      transition: width 0.2s ease;
      width: 0%;
    }
    .progress-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    /* Success / error banners */
    .banner {
      display: none;
      padding: 10px 14px;
      border-radius: 4px;
      margin-bottom: 12px;
      font-size: 0.9em;
    }
    .banner.success {
      background: rgba(78, 201, 176, 0.15);
      border-left: 3px solid var(--vscode-charts-green, #4ec9b0);
      color: var(--vscode-charts-green, #4ec9b0);
    }
    .banner.error {
      background: rgba(244, 67, 54, 0.1);
      border-left: 3px solid var(--vscode-charts-red, #f44336);
      color: var(--vscode-errorForeground, #f44336);
    }
    .banner.show { display: block; }

    .no-columns {
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
    }
  </style>
</head>
<body>
  <section class="pg-panel">
    <header class="pg-panel-header">
      <div>
        <h2 class="pg-panel-title">Mock Data Generator</h2>
        <div class="pg-panel-subtitle">${escapeHtml(connName)} / ${escapeHtml(db)} — <strong>${escapeHtml(schema)}.${escapeHtml(table)}</strong></div>
      </div>
    </header>
    <div class="pg-panel-body">

  <div class="step-indicator">
    <div class="step-dot active" id="dot-1">1</div>
    <div class="step-label">Configure</div>
    <div class="step-sep">›</div>
    <div class="step-dot" id="dot-2">2</div>
    <div class="step-label">Preview &amp; Insert</div>
  </div>

  <!-- ===================== STEP 1 ===================== -->
  <div class="step active" id="step-1">
    <div class="row-count-section">
      <label for="rowCount">Number of rows:</label>
      <input type="number" id="rowCount" value="100" min="1" max="10000" />
      <span style="color:var(--vscode-descriptionForeground);font-size:0.85em;">(max 10,000)</span>
    </div>

    ${editableColumns.length === 0
      ? `<div class="no-columns">No editable columns found (all columns are primary keys, identity, or generated).</div>`
      : `<table>
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Strategy</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody id="column-config-body">
            ${columnRows}
          </tbody>
        </table>`
    }

    <div class="btn-row">
      <button class="btn btn-primary" onclick="goToStep2()" ${editableColumns.length === 0 ? 'disabled' : ''}>
        Next: Preview →
      </button>
    </div>
  </div>

  <!-- ===================== STEP 2 ===================== -->
  <div class="step" id="step-2">
    <h3 style="margin:0 0 8px 0;font-size:1em;">Preview (5 sample rows)</h3>

    <div class="preview-table-wrap">
      <table id="preview-table">
        <thead>
          <tr>
            ${previewHeaders}
          </tr>
        </thead>
        <tbody id="preview-body">
          <tr><td colspan="${editableColumns.length}" style="text-align:center;color:var(--vscode-descriptionForeground);">Loading preview…</td></tr>
        </tbody>
      </table>
    </div>

    <div class="banner" id="success-banner"></div>
    <div class="banner error" id="error-banner"></div>

    <div class="progress-wrap" id="progress-wrap">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
      <div class="progress-label" id="progress-label">Inserting rows…</div>
    </div>

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goToStep1()" id="back-btn">← Back</button>
      <button class="btn btn-primary" onclick="doInsert()" id="insert-btn">
        Insert <span id="insert-count">100</span> rows
      </button>
      <button class="btn btn-secondary" onclick="refreshPreview()" id="refresh-preview-btn">
        🔄 Refresh Preview
      </button>
    </div>
  </div>
    </div>
  </section>

  <script>
    const vscode = acquireVsCodeApi();

    // Column metadata
    const editableColumns = ${editableColsJson};
    const allStrategies = ${strategiesJson};

    function escapeHtml(str) {
      if (str === null || str === undefined) return '<em>NULL</em>';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function getRowCount() {
      const val = parseInt(document.getElementById('rowCount').value, 10);
      return Math.max(1, Math.min(10000, isNaN(val) ? 100 : val));
    }

    function getStrategies() {
      const result = {};
      editableColumns.forEach(col => {
        const sel = document.querySelector(\`select[data-col="\${col}"]\`);
        const udt = document.querySelector(\`tr[data-col="\${col}"]\`)?.dataset.udt || 'text';
        result[col] = { strategy: sel ? sel.value : 'auto', udt };
      });
      return result;
    }

    function updateStrategy(col, strategy) {
      allStrategies[col].strategy = strategy;
      // Update preview cell with a placeholder hint
      const cell = document.getElementById(\`preview-\${col}\`);
      if (cell) {
        const hints = {
          null: 'NULL',
          sequence: '1, 2, 3…',
          fixed: 'fixed_value',
          random: '(random)',
          auto: '(auto-detect)'
        };
        cell.textContent = hints[strategy] || '(auto)';
      }
    }

    function goToStep2() {
      document.getElementById('step-1').classList.remove('active');
      document.getElementById('step-2').classList.add('active');
      document.getElementById('dot-1').className = 'step-dot done';
      document.getElementById('dot-2').className = 'step-dot active';
      document.getElementById('insert-count').textContent = getRowCount();
      refreshPreview();
    }

    function goToStep1() {
      document.getElementById('step-2').classList.remove('active');
      document.getElementById('step-1').classList.add('active');
      document.getElementById('dot-1').className = 'step-dot active';
      document.getElementById('dot-2').className = 'step-dot';
      hideBanners();
    }

    function refreshPreview() {
      const strategies = getStrategies();
      vscode.postMessage({ type: 'generatePreview', columns: editableColumns, strategies });
    }

    function hideBanners() {
      document.getElementById('success-banner').className = 'banner';
      document.getElementById('error-banner').className = 'banner error';
    }

    function doInsert() {
      hideBanners();
      const rowCount = getRowCount();
      const strategies = getStrategies();

      // Show progress
      document.getElementById('progress-wrap').style.display = 'block';
      document.getElementById('progress-fill').style.width = '0%';
      document.getElementById('progress-label').textContent = \`Inserting 0 / \${rowCount} rows…\`;
      document.getElementById('insert-btn').disabled = true;
      document.getElementById('back-btn').disabled = true;
      document.getElementById('refresh-preview-btn').disabled = true;

      vscode.postMessage({
        type: 'insertRows',
        rowCount,
        columns: editableColumns,
        strategies
      });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'previewData': {
          const tbody = document.getElementById('preview-body');
          if (!tbody) break;
          const rows = msg.rows;
          const cols = msg.columns;
          tbody.innerHTML = rows.map(row =>
            '<tr>' + row.map(val =>
              \`<td>\${escapeHtml(val)}</td>\`
            ).join('') + '</tr>'
          ).join('');
          break;
        }
        case 'insertProgress': {
          const pct = msg.progress;
          document.getElementById('progress-fill').style.width = pct + '%';
          document.getElementById('progress-label').textContent =
            \`Inserting \${msg.inserted} / \${msg.total} rows (\${pct}%)…\`;
          break;
        }
        case 'insertComplete': {
          document.getElementById('progress-wrap').style.display = 'none';
          document.getElementById('insert-btn').disabled = false;
          document.getElementById('back-btn').disabled = false;
          document.getElementById('refresh-preview-btn').disabled = false;

          const banner = document.getElementById('success-banner');
          banner.className = 'banner success show';
          banner.innerHTML = \`✅ Inserted \${msg.inserted} rows successfully!\`;
          break;
        }
        case 'insertError': {
          document.getElementById('progress-wrap').style.display = 'none';
          document.getElementById('insert-btn').disabled = false;
          document.getElementById('back-btn').disabled = false;
          document.getElementById('refresh-preview-btn').disabled = false;

          const errBanner = document.getElementById('error-banner');
          errBanner.className = 'banner error show';
          errBanner.textContent = '❌ Error: ' + msg.message;
          break;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

/** HTML-escape helper (used at template build time) */
function escapeHtml(str: string): string {
  if (!str) { return ''; }
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
