import * as vscode from 'vscode';
import { IMessageHandler } from '../MessageHandler';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { WorkspaceStateService } from '../WorkspaceStateService';
import { PostgresMetadata } from '../../common/types';
import { DatabaseTreeItem } from '../../providers/DatabaseTreeProvider';
import { ConnectionManager } from '../ConnectionManager';
import { errorResponse, okResponse } from './messaging';
import { extensionContext } from '../../extension';
import { QueryAnalyzer } from '../../services/QueryAnalyzer';
import { debugWarn } from '../../common/logger';

export class ShowConnectionSwitcherHandler implements IMessageHandler {
  constructor(private statusBar: any) { }

  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    // const metadata = context.editor.metadata as PostgresMetadata; // Not directly accessible on editor type sometimes, check usage
    // Actually editor.notebook.metadata is read-only in API but we update via workspace edit or custom util
    // ConnectionUtils.updateNotebookMetadata handles the edit.

    const selected = await ConnectionUtils.showConnectionPicker(message.connectionId);

    if (selected && selected.id !== message.connectionId) {
      await ConnectionUtils.updateNotebookMetadata(context.editor.notebook, {
        connectionId: selected.id,
        databaseName: selected.database,
        host: selected.host,
        port: selected.port,
        username: selected.username
      });
      await WorkspaceStateService.getInstance().recordConnectionSwitch(selected.id, selected.database);
      vscode.window.showInformationMessage(`Switched to: ${selected.name || selected.host}`);
      this.statusBar.update();
    }
  }
}

export class ShowDatabaseSwitcherHandler implements IMessageHandler {
  constructor(private statusBar: any) { }

  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    const connection = ConnectionUtils.findConnection(message.connectionId);
    if (!connection) {
      vscode.window.showErrorMessage('Connection not found');
      return;
    }

    const selectedDb = await ConnectionUtils.showDatabasePicker(connection, message.currentDatabase);

    if (selectedDb && selectedDb !== message.currentDatabase) {
      await ConnectionUtils.updateNotebookMetadata(context.editor.notebook, { databaseName: selectedDb });
      const connectionId = (context.editor.notebook.metadata as PostgresMetadata | undefined)?.connectionId;
      if (connectionId) {
        await WorkspaceStateService.getInstance().recordDatabaseSwitch(connectionId, selectedDb);
      }
      vscode.window.showInformationMessage(`Switched to database: ${selectedDb}`);
      this.statusBar.update();
    }
  }
}

