import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { SecretStorageService } from '../services/SecretStorageService';
import { ConnectionManager } from '../services/ConnectionManager';
import { createMetadata } from '../commands/connection';

/**
 * Resolves a database connection from a tree item.
 *
 * When commands are triggered from the tree's context menu, VS Code
 * passes the original DatabaseTreeItem instance.  However, `connectionId`
 * can sometimes be `undefined` on items deep in the tree hierarchy.
 *
 * This helper uses multiple fallback strategies to find the right
 * connection, making the schema-designer commands resilient.
 */
export async function resolveTreeItemConnection(item: DatabaseTreeItem) {
  const connections =
    vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];

  if (connections.length === 0) {
    throw new Error('No saved connections found. Please add a connection first.');
  }

  let connection: any;

  // Strategy 1: Use connectionId directly (ideal path)
  if (item.connectionId) {
    connection = connections.find(c => c.id === item.connectionId);
  }

  // Strategy 2: If only one connection exists, use it
  if (!connection && connections.length === 1) {
    connection = connections[0];
  }

  // Strategy 3: Ask user to pick from all connections
  if (!connection) {
    const pick = await vscode.window.showQuickPick(
      connections.map(c => ({
        label: c.name || `${c.host}:${c.port}`,
        description: c.database || '',
        id: c.id
      })),
      { placeHolder: 'Select the connection for this operation' }
    );
    if (!pick) return undefined; // user cancelled
    connection = connections.find(c => c.id === pick.id);
  }

  if (!connection) {
    throw new Error('Could not determine database connection.');
  }

  // Retrieve the password from secret storage
  const password = await SecretStorageService.getInstance().getPassword(connection.id);
  if (!password) {
    throw new Error('Password not found in secure storage. Re-enter the connection password.');
  }
  const fullConnection = { ...connection, password };

  // Use the database from the tree item if available, else fall back to the connection default
  const databaseName = item.databaseName || connection.database;
  const client = await ConnectionManager.getInstance().getPooledClient({
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    database: databaseName,
    name: connection.name,
  });

  const metadata = createMetadata(fullConnection, databaseName);

  return {
    connection: fullConnection,
    client,
    metadata,
    release: () => client.release(),
  };
}
