import * as vscode from 'vscode';
import * as fs from 'fs';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { ConnectionManager } from '../services/ConnectionManager';
import { TelemetryService } from '../services/TelemetryService';
import { SecretStorageService } from '../services/SecretStorageService';
import { ErrorHandlers } from '../commands/helper';
import { parseCsv, parseJson, parseData, formatFromExtension, type ParsedTable, type DataFormat } from './importParsers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportConfig {
  filePath: string;
  format: DataFormat;
  delimiter: string;
  quoteChar: string;
  escapeChar: string;
  hasHeader: boolean;
  nullValue: string;
  encoding: string;
  schema: string;
  table: string;
  columnMapping: ColumnMapping[];
  batchSize: number;
  onError: 'stop' | 'skip';
  useTransaction: boolean;
  maxErrors: number;
}

interface ColumnMapping {
  enabled: boolean;
  fileIndex: number;
  fileHeader: string;
  tableColumn: string;
  tableType: string;
}

interface TableColumn {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
}

interface ImportProgress {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  log: string[];
  done: boolean;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// ImportDataPanel
// ---------------------------------------------------------------------------

export class ImportDataPanel {
  public static readonly viewType = 'pgStudio.importData';

  private static _panels = new Map<string, ImportDataPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _client: any = null;
  private _cancelRequested = false;

  // Pre-resolved connection context
  private _connectionId: string;
  private _databaseName: string;
  private _host: string;
  private _port: number;
  private _username: string;
  private _password: string;

  // ---------------------------------------------------------------------------
  // Static open
  // ---------------------------------------------------------------------------

  public static async open(
    item: DatabaseTreeItem,
    context: vscode.ExtensionContext
  ): Promise<void> {
    try {
      // Resolve connection
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      if (connections.length === 0) {
        vscode.window.showErrorMessage('No connections configured.');
        return;
      }

      let connection: any;
      let databaseName = 'postgres';

      if (item?.connectionId) {
        connection = connections.find(c => c.id === item.connectionId);
        databaseName = item.databaseName || connection?.database || 'postgres';
      }
      if (!connection && connections.length === 1) {
        connection = connections[0];
        databaseName = item?.databaseName || connection.database || 'postgres';
      }
      if (!connection) {
        const pick = await vscode.window.showQuickPick(
          connections.map(c => ({ label: c.name || `${c.host}:${c.port}`, description: c.database, id: c.id })),
          { placeHolder: 'Select connection' }
        );
        if (!pick) { return; }
        connection = connections.find(c => c.id === pick.id);
        databaseName = connection?.database || 'postgres';
      }

      const password = await SecretStorageService.getInstance().getPassword(connection.id);
      if (!password) {
        vscode.window.showErrorMessage('Password not found. Please reconnect.');
        return;
      }

      const schema = item?.schema || 'public';
      const tableName = item?.tableName || '';
      const panelKey = `import:${connection.id}:${databaseName}:${schema}`;

      if (ImportDataPanel._panels.has(panelKey)) {
        ImportDataPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
        return;
      }

      const title = tableName
        ? `Import → ${schema}.${tableName}`
        : `Import Data — ${databaseName}`;

      const panel = vscode.window.createWebviewPanel(
        ImportDataPanel.viewType,
        title,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      const importPanel = new ImportDataPanel(
        panel,
        connection.id,
        databaseName,
        connection.host,
        connection.port,
        connection.username,
        password
      );

      ImportDataPanel._panels.set(panelKey, importPanel);
      panel.onDidDispose(() => ImportDataPanel._panels.delete(panelKey));

      // Build initial client for schema/table queries
      importPanel._client = await ConnectionManager.getInstance().getPooledClient({
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        database: databaseName,
        name: connection.name,
      });

      panel.webview.html = importPanel._buildHtml(schema, tableName);
      importPanel._registerMessageHandlers(schema, tableName);

    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'open import tool');
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    connectionId: string,
    databaseName: string,
    host: string,
    port: number,
    username: string,
    password: string
  ) {
    this._panel = panel;
    this._connectionId = connectionId;
    this._databaseName = databaseName;
    this._host = host;
    this._port = port;
    this._username = username;
    this._password = password;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    TelemetryService.getInstance().trackDesignerOpened('import');
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  private _registerMessageHandlers(defaultSchema: string, defaultTable: string): void {
    this._panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {

        case 'ready':
          // Send initial schemas list
          await this._sendSchemas();
          // If pre-filled from tree item, send columns immediately
          if (defaultTable) {
            await this._sendColumns(defaultSchema, defaultTable);
          }
          break;

        case 'pickFile':
          await this._handlePickFile();
          break;

        case 'getSchemas':
          await this._sendSchemas();
          break;

        case 'getTables':
          await this._sendTables(msg.schema);
          break;

        case 'getColumns':
          await this._sendColumns(msg.schema, msg.table);
          break;

        case 'import':
          await this._handleImport(msg.config as ImportConfig);
          break;

        case 'cancel':
          this._cancelRequested = true;
          break;
      }
    }, null, this._disposables);
  }