export class ImportPickFileHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    const metadata = context.editor.notebook.metadata;
    const connectionId = metadata?.connectionId;
    if (!connectionId) {
      vscode.window.showErrorMessage('No active connection found for this notebook.');
      return;
    }

    const connection = ConnectionUtils.findConnection(connectionId);
    if (!connection) {
      vscode.window.showErrorMessage('Connection configuration not found.');
      return;
    }

    const { table, schema } = message;

    // Step 1: Native OS file picker — no iframe issues
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: `Import into ${schema}.${table}`,
      filters: { 'Data files': ['csv', 'tsv', 'json', 'txt'] }
    });
    if (!uris || uris.length === 0) return;

    const fileUri = uris[0];
    const ext = fileUri.fsPath.split('.').pop()?.toLowerCase() ?? '';

    // Step 2: Read file
    const rawBytes = await vscode.workspace.fs.readFile(fileUri);
    const content = Buffer.from(rawBytes).toString('utf8');

    // Step 3: Parse
    let parsedData: any[];
    try {
      if (ext === 'json') {
        const json = JSON.parse(content);
        if (!Array.isArray(json)) {
          vscode.window.showErrorMessage('JSON file must contain an array of objects.');
          return;
        }
        parsedData = json;
      } else {
        // CSV / TSV / TXT
        const delimiter = ext === 'tsv' ? '\t' : ',';
        parsedData = parseDelimited(content, delimiter);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to parse file: ${err.message}`);
      return;
    }

    if (parsedData.length === 0) {
      vscode.window.showWarningMessage('File contains no data rows.');
      return;
    }

    // Step 4: Ask conflict strategy via quick pick
    const conflictChoice = await vscode.window.showQuickPick(
      [
        { label: 'Skip duplicates', description: 'ON CONFLICT DO NOTHING', value: 'skip' },
        { label: 'Fail on duplicate', description: 'Stop and rollback on any conflict', value: 'fail' },
      ],
      { placeHolder: 'How should duplicate primary keys be handled?' }
    );
    if (!conflictChoice) return;

    // Step 5: Insert
    await performImport({ table, schema, data: parsedData, onConflict: conflictChoice.value }, connection);
  }
}

export class OpenImportDataHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    const metadata = context.editor.notebook.metadata as any;
    if (!metadata?.connectionId) {
      vscode.window.showErrorMessage('No active connection found for this notebook.');
      return;
    }

    const targetItem = new DatabaseTreeItem(
      message.table,
      vscode.TreeItemCollapsibleState.None,
      'table',
      metadata.connectionId,
      metadata.databaseName,
      message.schema,
      message.table,
    );

    await vscode.commands.executeCommand('postgres-explorer.importData', targetItem);
  }
}

function parseDelimited(text: string, delimiter: string): any[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitLine(lines[0], delimiter).map(h => h.replace(/^"|"$/g, '').trim());
  const result: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i], delimiter);
    const row: any = {};
    headers.forEach((h, idx) => {
      const v = (values[idx] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"').trim();
      row[h] = v === '' ? null : v;
    });
    result.push(row);
  }
  return result;
}

function splitLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let inQuote = false;
  let val = '';
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === delimiter && !inQuote) {
      values.push(val);
      val = '';
    } else {
      val += c;
    }
  }
  values.push(val);
  return values;
}

async function performImport(
  message: { table: string; schema: string; data: any[]; onConflict: string },
  connection: any
) {
  const { table, schema, data, onConflict } = message;

  const client = await import('../../services/ConnectionManager').then(
    m => m.ConnectionManager.getInstance().getPooledClient(connection)
  );

  try {
    await client.query('BEGIN');

    // Detect auto-generated columns (serial / identity) to exclude from INSERT
    const colMetaResult = await client.query(
      `SELECT column_name, column_default, is_identity
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [schema, table]
    );

    const autoGenColumns = new Set<string>(
      colMetaResult.rows
        .filter((r: any) =>
          (r.column_default && r.column_default.includes('nextval(')) ||
          r.is_identity === 'YES'
        )
        .map((r: any) => r.column_name)
    );

    const allColumns = Object.keys(data[0]);
    const columns = allColumns.filter(c => !autoGenColumns.has(c));

    if (columns.length === 0) {
      vscode.window.showWarningMessage('No importable columns found (all columns are auto-generated).');
      await client.query('ROLLBACK');
      return;
    }

    const quotedColumns = columns.map(c => `"${c}"`).join(', ');
    const tableName = `"${schema}"."${table}"`;
    const conflictClause = onConflict === 'skip' ? ' ON CONFLICT DO NOTHING' : '';
    const BATCH_SIZE = 100;
    let insertedCount = 0;

    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      batch.forEach(row => {
        const rowPlaceholders: string[] = [];
        columns.forEach(col => {
          rowPlaceholders.push(`$${values.length + 1}`);
          const v = row[col];
          values.push(v === '' || v === undefined ? null : v);
        });
        placeholders.push(`(${rowPlaceholders.join(', ')})`);
      });

      const query = `INSERT INTO ${tableName} (${quotedColumns}) VALUES ${placeholders.join(', ')}${conflictClause}`;
      const result = await client.query(query, values);
      insertedCount += result.rowCount ?? batch.length;
    }

    await client.query('COMMIT');
    vscode.window.showInformationMessage(
      `Successfully imported ${insertedCount} rows into ${schema}.${table}.`
    );
  } catch (err: any) {
    await client.query('ROLLBACK');
    vscode.window.showErrorMessage(`Import failed: ${err.message}`);
    console.error('Import error:', err);
  } finally {
    client.release();
  }
}

export class ImportRequestHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    const metadata = context.editor.notebook.metadata as PostgresMetadata;
    const connectionId = metadata?.connectionId;
    if (!connectionId) {
      vscode.window.showErrorMessage('No active connection found for this notebook.');
      return;
    }

    const connection = ConnectionUtils.findConnection(connectionId);
    if (!connection) {
      vscode.window.showErrorMessage('Connection configuration not found.');
      return;
    }

    const notebookKey = `activeProfile-${context.editor.notebook.uri.toString()}`;
    const activeProfileContext = extensionContext?.globalState.get<any>(notebookKey);

    const connectionConfig = {
      ...connection,
      database: metadata?.databaseName || connection.database
    };

    // Apply profile overrides with floor protection
    let readOnlyMode = connection.readOnlyMode === true;
    if (metadata?.readOnlyMode !== undefined) {
      readOnlyMode = readOnlyMode || metadata.readOnlyMode;
    }
    if (activeProfileContext?.readOnlyMode !== undefined) {
      readOnlyMode = readOnlyMode || activeProfileContext.readOnlyMode;
    }
    connectionConfig.readOnlyMode = readOnlyMode;

    if (connectionConfig.readOnlyMode) {
      vscode.window.showErrorMessage('Import operations are not allowed in read-only mode');
      return;
    }

    const { data } = message;
    if (!data || !Array.isArray(data) || data.length === 0) {
      vscode.window.showWarningMessage('No data received for import.');
      return;
    }

    await performImport(message, connectionConfig);
  }
}

