import * as vscode from 'vscode';
import { Client } from 'pg';
import { SecretStorageService } from '../services/SecretStorageService';

/**
 * Utility functions for connection and database switching in notebooks.
 */
export class ConnectionUtils {

  /** Get all configured connections */
  static getConnections(): any[] {
    return vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
  }

  /** Find a connection by ID */
  static findConnection(connectionId: string): any | undefined {
    return this.getConnections().find(c => c.id === connectionId);
  }

  /** Get the active notebook editor if it's a PostgreSQL notebook */
  static getActivePostgresNotebook(): vscode.NotebookEditor | undefined {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) return undefined;

    const type = editor.notebook.notebookType;
    if (type !== 'postgres-notebook' && type !== 'postgres-query') return undefined;

    return editor;
  }

  /** Update notebook metadata */
  static async updateNotebookMetadata(
    notebook: vscode.NotebookDocument,
    updates: Partial<Record<string, any>>
  ): Promise<void> {
    const newMetadata = { ...notebook.metadata, ...updates };
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit?.updateNotebookMetadata(newMetadata)]);
    await vscode.workspace.applyEdit(edit);
  }

  /** List all databases for a connection */
  static async listDatabases(connection: any): Promise<string[]> {
    const password = await SecretStorageService.getInstance().getPassword(connection.id);
    const client = new Client({
      host: connection.host,
      port: connection.port,
      database: 'postgres',
      user: connection.username,
      password: password || connection.password || undefined,
    });

    try {
      await client.connect();
      const result = await client.query(`
        SELECT datname FROM pg_database 
        WHERE datistemplate = false 
        ORDER BY datname
      `);
      return result.rows.map(row => row.datname);
    } finally {
      await client.end();
    }
  }

  /** Show connection quick pick and return selected connection */
  static async showConnectionPicker(
    currentConnectionId?: string,
    quickPick?: { title?: string; placeHolder?: string }
  ): Promise<any | undefined> {
    const connections = this.getConnections();

    if (connections.length === 0) {
      vscode.window.showWarningMessage('No database connections configured.');
      return undefined;
    }

    const items = connections.map(conn => ({
      label: conn.name || conn.host,
      description: `${conn.host}:${conn.port}/${conn.database}`,
      picked: conn.id === currentConnectionId,
      connection: conn
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: quickPick?.placeHolder ?? 'Select connection',
      title: quickPick?.title ?? 'Switch Database Connection'
    });

    return selected?.connection;
  }

  /** Show database quick pick and return selected database name */
  static async showDatabasePicker(
    connection: any,
    currentDatabase?: string,
    quickPick?: { title?: string; placeHolder?: string }
  ): Promise<string | undefined> {
    try {
      const databases = await this.listDatabases(connection);

      const items = databases.map(db => ({
        label: db,
        picked: db === currentDatabase,
        database: db
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: quickPick?.placeHolder ?? 'Select database',
        title: quickPick?.title ?? 'Switch Database'
      });

      return selected?.database;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list databases: ${err.message}`);
      return undefined;
    }
  }
}