  private async _sendSchemas(): Promise<void> {
    try {
      const result = await this._client.query(`
        SELECT nspname AS schema_name
        FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND nspname NOT LIKE 'pg_%'
        ORDER BY nspname
      `);
      this._post({ type: 'schemas', schemas: result.rows.map((r: any) => r.schema_name) });
    } catch { /* ignore */ }
  }

  private async _sendTables(schema: string): Promise<void> {
    try {
      const result = await this._client.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename
      `, [schema]);
      this._post({ type: 'tables', tables: result.rows.map((r: any) => r.tablename) });
    } catch { /* ignore */ }
  }

  private async _sendColumns(schema: string, table: string): Promise<void> {
    try {
      const result = await this._client.query(`
        SELECT
          column_name AS name,
          udt_name AS type,
          is_nullable = 'NO' AS not_null,
          column_default IS NOT NULL AS has_default
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, table]);
      const columns: TableColumn[] = result.rows.map((r: any) => ({
        name: r.name,
        type: r.type,
        notNull: r.not_null,
        hasDefault: r.has_default,
      }));
      this._post({ type: 'columns', columns });
    } catch { /* ignore */ }
  }

  private async _handlePickFile(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      title: 'Select data file to import',
      filters: {
        'Data files': ['csv', 'tsv', 'txt', 'json', 'ndjson', 'jsonl'],
        'Delimited text': ['csv', 'tsv', 'txt'],
        'JSON': ['json', 'ndjson', 'jsonl'],
        'All files': ['*'],
      },
    });
    if (!files || files.length === 0) { return; }

    const filePath = files[0].fsPath;
    try {
      const stat = fs.statSync(filePath);
      const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const format = formatFromExtension(ext);
      const guessedDelimiter = ext === 'tsv' ? '\t' : ',';

      // Read just enough for preview (first 64 KB)
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.allocUnsafe(65536);
      const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      const sample = buf.slice(0, bytesRead).toString('utf8');
      const truncated = stat.size > 65536;

      // Parse sample to count rows and get headers. A JSON array cannot be parsed
      // when truncated mid-document, so fall back to reading the whole file (capped).
      let parsed: ParsedTable;
      if (format === 'json') {
        if (truncated) {
          if (stat.size > 50 * 1024 * 1024) {
            throw new Error('JSON file too large to preview (> 50 MB). Import will still process the full file.');
          }
          parsed = parseJson(fs.readFileSync(filePath).toString('utf8'));
        } else {
          parsed = parseJson(sample);
        }
      } else {
        parsed = parseData(sample, {
          format,
          delimiter: guessedDelimiter,
          quoteChar: '"',
          escapeChar: '"',
          hasHeader: true,
          nullValue: '',
          allowPartialLast: truncated,
        });
      }
      const { headers, rows } = parsed;
      const previewRows = rows.slice(0, 15);

      this._post({
        type: 'fileLoaded',
        filePath,
        filename: filePath.split(/[\\/]/).pop(),
        sizeMb,
        format,
        totalLines: truncated ? '> 15 (file too large to count in preview)' : rows.length,
        headers,
        previewRows,
        guessedDelimiter,
      });
    } catch (err: any) {
      this._post({ type: 'error', message: `Cannot read file: ${err.message}` });
    }
  }

  private async _handleImport(config: ImportConfig): Promise<void> {
    this._cancelRequested = false;
    const startTime = Date.now();

    let importClient: any;
    const progress: ImportProgress = { total: 0, imported: 0, skipped: 0, errors: 0, log: [], done: false };

    try {
      // Get a fresh client for the import (keeps schema query client alive)
      importClient = await ConnectionManager.getInstance().getPooledClient({
        id: this._connectionId,
        host: this._host,
        port: this._port,
        username: this._username,
        database: this._databaseName,
        name: 'import',
        password: this._password,
      } as any);

      // Read full file
      const rawContent = fs.readFileSync(config.filePath).toString('utf8');

      const { headers, rows } = parseData(rawContent, {
        format: config.format,
        delimiter: config.delimiter === '\\t' ? '\t' : config.delimiter,
        quoteChar: config.quoteChar || '"',
        escapeChar: config.escapeChar || '"',
        hasHeader: config.hasHeader,
        nullValue: config.nullValue,
      });

      // For JSON the full-file column set (and order) can differ from the preview
      // sample, so resolve each mapping by header name and fall back to its index.
      const headerIndex = new Map(headers.map((h, i) => [h, i]));
      const indexForMapping = (m: ColumnMapping): number =>
        headerIndex.has(m.fileHeader) ? (headerIndex.get(m.fileHeader) as number) : m.fileIndex;

      progress.total = rows.length;
      this._post({ type: 'progress', ...progress });

      // Build enabled mappings
      const enabledMappings = config.columnMapping.filter(m => m.enabled);
      if (enabledMappings.length === 0) {
        this._post({ type: 'error', message: 'No columns selected for import.' });
        return;
      }

      const tableColumns = enabledMappings.map(m => `"${m.tableColumn}"`).join(', ');

      if (config.useTransaction) {
        await importClient.query('BEGIN');
      }

      let batchStart = 0;
      while (batchStart < rows.length) {
        if (this._cancelRequested) {
          if (config.useTransaction) { await importClient.query('ROLLBACK'); }
          this._post({ type: 'cancelled', ...progress });
          return;
        }

        const batch = rows.slice(batchStart, batchStart + config.batchSize);
        batchStart += config.batchSize;

        for (const row of batch) {
          if (this._cancelRequested) { break; }
          try {
            const values = enabledMappings.map(m => row[indexForMapping(m)] ?? null);

            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `INSERT INTO "${config.schema}"."${config.table}" (${tableColumns}) VALUES (${placeholders})`;
            await importClient.query(sql, values);
            progress.imported++;
          } catch (err: any) {
            progress.errors++;
            const rowNum = progress.imported + progress.skipped + progress.errors;
            const msg = `Row ${rowNum}: ${err.message.split('\n')[0]}`;
            if (progress.log.length < 200) { progress.log.push(msg); }

            if (config.onError === 'stop' && progress.errors >= (config.maxErrors || 1)) {
              if (config.useTransaction) { await importClient.query('ROLLBACK'); }
              this._post({ type: 'progress', ...progress });
              this._post({ type: 'error', message: `Import stopped after ${progress.errors} error(s).` });
              return;
            }
            progress.skipped++;
          }
        }

        // Report progress after each batch
        this._post({ type: 'progress', ...progress });
      }

      if (config.useTransaction) {
        await importClient.query('COMMIT');
      }

      progress.done = true;
      progress.durationMs = Date.now() - startTime;
      this._post({ type: 'progress', ...progress });

    } catch (err: any) {
      try { if (config.useTransaction) { await importClient?.query('ROLLBACK'); } } catch { /* ignore */ }
      this._post({ type: 'error', message: err.message });
    } finally {
      try { importClient?.release(); } catch { /* ignore */ }
    }
  }

  private _post(msg: object): void {
    try { this._panel.webview.postMessage(msg); } catch { /* panel may be closed */ }
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private _buildHtml(defaultSchema: string, defaultTable: string): string {
    const defaultSchemaJson = JSON.stringify(defaultSchema);
    const defaultTableJson = JSON.stringify(defaultTable);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Import Data</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Toolbar ─────────────────────────────────────────────── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .toolbar-title { font-size: 14px; font-weight: 600; flex: 1; }
  .toolbar-sub { font-size: 11px; color: var(--vscode-descriptionForeground); }

  /* ── Tabs ────────────────────────────────────────────────── */
  .tabs {
    display: flex;
    gap: 0;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .tab {
    padding: 8px 18px;
    font-size: 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground);
    user-select: none;
    white-space: nowrap;
  }
  .tab:hover { color: var(--vscode-editor-foreground); background: var(--vscode-list-hoverBackground); }
  .tab.active { color: var(--vscode-editor-foreground); border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .tab.disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }

  /* ── Body ────────────────────────────────────────────────── */
  .body { flex: 1; overflow-y: auto; padding: 16px; }

  /* ── Sections ────────────────────────────────────────────── */
  .section { margin-bottom: 20px; }
  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
  }

  /* ── File drop zone ──────────────────────────────────────── */
  .file-zone {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 5px;
    background: var(--vscode-input-background);
    cursor: pointer;
    transition: border-color .15s;
  }
  .file-zone:hover { border-color: var(--vscode-focusBorder); }
  .file-zone .file-icon { font-size: 24px; }
  .file-zone .file-text { flex: 1; }
  .file-zone .file-name { font-weight: 600; }
  .file-zone .file-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  /* ── Form grid ───────────────────────────────────────────── */
  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 10px;
  }
  .form-group label {
    display: block;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  .form-group input,
  .form-group select {
    width: 100%;
    padding: 5px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 3px;
    font-size: 12px;
    font-family: inherit;
  }
  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }
  .form-group.full { grid-column: 1 / -1; }
  .checkbox-group {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 0;
    font-size: 12px;
  }
  .checkbox-group input[type=checkbox] { width: 14px; height: 14px; cursor: pointer; }

  /* ── Preview table ───────────────────────────────────────── */
  .preview-wrap {
    overflow-x: auto;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
  }
  .preview-table {
    border-collapse: collapse;
    font-size: 11px;
    width: 100%;
    min-width: max-content;
  }
  .preview-table th {
    position: sticky;
    top: 0;
    padding: 5px 10px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    text-align: left;
    white-space: nowrap;
    font-weight: 600;
    font-size: 11px;
  }
  .preview-table td {
    padding: 3px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12));
    white-space: nowrap;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-editor-foreground);
  }
  .preview-table td.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
  .preview-table tr:hover td { background: var(--vscode-list-hoverBackground); }

  /* ── Column mapping ──────────────────────────────────────── */
  .mapping-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .mapping-grid {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    overflow: hidden;
  }
  .mapping-row {
    display: grid;
    grid-template-columns: 32px 1fr 28px 1fr 80px;
    align-items: center;
    gap: 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .mapping-row:last-child { border-bottom: none; }
  .mapping-row.header-row {
    background: var(--vscode-sideBar-background);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
  }
  .mapping-row:not(.header-row):hover { background: var(--vscode-list-hoverBackground); }
  .mapping-cell {
    padding: 6px 8px;
    font-size: 12px;
    border-right: 1px solid var(--vscode-panel-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mapping-cell:last-child { border-right: none; }
  .mapping-cell.center { text-align: center; }
  .mapping-cell select {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--vscode-editor-foreground);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
  }
  .mapping-cell select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .arrow { color: var(--vscode-descriptionForeground); font-size: 13px; }
  .type-badge {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background, rgba(128,128,128,.15));
    border-radius: 10px;
    padding: 1px 6px;
    display: inline-block;
  }

  /* ── Progress view ───────────────────────────────────────── */
  .progress-view { padding: 0 4px; }
  .progress-bar-wrap {
    background: var(--vscode-progressBar-background, rgba(128,128,128,.2));
    border-radius: 4px;
    height: 6px;
    overflow: hidden;
    margin: 12px 0;
  }
  .progress-bar-fill {
    height: 100%;
    background: var(--vscode-button-background);
    border-radius: 4px;
    transition: width .3s ease;
  }
  .progress-stats {
    display: flex;
    gap: 24px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .stat-val { font-size: 22px; font-weight: 700; }
  .stat-val.success { color: #2ecc71; }
  .stat-val.warn { color: #f39c12; }
  .stat-val.danger { color: #e74c3c; }
  .log-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .log-box {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    max-height: 160px;
    overflow-y: auto;
    line-height: 1.6;
  }
  .log-line.err { color: #e74c3c; }
  .done-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: rgba(46,204,113,0.12);
    border: 1px solid rgba(46,204,113,0.3);
    border-radius: 5px;
    margin-bottom: 14px;
    font-weight: 600;
  }
  .error-banner {
    padding: 10px 14px;
    background: rgba(231,76,60,0.1);
    border: 1px solid rgba(231,76,60,0.3);
    border-radius: 5px;
    margin-bottom: 14px;
    color: #e74c3c;
  }

  /* ── Footer ──────────────────────────────────────────────── */
  .footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
  }
  .btn {
    padding: 6px 16px;
    border-radius: 3px;
    border: none;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { filter: brightness(1.12); }
  .btn-primary:disabled { opacity: .45; cursor: not-allowed; filter: none; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { filter: brightness(1.12); }
  .btn-danger { background: rgba(231,76,60,0.18); color: #e74c3c; border: 1px solid rgba(231,76,60,0.3); }
  .btn-danger:hover { background: rgba(231,76,60,0.28); }
  .lnk { background: none; border: none; color: var(--vscode-textLink-foreground); font-size: 12px; cursor: pointer; padding: 2px 0; }
  .lnk:hover { text-decoration: underline; }

  /* ── Utility ─────────────────────────────────────────────── */
  .hidden { display: none !important; }
  .placeholder-text { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; }
  .info-box {
    padding: 8px 12px;
    background: rgba(52,152,219,0.1);
    border-left: 3px solid #3498db;
    border-radius: 3px;
    font-size: 12px;
    color: var(--vscode-editor-foreground);
    margin-bottom: 10px;
  }
  .warn-box {
    padding: 8px 12px;
    background: rgba(243,156,18,0.1);
    border-left: 3px solid #f39c12;
    border-radius: 3px;
    font-size: 12px;
    margin-bottom: 10px;
  }
</style>
</head>
<body>

<!-- Toolbar -->
<div class="toolbar">
  <span style="font-size:18px">📥</span>
  <span class="toolbar-title">Import Data</span>
  <span class="toolbar-sub" id="toolbar-sub">Select a file to begin</span>
</div>

<!-- Tabs -->
<div class="tabs" id="tabs">
  <div class="tab active" id="tab-source" onclick="switchTab('source')">① Source File</div>
  <div class="tab" id="tab-target" onclick="switchTab('target')">② Target &amp; Columns</div>
  <div class="tab" id="tab-options" onclick="switchTab('options')">③ Options</div>
  <div class="tab hidden" id="tab-progress" onclick="switchTab('progress')">④ Progress</div>
</div>

<!-- Body -->
<div class="body" id="body">

  <!-- ═══════════════════════════════════════════════ TAB: SOURCE ══ -->
  <div id="pane-source">

    <div class="section">
      <div class="section-title">Source File</div>
      <div class="file-zone" id="file-zone" onclick="pickFile()">
        <span class="file-icon" id="file-icon">📂</span>
        <div class="file-text">
          <div class="file-name" id="file-name">No file selected — click to browse</div>
          <div class="file-meta" id="file-meta">Supported: CSV, TSV, TXT and any delimiter-separated text</div>
        </div>
        <button class="btn btn-secondary" onclick="event.stopPropagation(); pickFile()">Browse…</button>
      </div>
    </div>

    <div class="section" id="format-section">
      <div class="section-title">Format Options</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Format</label>
          <select id="fmt-format" onchange="onFormatChange()">
            <option value="csv">CSV (comma-separated)</option>
            <option value="tsv">TSV (tab-separated)</option>
            <option value="custom">Custom delimiter</option>
            <option value="json">JSON (array of objects)</option>
            <option value="ndjson">NDJSON (one object per line)</option>
          </select>
        </div>
        <div class="form-group" id="delim-group">
          <label>Delimiter</label>
          <input id="fmt-delimiter" type="text" value="," maxlength="5" style="width:80px">
        </div>
        <div class="form-group">
          <label>Quote character</label>
          <input id="fmt-quote" type="text" value='"' maxlength="1" style="width:60px">
        </div>
        <div class="form-group">
          <label>Escape character</label>
          <input id="fmt-escape" type="text" value='"' maxlength="1" style="width:60px">
        </div>
        <div class="form-group">
          <label>NULL value string</label>
          <input id="fmt-null" type="text" value="" placeholder='e.g. \\N or NULL' style="width:110px">
        </div>
        <div class="form-group">
          <label>Encoding</label>
          <select id="fmt-encoding">
            <option value="utf8">UTF-8</option>
            <option value="latin1">Latin-1</option>
            <option value="utf16le">UTF-16 LE</option>
          </select>
        </div>
        <div class="form-group full">
          <div class="checkbox-group">
            <input type="checkbox" id="fmt-header" checked onchange="onHeaderChange()">
            <label for="fmt-header">First row is a header (column names)</label>
          </div>
        </div>
      </div>
    </div>

    <div class="section" id="preview-section" style="display:none">
      <div class="section-title">Data Preview <span id="preview-label" style="font-weight:400;text-transform:none;font-size:11px"></span></div>
      <div class="preview-wrap">
        <table class="preview-table" id="preview-table"></table>
      </div>
    </div>

  </div><!-- /pane-source -->

  <!-- ═══════════════════════════════════════════════ TAB: TARGET ══ -->
  <div id="pane-target" class="hidden">

    <div class="section">
      <div class="section-title">Target Table</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Schema</label>
          <select id="tgt-schema" onchange="onSchemaChange()"></select>
        </div>
        <div class="form-group">
          <label>Table</label>
          <select id="tgt-table" onchange="onTableChange()"></select>
        </div>
      </div>
    </div>

    <div class="section" id="mapping-section">
      <div class="mapping-header">
        <span class="section-title" style="margin:0">Column Mapping</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="lnk" onclick="selectAllMappings(true)">Select all</button>
          <button class="lnk" onclick="selectAllMappings(false)">Deselect all</button>
          <button class="btn btn-secondary" style="padding:3px 10px;font-size:11px" onclick="autoMap()">⟳ Auto-map</button>
        </div>
      </div>

      <div id="mapping-placeholder" class="placeholder-text">
        Select a target table to see column mapping options.
      </div>

      <div id="mapping-grid-wrap" class="mapping-grid hidden">
        <!-- header row -->
        <div class="mapping-row header-row">
          <div class="mapping-cell center">✓</div>
          <div class="mapping-cell">File column</div>
          <div class="mapping-cell center"></div>
          <div class="mapping-cell">Table column</div>
          <div class="mapping-cell">Type</div>
        </div>
        <div id="mapping-rows"></div>
      </div>
    </div>

  </div><!-- /pane-target -->

  <!-- ═══════════════════════════════════════════════ TAB: OPTIONS ══ -->
  <div id="pane-options" class="hidden">
    <div class="section">
      <div class="section-title">Import Behaviour</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Batch size (rows per transaction)</label>
          <input id="opt-batch" type="number" value="500" min="1" max="10000">
        </div>
        <div class="form-group">
          <label>On row error</label>
          <select id="opt-error">
            <option value="skip">Skip row and continue</option>
            <option value="stop">Stop import</option>
          </select>
        </div>
        <div class="form-group">
          <label>Max errors before stopping</label>
          <input id="opt-maxerr" type="number" value="100" min="1" max="100000">
        </div>
        <div class="form-group full">
          <div class="checkbox-group">
            <input type="checkbox" id="opt-transaction" checked>
            <label for="opt-transaction">Wrap entire import in a single transaction (rollback on failure)</label>
          </div>
        </div>
      </div>
    </div>

    <div class="info-box">
      <strong>Tip:</strong> For large files, disable "single transaction" to commit each batch independently.
      Rows already inserted will remain even if a later batch fails.
    </div>
  </div><!-- /pane-options -->

  <!-- ═══════════════════════════════════════════════ TAB: PROGRESS ══ -->
  <div id="pane-progress" class="hidden">
    <div class="progress-view">
      <div id="done-banner" class="done-banner hidden">
        ✅ Import complete
      </div>
      <div id="error-banner" class="error-banner hidden"></div>

      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" id="prog-bar" style="width:0%"></div>
      </div>
      <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:14px" id="prog-label">
        Preparing…
      </div>

      <div class="progress-stats">
        <div class="stat-card">
          <span class="stat-label">Total rows</span>
          <span class="stat-val" id="stat-total">—</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Imported</span>
          <span class="stat-val success" id="stat-imported">0</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Skipped</span>
          <span class="stat-val warn" id="stat-skipped">0</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Errors</span>
          <span class="stat-val danger" id="stat-errors">0</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Duration</span>
          <span class="stat-val" id="stat-duration">—</span>
        </div>
      </div>

      <div id="log-wrap" class="hidden">
        <div class="log-title">Error log</div>
        <div class="log-box" id="log-box"></div>
      </div>
    </div>
  </div><!-- /pane-progress -->

</div><!-- /body -->

<!-- Footer -->
<div class="footer">
  <span id="footer-info" style="flex:1;font-size:11px;color:var(--vscode-descriptionForeground)"></span>
  <button class="btn btn-danger hidden" id="btn-cancel" onclick="cancelImport()">⬛ Cancel</button>
  <button class="btn btn-secondary" id="btn-back" onclick="onBack()" style="display:none">← Back</button>
  <button class="btn btn-primary" id="btn-import" disabled onclick="startImport()">
    ⬇ Import
  </button>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // ── State ─────────────────────────────────────────────────────────
  let filePath = null;
  let fileHeaders = [];
  let previewRows = [];
  let tableColumns = [];   // [{name, type, notNull, hasDefault}]
  let schemas = [];
  let tables = [];
  let defaultSchema = ${defaultSchemaJson};
  let defaultTable = ${defaultTableJson};
  let importing = false;
  let currentTab = 'source';

  // ── Init ──────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

  // ── Message handler ───────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'schemas':      onSchemas(msg.schemas); break;
      case 'tables':       onTables(msg.tables);   break;
      case 'columns':      onColumns(msg.columns); break;
      case 'fileLoaded':   onFileLoaded(msg);      break;
      case 'progress':     onProgress(msg);        break;
      case 'cancelled':    onCancelled(msg);        break;
      case 'error':        onServerError(msg.message); break;
    }
  });

  // ── Tab switching ─────────────────────────────────────────────────
  function switchTab(tab) {
    ['source','target','options','progress'].forEach(t => {
      document.getElementById('pane-' + t).classList.toggle('hidden', t !== tab);
      document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
    });
    currentTab = tab;
  }

  // ── File ──────────────────────────────────────────────────────────
  function pickFile() {
    vscode.postMessage({ type: 'pickFile' });
  }

  function onFileLoaded(msg) {
    filePath = msg.filePath;
    fileHeaders = msg.headers || [];
    previewRows = msg.previewRows || [];

    document.getElementById('file-name').textContent = msg.filename;
    document.getElementById('file-meta').textContent = msg.sizeMb + ' MB  ·  ~' + (msg.totalLines || previewRows.length) + '+ rows';
    document.getElementById('file-icon').textContent = '📄';
    document.getElementById('toolbar-sub').textContent = msg.filename;

    // Apply the format detected from the file extension.
    if (msg.format) {
      document.getElementById('fmt-format').value = msg.format;
    } else if (msg.guessedDelimiter === '\\t') {
      document.getElementById('fmt-format').value = 'tsv';
      document.getElementById('fmt-delimiter').value = '\\t';
    }
    onFormatChange();

    renderPreview();
    checkImportReady();

    // Refresh mapping if table already selected
    if (tableColumns.length > 0) { renderMapping(); }
  }

  function onFormatChange() {
    const fmt = document.getElementById('fmt-format').value;
    const delimGroup = document.getElementById('delim-group');
    const isJson = fmt === 'json' || fmt === 'ndjson';
    // Delimiter/quote/escape/header controls are meaningless for JSON inputs.
    ['fmt-quote', 'fmt-escape'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) { el.closest('.form-group').style.display = isJson ? 'none' : ''; }
    });
    if (fmt === 'csv') {
      document.getElementById('fmt-delimiter').value = ',';
      delimGroup.style.display = '';
    } else if (fmt === 'tsv') {
      document.getElementById('fmt-delimiter').value = '\\t';
      delimGroup.style.display = 'none';
    } else if (isJson) {
      delimGroup.style.display = 'none';
    } else {
      delimGroup.style.display = '';
    }
  }

  function onHeaderChange() {
    // Re-render preview with updated header setting
    if (previewRows.length > 0) { renderPreview(); }
  }

  // ── Preview ───────────────────────────────────────────────────────
  function renderPreview() {
    const sec = document.getElementById('preview-section');
    const tbl = document.getElementById('preview-table');
    const hasHeader = document.getElementById('fmt-header').checked;

    sec.style.display = '';
    const rows = previewRows.slice(0, 15);
    const displayHeaders = hasHeader ? fileHeaders : fileHeaders.map((_, i) => 'Column ' + (i+1));
    const label = document.getElementById('preview-label');
    label.textContent = '(first ' + rows.length + ' rows)';

    let html = '<thead><tr>' + displayHeaders.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>';
    html += '<tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (const cell of row) {
        if (cell === null || cell === undefined) {
          html += '<td class="null-val">NULL</td>';
        } else {
          html += '<td title="' + esc(String(cell)) + '">' + esc(String(cell)) + '</td>';
        }
      }
      html += '</tr>';
    }
    html += '</tbody>';
    tbl.innerHTML = html;
  }

  // ── Schemas / Tables ──────────────────────────────────────────────
  function onSchemas(list) {
    schemas = list;
    const sel = document.getElementById('tgt-schema');
    sel.innerHTML = list.map(s => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
    // Use default schema from tree item
    if (defaultSchema && list.includes(defaultSchema)) {
      sel.value = defaultSchema;
    }
    onSchemaChange();
  }

  function onSchemaChange() {
    const schema = document.getElementById('tgt-schema').value;
    vscode.postMessage({ type: 'getTables', schema });
  }

  function onTables(list) {
    tables = list;
    const sel = document.getElementById('tgt-table');
    sel.innerHTML = '<option value="">— select table —</option>' +
      list.map(t => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
    if (defaultTable && list.includes(defaultTable)) {
      sel.value = defaultTable;
      onTableChange();
    }
  }

  function onTableChange() {
    const schema = document.getElementById('tgt-schema').value;
    const table = document.getElementById('tgt-table').value;
    tableColumns = [];
    if (!table) {
      document.getElementById('mapping-placeholder').classList.remove('hidden');
      document.getElementById('mapping-grid-wrap').classList.add('hidden');
      checkImportReady();
      return;
    }
    vscode.postMessage({ type: 'getColumns', schema, table });
  }

  function onColumns(cols) {
    tableColumns = cols;
    renderMapping();
    checkImportReady();
  }

  // ── Column mapping ────────────────────────────────────────────────
  function renderMapping() {
    const placeholder = document.getElementById('mapping-placeholder');
    const gridWrap = document.getElementById('mapping-grid-wrap');

    if (!tableColumns.length || !fileHeaders.length) {
      placeholder.classList.remove('hidden');
      gridWrap.classList.add('hidden');
      return;
    }

    placeholder.classList.add('hidden');
    gridWrap.classList.remove('hidden');

    const container = document.getElementById('mapping-rows');
    container.innerHTML = fileHeaders.map((fh, fi) => {
      const matched = autoMatchColumn(fh);
      const colOpts = '<option value="">— skip —</option>' +
        tableColumns.map(c => '<option value="' + esc(c.name) + '"' +
          (c.name === matched ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
      const type = matched ? (tableColumns.find(c => c.name === matched)?.type || '') : '';
      return '<div class="mapping-row" id="mrow-' + fi + '">' +
        '<div class="mapping-cell center"><input type="checkbox" id="mc-' + fi + '"' + (matched ? ' checked' : '') +
        ' onchange="onMappingCheck(' + fi + ')" style="cursor:pointer"></div>' +
        '<div class="mapping-cell" title="' + esc(fh) + '">' + esc(fh) + '</div>' +
        '<div class="mapping-cell center arrow">→</div>' +
        '<div class="mapping-cell"><select id="ms-' + fi + '" onchange="onMappingSelect(' + fi + ')">' + colOpts + '</select></div>' +
        '<div class="mapping-cell"><span class="type-badge" id="mt-' + fi + '">' + esc(type) + '</span></div>' +
        '</div>';
    }).join('');
  }

  function autoMatchColumn(fileHeader) {
    const norm = s => s.toLowerCase().replace(/[\s_-]/g, '');
    const col = tableColumns.find(c => norm(c.name) === norm(fileHeader));
    return col ? col.name : null;
  }

  function autoMap() {
    for (let i = 0; i < fileHeaders.length; i++) {
      const matched = autoMatchColumn(fileHeaders[i]);
      const sel = document.getElementById('ms-' + i);
      const chk = document.getElementById('mc-' + i);
      if (sel && matched) {
        sel.value = matched;
        if (chk) chk.checked = true;
        updateTypeLabel(i);
      }
    }
  }

  function onMappingCheck(fi) {
    const chk = document.getElementById('mc-' + fi);
    const sel = document.getElementById('ms-' + fi);
    if (sel && !chk.checked) { sel.value = ''; }
  }

  function onMappingSelect(fi) {
    const sel = document.getElementById('ms-' + fi);
    const chk = document.getElementById('mc-' + fi);
    if (chk) chk.checked = !!sel.value;
    updateTypeLabel(fi);
  }

  function updateTypeLabel(fi) {
    const sel = document.getElementById('ms-' + fi);
    const badge = document.getElementById('mt-' + fi);
    if (!sel || !badge) return;
    const col = tableColumns.find(c => c.name === sel.value);
    badge.textContent = col ? col.type : '';
  }

  function selectAllMappings(state) {
    for (let i = 0; i < fileHeaders.length; i++) {
      const chk = document.getElementById('mc-' + i);
      if (chk) chk.checked = state;
    }
  }

  function getColumnMappings() {
    return fileHeaders.map((fh, fi) => {
      const chk = document.getElementById('mc-' + fi);
      const sel = document.getElementById('ms-' + fi);
      const tableColumn = sel ? sel.value : '';
      const col = tableColumns.find(c => c.name === tableColumn);
      return {
        enabled: chk ? chk.checked && !!tableColumn : false,
        fileIndex: fi,
        fileHeader: fh,
        tableColumn,
        tableType: col ? col.type : '',
      };
    });
  }

  // ── Import button readiness ───────────────────────────────────────
  function checkImportReady() {
    const btn = document.getElementById('btn-import');
    const ready = filePath && tableColumns.length > 0 &&
      document.getElementById('tgt-table').value !== '';
    btn.disabled = !ready;
    document.getElementById('footer-info').textContent = ready
      ? 'Ready to import — review column mapping before proceeding'
      : filePath ? 'Select a target table to enable import' : 'Select a source file to begin';
  }

  // ── Import ────────────────────────────────────────────────────────
  function startImport() {
    if (!filePath) return;
    const table = document.getElementById('tgt-table').value;
    if (!table) { alert('Please select a target table.'); return; }

    const mappings = getColumnMappings();
    const enabled = mappings.filter(m => m.enabled);
    if (enabled.length === 0) {
      alert('No columns mapped. Please enable at least one column mapping.');
      switchTab('target');
      return;
    }

    importing = true;
    document.getElementById('btn-import').disabled = true;
    document.getElementById('btn-cancel').classList.remove('hidden');
    document.getElementById('tab-progress').classList.remove('hidden');
    switchTab('progress');
    resetProgress();

    const config = {
      filePath,
      format: document.getElementById('fmt-format').value,
      delimiter: document.getElementById('fmt-delimiter').value,
      quoteChar: document.getElementById('fmt-quote').value,
      escapeChar: document.getElementById('fmt-escape').value,
      hasHeader: document.getElementById('fmt-header').checked,
      nullValue: document.getElementById('fmt-null').value,
      encoding: document.getElementById('fmt-encoding').value,
      schema: document.getElementById('tgt-schema').value,
      table,
      columnMapping: mappings,
      batchSize: parseInt(document.getElementById('opt-batch').value) || 500,
      onError: document.getElementById('opt-error').value,
      useTransaction: document.getElementById('opt-transaction').checked,
      maxErrors: parseInt(document.getElementById('opt-maxerr').value) || 100,
    };

    vscode.postMessage({ type: 'import', config });
  }

  function cancelImport() {
    vscode.postMessage({ type: 'cancel' });
    document.getElementById('btn-cancel').disabled = true;
    document.getElementById('btn-cancel').textContent = 'Cancelling…';
  }

  function resetProgress() {
    document.getElementById('done-banner').classList.add('hidden');
    document.getElementById('error-banner').classList.add('hidden');
    document.getElementById('log-wrap').classList.add('hidden');
    document.getElementById('log-box').innerHTML = '';
    document.getElementById('prog-bar').style.width = '0%';
    document.getElementById('prog-label').textContent = 'Starting import…';
    document.getElementById('stat-total').textContent = '—';
    document.getElementById('stat-imported').textContent = '0';
    document.getElementById('stat-skipped').textContent = '0';
    document.getElementById('stat-errors').textContent = '0';
    document.getElementById('stat-duration').textContent = '—';
  }

  function onProgress(msg) {
    const pct = msg.total > 0 ? Math.round((msg.imported + msg.skipped) / msg.total * 100) : 0;
    document.getElementById('prog-bar').style.width = pct + '%';
    document.getElementById('stat-total').textContent = msg.total.toLocaleString();
    document.getElementById('stat-imported').textContent = msg.imported.toLocaleString();
    document.getElementById('stat-skipped').textContent = msg.skipped.toLocaleString();
    document.getElementById('stat-errors').textContent = msg.errors.toLocaleString();

    if (msg.done) {
      const secs = msg.durationMs ? (msg.durationMs / 1000).toFixed(1) + 's' : '—';
      document.getElementById('stat-duration').textContent = secs;
      document.getElementById('prog-bar').style.width = '100%';
      document.getElementById('prog-label').textContent = 'Import complete';
      document.getElementById('done-banner').classList.remove('hidden');
      document.getElementById('done-banner').textContent =
        '✅ Imported ' + msg.imported.toLocaleString() + ' rows in ' + secs;
      finishImport();
    } else {
      document.getElementById('prog-label').textContent =
        'Importing… ' + (msg.imported + msg.skipped).toLocaleString() + ' / ' + msg.total.toLocaleString() + ' rows (' + pct + '%)';
    }

    if (msg.log && msg.log.length > 0) {
      const logBox = document.getElementById('log-box');
      document.getElementById('log-wrap').classList.remove('hidden');
      msg.log.forEach(line => {
        const div = document.createElement('div');
        div.className = 'log-line err';
        div.textContent = line;
        logBox.appendChild(div);
      });
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function onCancelled(msg) {
    document.getElementById('prog-label').textContent = 'Import cancelled.';
    document.getElementById('prog-bar').style.background = '#f39c12';
    finishImport();
  }

  function onServerError(message) {
    document.getElementById('error-banner').textContent = '❌ ' + message;
    document.getElementById('error-banner').classList.remove('hidden');
    finishImport();
  }

  function finishImport() {
    importing = false;
    document.getElementById('btn-import').disabled = false;
    document.getElementById('btn-cancel').classList.add('hidden');
    document.getElementById('btn-cancel').disabled = false;
    document.getElementById('btn-cancel').textContent = '⬛ Cancel';
  }

  function onBack() {
    switchTab('source');
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
  }

  public dispose(): void {
    try { this._client?.release(); } catch { /* ignore */ }
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }
}