export class ExportRequestHandler implements IMessageHandler {
  private sanitizeFilenamePart(value: string): string {
    return value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80);
  }

  private inferDefaultBasename(tableInfo?: any): string {
    const schema = typeof tableInfo?.schema === 'string' ? this.sanitizeFilenamePart(tableInfo.schema) : '';
    const table = typeof tableInfo?.table === 'string' ? this.sanitizeFilenamePart(tableInfo.table) : '';
    if (schema && table) {
      return `${schema}_${table}_export`;
    }
    if (table) {
      return `${table}_export`;
    }
    return 'query_export';
  }

  private getDefaultExportUri(ext: 'csv' | 'json' | 'md', tableInfo?: any): vscode.Uri {
    const filename = `${this.inferDefaultBasename(tableInfo)}.${ext}`;
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (wsFolder) {
      return vscode.Uri.joinPath(wsFolder, filename);
    }
    return vscode.Uri.file(filename);
  }

  private async openSavedFile(uri: vscode.Uri): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    } catch (err) {
      debugWarn('Export file open failed:', err);
    }
  }

  private isReadOnlyExportQuery(query: string): boolean {
    const clean = query.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    return /^\s*(SELECT|WITH)\b/i.test(clean);
  }

  async handle(message: any, context: { editor?: vscode.NotebookEditor }) {
    const {
      rows: displayRows = [],
      columns = [],
      query,
      format,
      tableInfo,
    } = message ?? {};

    const effectiveFormat: 'csv' | 'json' | 'markdown' | 'clipboard' | 'sqlinsert' =
      format === 'json' ||
      format === 'markdown' ||
      format === 'clipboard' ||
      format === 'sqlinsert'
        ? format
        : 'csv';

    let rowsToExport: any[] = Array.isArray(displayRows) ? displayRows : [];
    let columnsToExport: string[] = Array.isArray(columns) ? columns : [];

    // Re-run query for full export when we have enough context.
    if (typeof query === 'string' && query.trim() && context.editor) {
      if (!this.isReadOnlyExportQuery(query)) {
        vscode.window.showWarningMessage(
          'Full export rerun is only enabled for SELECT queries; exporting visible rows only.',
        );
      } else {
      const metadata = context.editor.notebook.metadata as PostgresMetadata | undefined;
      const connectionId = metadata?.connectionId;
      if (!connectionId) {
        vscode.window.showWarningMessage('No active connection found; exporting visible rows only.');
      } else {
        const connection = ConnectionUtils.findConnection(connectionId);
        if (!connection) {
          vscode.window.showWarningMessage('Connection configuration missing; exporting visible rows only.');
        } else {
          try {
            const client = await ConnectionManager.getInstance().getSessionClient(
              {
                id: connection.id,
                host: connection.host,
                port: connection.port,
                username: connection.username,
                database: metadata?.databaseName || connection.database,
                name: connection.name,
              } as any,
              context.editor.notebook.uri.toString(),
            );
            const result = await client.query(query);
            rowsToExport = result.rows || [];
            const queriedColumns = result.fields?.map((f: any) => f.name) || [];
            columnsToExport =
              queriedColumns.length > 0
                ? queriedColumns
                : rowsToExport.length > 0
                  ? Object.keys(rowsToExport[0])
                  : columnsToExport;
          } catch (err: any) {
            vscode.window.showWarningMessage(
              `Full export query failed (${err?.message ?? String(err)}); exporting visible rows only.`,
            );
          }
        }
      }
      }
    }

    if (effectiveFormat === 'clipboard') {
      const csv = this.rowsToCsv(rowsToExport, columnsToExport);
      await vscode.env.clipboard.writeText(csv);
      vscode.window.showInformationMessage(
        `Copied ${rowsToExport.length.toLocaleString()} rows to clipboard`,
      );
      return;
    }

    if (effectiveFormat === 'sqlinsert') {
      const sql = this.rowsToSqlInsert(rowsToExport, columnsToExport, tableInfo);
      await vscode.env.clipboard.writeText(sql);
      vscode.window.showInformationMessage(
        `Copied SQL INSERT script (${rowsToExport.length.toLocaleString()} rows)`,
      );
      return;
    }

    if (effectiveFormat === 'csv') {
      const csv = this.rowsToCsv(rowsToExport, columnsToExport);
      const uri = await vscode.window.showSaveDialog({
        filters: { CSV: ['csv'] },
        defaultUri: this.getDefaultExportUri('csv', tableInfo),
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(csv));
        await this.openSavedFile(uri);
        vscode.window.showInformationMessage(`Exported ${rowsToExport.length.toLocaleString()} rows (CSV)`);
      }
      return;
    }

    if (effectiveFormat === 'json') {
      const json = JSON.stringify(rowsToExport, null, 2);
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ['json'] },
        defaultUri: this.getDefaultExportUri('json', tableInfo),
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json));
        await this.openSavedFile(uri);
        vscode.window.showInformationMessage(`Exported ${rowsToExport.length.toLocaleString()} rows (JSON)`);
      }
      return;
    }

    const markdown = this.rowsToMarkdown(rowsToExport, columnsToExport);
    const uri = await vscode.window.showSaveDialog({
      filters: { Markdown: ['md'] },
      defaultUri: this.getDefaultExportUri('md', tableInfo),
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown));
      await this.openSavedFile(uri);
      vscode.window.showInformationMessage(`Exported ${rowsToExport.length.toLocaleString()} rows (Markdown)`);
    }
  }

  private rowsToCsv(rows: any[], columns: string[]): string {
    const header = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(',');
    const body = rows.map(row => columns.map(col => {
      const val = row[col];
      const str = String(val ?? '');
      return str.includes(',') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',')).join('\n');
    return `${header}\n${body}`;
  }

  private rowsToMarkdown(rows: any[], columns: string[]): string {
    const header = `| ${columns.join(' | ')} |`;
    const separator = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows
      .map((row) => {
        return `| ${columns
          .map((col) => {
            const val = row[col];
            if (val === null || val === undefined) return 'NULL';
            const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
            return str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          })
          .join(' | ')} |`;
      })
      .join('\n');
    return `${header}\n${separator}\n${body}`;
  }

  private rowsToSqlInsert(rows: any[], columns: string[], tableInfo?: any): string {
    if (!tableInfo?.schema || !tableInfo?.table) {
      return '-- Table information not available for INSERT script';
    }
    const tableName = `"${String(tableInfo.schema).replace(/"/g, '""')}"."${String(
      tableInfo.table,
    ).replace(/"/g, '""')}"`;
    const cols = columns.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(', ');

    return rows
      .map((row) => {
        const values = columns
          .map((col) => {
            const val = row[col];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'number') return String(val);
            if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
            const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
            return `'${str.replace(/'/g, "''")}'`;
          })
          .join(', ');
        return `INSERT INTO ${tableName} (${cols}) VALUES (${values});`;
      })
      .join('\n');
  }
}

