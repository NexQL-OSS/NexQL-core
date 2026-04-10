import * as vscode from 'vscode';
import { IMessageHandler } from '../MessageHandler';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { PostgresMetadata } from '../../common/types';

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

    const { data } = message;
    if (!data || !Array.isArray(data) || data.length === 0) {
      vscode.window.showWarningMessage('No data received for import.');
      return;
    }

    await performImport(message, connection);
  }
}

export class ExportRequestHandler implements IMessageHandler {
  async handle(message: any) {
    // This logic was in NotebookKernel previously
    // It requires UI interaction so it fits here.
    const { rows: displayRows, columns } = message;

    const selection = await vscode.window.showQuickPick(['Save as CSV', 'Save as JSON', 'Copy to Clipboard']);
    if (!selection) return;

    const rowsToExport = displayRows;

    if (selection === 'Copy to Clipboard') {
      const csv = this.rowsToCsv(rowsToExport, columns);
      await vscode.env.clipboard.writeText(csv);
      vscode.window.showInformationMessage('Copied to clipboard');
    } else if (selection === 'Save as CSV') {
      const csv = this.rowsToCsv(rowsToExport, columns);
      const uri = await vscode.window.showSaveDialog({ filters: { 'CSV': ['csv'] } });
      if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(csv));
    } else if (selection === 'Save as JSON') {
      const json = JSON.stringify(rowsToExport, null, 2);
      const uri = await vscode.window.showSaveDialog({ filters: { 'JSON': ['json'] } });
      if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(json));
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
}

export class ShowErrorMessageHandler implements IMessageHandler {
  async handle(message: any) {
    vscode.window.showErrorMessage(message.message);
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

export class ShowConnectionInfoHandler implements IMessageHandler {
  async handle(message: any, context: { editor?: vscode.NotebookEditor }) {
    if (!context.editor) return;
    const notebook = context.editor.notebook;
    const metadata = notebook.metadata as any;
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === metadata?.connectionId);
    if (conn) {
      vscode.window.showInformationMessage(
        `Connection: ${conn.name || conn.host} | Host: ${conn.host}:${conn.port} | Database: ${metadata?.databaseName || conn.database}`
      );
    } else {
      vscode.window.showInformationMessage('No active connection for this notebook.');
    }
  }
}

