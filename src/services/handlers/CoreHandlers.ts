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

    const { table, schema, data } = message;
    if (!data || !Array.isArray(data) || data.length === 0) {
      vscode.window.showWarningMessage('No data received for import.');
      return;
    }

    const client = await import('../../services/ConnectionManager').then(m => m.ConnectionManager.getInstance().getPooledClient(connection));

    try {
      await client.query('BEGIN');

      // Batch insert logic
      const BATCH_SIZE = 100;
      const columns = Object.keys(data[0]);
      const quotedColumns = columns.map(c => `"${c}"`).join(', ');
      const tableName = `"${schema}"."${table}"`;

      let insertedCount = 0;

      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((row, rowIndex) => {
          const rowPlaceholders: string[] = [];
          columns.forEach((col, colIndex) => {
            rowPlaceholders.push(`$${values.length + 1}`);
            values.push(row[col] ?? null);
          });
          placeholders.push(`(${rowPlaceholders.join(', ')})`);
        });

        const query = `INSERT INTO ${tableName} (${quotedColumns}) VALUES ${placeholders.join(', ')}`;
        await client.query(query, values);
        insertedCount += batch.length;
      }

      await client.query('COMMIT');
      vscode.window.showInformationMessage(`Successfully imported ${insertedCount} rows into ${schema}.${table}.`);

      // Notify renderer to refresh?
      // Actually we just show message. The user might need to re-run query to see data.
      // We could trigger a re-run if we had access to the cell, but we are in a handler.

    } catch (err: any) {
      await client.query('ROLLBACK');
      vscode.window.showErrorMessage(`Import failed: ${err.message}`);
      console.error('Import error:', err);
    } finally {
      client.release();
    }
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