export class ShowErrorMessageHandler implements IMessageHandler {
  async handle(message: any) {
    vscode.window.showErrorMessage(message.message);
  }
}

export class RunDerivedQueryHandler implements IMessageHandler {
  async handle(message: any, context: { editor?: vscode.NotebookEditor }) {
    if (!context.editor) {
      return;
    }

    const sql = typeof message?.query === 'string' ? message.query.trim() : '';
    if (!sql) {
      vscode.window.showErrorMessage('No derived query provided.');
      return;
    }
    if (!QueryAnalyzer.getInstance().isReadOnlyQuery(sql)) {
      vscode.window.showErrorMessage('Only SELECT/WITH derived queries are allowed.');
      return;
    }

    const notebook = context.editor.notebook;
    const insertionIndex = Math.min(
      notebook.cellCount,
      Math.max(0, (context.editor.selection?.end ?? notebook.cellCount)),
    );

    const fullDatasetRequested =
      message?.fullDataset === true ||
      (typeof message?.source === 'string' && message.source.startsWith('streaming-'));
    const cellSql = fullDatasetRequested ? `-- pgstudio:full-dataset\n${sql}` : sql;
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, cellSql, 'sql');
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertionIndex, [cell])]);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage('Failed to insert derived query cell.');
      return;
    }

    const editor = await vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
    const range = new vscode.NotebookRange(insertionIndex, insertionIndex + 1);
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    await vscode.commands.executeCommand('notebook.cell.execute', {
      ranges: [range],
      document: notebook.uri,
    });
  }
}

