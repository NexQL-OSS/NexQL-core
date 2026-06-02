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

  /** Walk down nested custom metadata if present to get the actual PostgresMetadata object */
  static getEffectiveMetadata(metadata: any): any | undefined {
    if (!metadata) return undefined;
    let current = metadata;
    while (current && !current.connectionId && current.custom?.metadata) {
      current = current.custom.metadata;
    }
    return current;
  }

  /** Find a connection by ID or by metadata fallback (e.g. host, port, username, or single connection) */
  static findConnectionWithFallback(connectionId: string | undefined, metadata?: any): any | undefined {
    const connections = this.getConnections();
    if (connections.length === 0) return undefined;

    const effectiveMetadata = this.getEffectiveMetadata(metadata);
    const targetId = connectionId || effectiveMetadata?.connectionId;

    if (targetId) {
      const conn = connections.find(c => c.id === targetId);
      if (conn) return conn;
    }

    if (effectiveMetadata) {
      // Fallback A: Match by host, port, username
      if (effectiveMetadata.host && effectiveMetadata.port) {
        const conn = connections.find(c =>
          c.host === effectiveMetadata.host &&
          Number(c.port) === Number(effectiveMetadata.port) &&
          (!effectiveMetadata.username || c.username === effectiveMetadata.username)
        );
        if (conn) return conn;
      }

      // Fallback B: Match by host and databaseName/database
      if (effectiveMetadata.host && (effectiveMetadata.databaseName || effectiveMetadata.database)) {
        const dbName = effectiveMetadata.databaseName || effectiveMetadata.database;
        const conn = connections.find(c =>
          c.host === effectiveMetadata.host &&
          (c.database === dbName || c.name === dbName)
        );
        if (conn) return conn;
      }
    }

    // Fallback C: If there is exactly one configured connection, use it
    if (connections.length === 1) {
      return connections[0];
    }

    return undefined;
  }

  /** Get the active notebook editor if it's a PostgreSQL notebook */
  static getActivePostgresNotebook(): vscode.NotebookEditor | undefined {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) return undefined;

    const type = editor.notebook.notebookType;
    if (type !== 'postgres-notebook' && type !== 'postgres-query') return undefined;

    return editor;
  }

  /** Update notebook metadata. Returns false if the workspace edit was not applied. */
  static async updateNotebookMetadata(
    notebook: vscode.NotebookDocument,
    updates: Partial<Record<string, any>>
  ): Promise<boolean> {
    const newMetadata = { ...notebook.metadata, ...updates };
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(newMetadata)]);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      console.warn(
        `ConnectionUtils.updateNotebookMetadata: workspace edit not applied for ${notebook.uri.toString()}`,
      );
    }
    return applied;
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
