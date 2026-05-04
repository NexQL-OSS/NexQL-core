import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { TableDesignerPanel } from '../schemaDesigner/TableDesignerPanel';
import { SchemaDiffPanel } from '../schemaDesigner/SchemaDiffPanel';
import { ErdPanel } from '../schemaDesigner/ErdPanel';
import { ImportDataPanel } from '../schemaDesigner/ImportDataPanel';
import { ConnectionManager } from '../services/ConnectionManager';
import { resolveTreeItemConnection } from '../schemaDesigner/connectionHelper';
import { ErrorHandlers } from './helper';

/**
 * Open the Visual Table Designer for an existing table (Edit mode)
 */
export async function cmdOpenTableDesigner(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  console.log('[SchemaDesigner] cmdOpenTableDesigner called with item:', JSON.stringify({
    label: item?.label,
    type: item?.type,
    connectionId: item?.connectionId,
    databaseName: item?.databaseName,
    schema: item?.schema,
    tableName: item?.tableName,
    contextValue: item?.contextValue,
  }));
  await TableDesignerPanel.openForTable(item, context);
}

/**
 * Open the Visual Table Designer in Create mode (new table)
 */
export async function cmdCreateTableVisual(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  await TableDesignerPanel.openForCreate(item, context);
}

/**
 * Open the Schema Diff panel to compare two schemas
 */
export async function cmdOpenSchemaDiff(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  console.log('[SchemaDesigner] cmdOpenSchemaDiff called with item:', JSON.stringify({
    label: item?.label,
    type: item?.type,
    connectionId: item?.connectionId,
    databaseName: item?.databaseName,
    schema: item?.schema,
    tableName: item?.tableName,
    contextValue: item?.contextValue,
  }));
  await SchemaDiffPanel.open(item, context);
}

/**
 * Schema diff from the Command Palette: pick connection → database → source schema,
 * then the usual target-schema flow from {@link SchemaDiffPanel.open}.
 */
export async function cmdOpenSchemaDiffFromPalette(
  context: vscode.ExtensionContext
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
    { title: 'Schema Diff: Connection', placeHolder: 'Select a saved connection' },
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
      title: 'Schema Diff: Database',
      placeHolder: 'Database containing the source schema',
    });
    if (!dbChoice) {
      return;
    }
    dbName = dbChoice;
  } finally {
    tempClient.release();
  }

  let client;
  try {
    client = await ConnectionManager.getInstance().getPooledClient({
      ...(connection as any),
      database: dbName,
    });
  } catch (err: any) {
    await vscode.window.showErrorMessage(
      `Could not connect to database "${dbName}": ${err?.message || String(err)}`,
    );
    return;
  }

  let schemaName: string;
  try {
    const sch = await client.query(`
      SELECT nspname AS schema_name
      FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND nspname NOT LIKE 'pg_%'
      ORDER BY nspname
    `);
    const names = sch.rows.map((r: { schema_name: string }) => r.schema_name);
    const schemaChoice = await vscode.window.showQuickPick(names, {
      title: `Schema Diff: Source schema (${dbName})`,
      placeHolder: 'Schema to treat as the migration source',
    });
    if (!schemaChoice) {
      return;
    }
    schemaName = schemaChoice;
  } finally {
    client.release();
  }

  const synthetic = new DatabaseTreeItem(
    schemaName,
    vscode.TreeItemCollapsibleState.Collapsed,
    'schema',
    connection.id,
    dbName,
    schemaName,
  );

  await SchemaDiffPanel.open(synthetic, context);
}

/**
 * Open the ERD (Entity-Relationship Diagram) for a schema
 */
export async function cmdOpenErd(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  await ErdPanel.open(item, context);
}

/**
 * ERD across multiple schemas (context: database node).
 */
export async function cmdOpenErdMultiFromDatabase(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  const conn = await resolveTreeItemConnection(item);
  if (!conn) {
    return;
  }
  try {
    const sch = await conn.client.query(`
      SELECT nspname AS schema_name
      FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND nspname NOT LIKE 'pg_%'
      ORDER BY nspname
    `);
    const names = sch.rows.map((r: { schema_name: string }) => r.schema_name);
    const picked = await vscode.window.showQuickPick(
      names.map((s) => ({ label: s, picked: s === 'public' })),
      { canPickMany: true, title: 'ERD: choose schema(s)' }
    );
    if (!picked || picked.length === 0) {
      return;
    }
    await ErdPanel.openForSchemas(
      context,
      item,
      picked.map((p) => p.label)
    );
  } catch (err: unknown) {
    await ErrorHandlers.handleCommandError(err, 'open multi-schema ERD');
  } finally {
    conn.release();
  }
}

/**
 * Import a DBML file and emit PostgreSQL CREATE TABLE statements.
 */
export async function cmdImportDbml(
  _item: DatabaseTreeItem | undefined,
  _context: vscode.ExtensionContext
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    openLabel: 'Import DBML',
    filters: { DBML: ['dbml', 'txt'], 'All files': ['*'] },
    canSelectMany: false,
  });
  if (!uris?.length) {
    return;
  }
  const buf = await vscode.workspace.fs.readFile(uris[0]);
  const text = Buffer.from(buf).toString('utf8');
  const { dbmlToPostgresCreateTables } = await import('../schemaDesigner/erd/erdDbmlImport');
  const { sql, errors } = dbmlToPostgresCreateTables(text);
  if (errors.length > 0) {
    await vscode.window.showWarningMessage(errors.join('; '));
  }
  if (sql.length === 0) {
    await vscode.window.showErrorMessage('No CREATE TABLE statements generated from DBML.');
    return;
  }
  const connections =
    vscode.workspace.getConfiguration().get<Array<Record<string, unknown>>>('postgresExplorer.connections') ||
    [];
  type ConnPick = vscode.QuickPickItem & { conn?: Record<string, unknown> };
  const items: ConnPick[] = [
    { label: 'Open as SQL buffer', description: 'Untitled editor', alwaysShow: true },
    ...connections.map((c: Record<string, unknown>) => ({
      label: `Notebook: ${(c.name as string) || `${c.host}:${c.port}`}`,
      description: (c.database as string) || 'postgres',
      conn: c,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'DBML import: open as…' });
  if (!pick) {
    return;
  }
  if (!('conn' in pick) || !pick.conn) {
    const doc = await vscode.workspace.openTextDocument({
      content: sql.join('\n\n'),
      language: 'postgres',
    });
    await vscode.window.showTextDocument(doc);
    return;
  }
  const { createAndShowNotebook, createMetadata } = await import('./connection');
  const md =
    `### DBML import\n\nSource: \`${uris[0].fsPath}\`\n\nReview before executing. Partial types and refs may need manual fixes.`;
  await createAndShowNotebook(
    [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown'),
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql.join('\n\n'), 'sql'),
    ],
    createMetadata(pick.conn, (pick.conn.database as string) || 'postgres')
  );
}

/**
 * Open the Import Data tool (pgAdmin-style CSV/TSV import wizard)
 */
export async function cmdImportData(
  item: DatabaseTreeItem,
  context: vscode.ExtensionContext
): Promise<void> {
  await ImportDataPanel.open(item, context);
}