const SKIP_GRID_COMMIT_CONFIRM_KEY = 'postgresExplorer.skipGridCommitConfirm';

/** Persist "don't ask again" for notebook grid Commit → saveChanges flow. */
export class GridCommitPreferenceHandler implements IMessageHandler {
  constructor(private readonly extensionContext: vscode.ExtensionContext) {}

  async handle(
    message: any,
    context: {
      postMessage?: (msg: any) => Thenable<boolean>;
      editor?: vscode.NotebookEditor;
    },
  ): Promise<void> {
    if (message.action === 'get' && message.requestId && context.postMessage) {
      const skipConfirm = this.extensionContext.globalState.get<boolean>(SKIP_GRID_COMMIT_CONFIRM_KEY) === true;
      await context.postMessage({
        type: 'gridCommitPreferenceResponse',
        requestId: message.requestId,
        skipConfirm,
        result: okResponse('GRID_COMMIT_PREF_FETCHED', { skipConfirm }),
      });
      return;
    }

    if (message.action === 'set' && typeof message.skipConfirm === 'boolean') {
      await this.extensionContext.globalState.update(SKIP_GRID_COMMIT_CONFIRM_KEY, message.skipConfirm);
      if (context.postMessage) {
        await context.postMessage({
          type: 'gridCommitPreferenceResponse',
          requestId: message.requestId,
          skipConfirm: message.skipConfirm,
          result: okResponse('GRID_COMMIT_PREF_UPDATED', { skipConfirm: message.skipConfirm }),
        });
      }
      return;
    }

    if (context.postMessage) {
      await context.postMessage({
        type: 'gridCommitPreferenceResponse',
        requestId: message.requestId,
        skipConfirm: false,
        result: errorResponse(
          'GRID_COMMIT_PREF_INVALID_REQUEST',
          'Invalid gridCommitPreference action payload.',
          'Use action "get" with requestId or action "set" with skipConfirm boolean.',
        ),
      });
    }
  }
}

export class RetryCellHandler implements IMessageHandler {
  async handle(message: any, context: { editor?: vscode.NotebookEditor }) {
    if (!context.editor) return;
    // Re-execute the active cell that produced this error
    const notebook = context.editor.notebook;
    const cells = notebook.getCells();
    // Find the cell whose query matches, or just re-run the active selection
    await vscode.commands.executeCommand('notebook.cell.execute');
  }
}

/** Result hover toolbar: focus source cell then optional command (Expand / Ask AI / Save). */
export class NotebookOutputToolbarHandler implements IMessageHandler {
  async handle(message: any, context: { editor?: vscode.NotebookEditor }): Promise<void> {
    const idx = typeof message?.cellIndex === 'number' ? message.cellIndex : -1;
    const action = message?.action as string | undefined;
    const editor = context.editor;

    if (!editor || idx < 0 || idx >= editor.notebook.cellCount) {
      vscode.window.showWarningMessage(
        'Could not find the SQL cell for this result. Re-run the query to refresh the output.',
      );
      return;
    }

    const notebook = editor.notebook;
    const cell = notebook.cellAt(idx);
    const range = new vscode.NotebookRange(idx, idx + 1);

    await vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
    const active = vscode.window.activeNotebookEditor;
    if (!active || active.notebook.uri.toString() !== notebook.uri.toString()) {
      return;
    }

    active.selection = range;
    active.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);

    if (action === 'expand') {
      return;
    }

    if (action === 'aiAssist') {
      await vscode.commands.executeCommand('postgres-explorer.aiAssist', cell);
      return;
    }

    if (action === 'saveQuery') {
      await vscode.commands.executeCommand('postgres-explorer.saveQueryToLibraryUI');
    }
  }
}

export class ShowConnectionInfoHandler implements IMessageHandler {
  async handle(message: any, context: { editor?: vscode.NotebookEditor }) {
    if (!context.editor) return;
    const notebook = context.editor.notebook;
    const effectiveMetadata = ConnectionUtils.getEffectiveMetadata(notebook.metadata);
    const conn = ConnectionUtils.findConnectionWithFallback(effectiveMetadata?.connectionId, notebook.metadata);
    if (conn) {
      vscode.window.showInformationMessage(
        `Connection: ${conn.name || conn.host} | Host: ${conn.host}:${conn.port} | Database: ${effectiveMetadata?.databaseName || conn.database}`
      );
    } else {
      vscode.window.showInformationMessage('No active connection for this notebook.');
    }
  }
}

