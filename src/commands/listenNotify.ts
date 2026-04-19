import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { ListenNotifyPanel } from '../providers/ListenNotifyPanel';
import { ConnectionManager } from '../services/ConnectionManager';
import { ErrorHandlers } from './helper';

export async function cmdOpenListenNotify(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    if (item.type !== 'database' || !item.connectionId || !item.databaseName) {
      await vscode.window.showErrorMessage(
        'Open LISTEN/NOTIFY from a database node in the PG Studio tree.',
      );
      return;
    }
    await ListenNotifyPanel.open(item.connectionId, item.databaseName, context);
  } catch (err) {
    await ErrorHandlers.handleCommandError(err, 'open LISTEN/NOTIFY monitor');
  }
}

/**
 * Command Palette: pick saved connection → database, then open the monitor panel.
 */
export async function cmdOpenListenNotifyFromPalette(
  context: vscode.ExtensionContext,
): Promise<void> {
  const connections =
    vscode.workspace.getConfiguration().get<Array<Record<string, unknown>>>('postgresExplorer.connections') ||
    [];
  if (connections.length === 0) {
    await vscode.window.showErrorMessage('No saved connections. Add one in settings.');
    return;
  }

  const connPick = await vscode.window.showQuickPick(
    connections.map((c: any) => ({
      label: (c.name as string) || `${c.host}:${c.port}`,
      description: (c.database as string) || 'postgres',
      conn: c,
    })),
    { title: 'LISTEN/NOTIFY: Connection', placeHolder: 'Select a saved connection' },
  );
  if (!connPick) {
    return;
  }

  const connection = connPick.conn as Record<string, unknown> & {
    id: string;
    host: string;
    port: number;
    database?: string;
  };
  const bootstrapDb = connection.database || 'postgres';

  let tempClient;
  try {
    tempClient = await ConnectionManager.getInstance().getPooledClient({
      ...(connection as any),
      database: bootstrapDb,
    });
  } catch (err: any) {
    await vscode.window.showErrorMessage(
      `Could not connect: ${err?.message || String(err)}. Check credentials and network.`,
    );
    return;
  }

  let dbName: string;
  try {
    const dbsResult = await tempClient.query(`
      SELECT datname FROM pg_database
      WHERE datallowconn = true AND datistemplate = false
      ORDER BY datname
    `);
    const databases = dbsResult.rows.map((r: { datname: string }) => r.datname);
    const dbChoice = await vscode.window.showQuickPick(databases, {
      title: 'LISTEN/NOTIFY: Database',
      placeHolder: 'Database to open a dedicated LISTEN session on',
    });
    if (!dbChoice) {
      return;
    }
    dbName = dbChoice;
  } finally {
    tempClient.release();
  }

  try {
    await ListenNotifyPanel.open(connection.id, dbName, context);
  } catch (err) {
    await ErrorHandlers.handleCommandError(err, 'open LISTEN/NOTIFY monitor');
  }
}
