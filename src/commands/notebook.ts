import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { getDatabaseConnection, NotebookBuilder, MarkdownUtils, ErrorHandlers, validateNotebookContextItem } from './helper';
import { PostgresMetadata } from '../common/types';
import { ConnectionUtils } from '../utils/connectionUtils';
import { isProFeatureEnabled, ProFeature } from '../services/featureGates';
import { NotebookIndexService } from '../services/NotebookIndexService';

type NotebookCellSeed = {
  kind: 'markdown' | 'sql';
  value: string;
};

type NotebookPickerResult =
  | { action: 'open'; uri: vscode.Uri }
  | { action: 'create-random' }
  | { action: 'create-named'; name: string }
  | { action: 'cancel' };

function toSafeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeNotebookName(input: string): string {
  const noExt = input.replace(/\.pgsql$/i, '').trim();
  return noExt.replace(/[\\/]/g, '_');
}

function getNotebookFolderUri(metadata: any, context: vscode.ExtensionContext): vscode.Uri | undefined {
  const databaseName = (metadata?.databaseName ?? metadata?.database) as string | undefined;
  const connectionNameOrId = (metadata?.name ?? metadata?.connectionName ?? metadata?.connectionId) as string | undefined;
  if (!databaseName || !connectionNameOrId) {
    return undefined;
  }

  return vscode.Uri.joinPath(
    context.globalStorageUri,
    toSafeSegment(connectionNameOrId),
    toSafeSegment(databaseName)
  );
}

async function createNotebookAtUri(
  uri: vscode.Uri,
  metadata: any,
  cells: NotebookCellSeed[]
): Promise<vscode.NotebookDocument> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));

  const databaseName = (metadata?.databaseName ?? metadata?.database) as string | undefined;
  const connectionName = (metadata?.name ?? metadata?.connectionName) as string | undefined;
  const fileMetadata = {
    connectionId: metadata?.connectionId,
    host: metadata?.host,
    port: metadata?.port,
    username: metadata?.username,
    database: databaseName,
    databaseName,
    title: connectionName && databaseName ? `${connectionName}-${databaseName}` : databaseName,
  };

  const serializedCells = cells.map((cell) => ({
    value: cell.value,
    kind: cell.kind,
    language: cell.kind === 'markdown' ? 'markdown' : 'sql',
  }));

  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(JSON.stringify({ cells: serializedCells, metadata: fileMetadata }))
  );

  return vscode.workspace.openNotebookDocument(uri);
}

export async function pickNotebookFromList(
  existingNotebookUris: vscode.Uri[],
  title: string,
  allowCreate: boolean = true
): Promise<NotebookPickerResult> {
  const existingByName = new Map<string, vscode.Uri>();
  for (const uri of existingNotebookUris) {
    const base = normalizeNotebookName(uri.path.split('/').pop() ?? '').toLowerCase();
    if (!base) { continue; }
    if (!existingByName.has(base)) {
      existingByName.set(base, uri);
    }
  }

  const existingItems = (await Promise.all(existingNotebookUris.map(async (uri) => {
    const parts = uri.path.split('/');
    const filename = parts.pop() ?? '';
    const dbName = parts.pop() ?? '';
    let sectionCount = 0;
    let modified = '';

    try {
      const [stat, raw] = await Promise.all([
        vscode.workspace.fs.stat(uri),
        vscode.workspace.fs.readFile(uri),
      ]);
      modified = new Date(stat.mtime).toLocaleDateString();

      try {
        const data = JSON.parse(Buffer.from(raw).toString());
        if (Array.isArray(data.cells)) {
          sectionCount = data.cells.filter((c: any) =>
            c.kind === 'markdown' && /^#{1,3}\s/.test(c.value ?? '')
          ).length;
        }
      } catch {
        sectionCount = 0;
      }
    } catch {
      modified = '';
      sectionCount = 0;
    }

    const sectionText = `${sectionCount} section${sectionCount === 1 ? '' : 's'}`;
    const dateText = modified || 'Unknown date';
    const prefix = filename === 'scratch.pgsql' ? 'Scratch' : 'Notebook';

    return {
      label: normalizeNotebookName(filename),
      description: `${prefix} [${dbName}] · ${sectionText} · ${dateText}`,
      uri,
      itemType: 'existing' as const,
    };
  }))).sort((a, b) => a.label.localeCompare(b.label));

  const createRandomItem = {
    label: '$(add) Create New Notebook',
    description: 'Create a new notebook with an auto-generated name',
    itemType: 'create-random' as const,
  };

  return new Promise<NotebookPickerResult>((resolve) => {
    const qp = vscode.window.createQuickPick<
      | typeof existingItems[number]
      | typeof createRandomItem
      | { label: string; description: string; itemType: 'create-named'; name: string }
    >();
    qp.title = title;
    qp.placeholder = allowCreate ? 'Search notebooks or type a new notebook name' : 'Search existing notebooks';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    const updateItems = () => {
      const typed = normalizeNotebookName(qp.value);
      const hasTyped = typed.length > 0;
      const hasExisting = hasTyped && existingByName.has(typed.toLowerCase());
      const createNamedItem = allowCreate && hasTyped && !hasExisting
        ? [{
            label: `$(add) Create "${typed}"`,
            description: 'Press Enter to create notebook with this name',
            itemType: 'create-named' as const,
            name: typed,
          }]
        : [];

      qp.items = allowCreate ? [...existingItems, createRandomItem, ...createNamedItem] : existingItems;
    };

    qp.onDidChangeValue(updateItems);

    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      const typed = normalizeNotebookName(qp.value);

      if (selected?.itemType === 'existing' && selected.uri) {
        qp.hide();
        resolve({ action: 'open', uri: selected.uri });
        return;
      }

      if (allowCreate && selected?.itemType === 'create-random') {
        qp.hide();
        resolve({ action: 'create-random' });
        return;
      }

      if (allowCreate && selected?.itemType === 'create-named') {
        qp.hide();
        resolve({ action: 'create-named', name: selected.name });
        return;
      }

      if (typed) {
        const existing = existingByName.get(typed.toLowerCase());
        qp.hide();
        if (existing) {
          resolve({ action: 'open', uri: existing });
        } else if (allowCreate) {
          resolve({ action: 'create-named', name: typed });
        } else {
          resolve({ action: 'cancel' });
        }
        return;
      }

      qp.hide();
      resolve({ action: 'cancel' });
    });

    qp.onDidHide(() => {
      resolve({ action: 'cancel' });
      qp.dispose();
    });

    updateItems();
    qp.show();
  });
}

export async function openOrCreateNotebookWithPicker(
  metadata: any,
  cells: NotebookCellSeed[],
  context: vscode.ExtensionContext,
  pickerTitle: string
): Promise<void> {
  const folderUri = getNotebookFolderUri(metadata, context);
  if (!folderUri) {
    await createAndOpenRandomNotebook(metadata, cells);
    return;
  }

  await vscode.workspace.fs.createDirectory(folderUri);

  const connectionNameOrId = (metadata?.name ?? metadata?.connectionName ?? metadata?.connectionId) as string | undefined;
  if (connectionNameOrId) {
    const { count: totalNotebooks, uris: connectionNotebookUris } = await ConnectionUtils.countNotebooksInConnection(context, connectionNameOrId);
    const isUnlimited = isProFeatureEnabled(ProFeature.UnlimitedNotebooks);

    if (!isUnlimited && totalNotebooks >= 5) {
      const choice = await vscode.window.showWarningMessage(
        `Free tier is limited to 5 notebooks per connection. Upgrade to Sponsor or Team for unlimited notebooks.`,
        'Open Existing Notebook',
        'Upgrade'
      );
      if (choice === 'Upgrade') {
        await vscode.commands.executeCommand('postgres-explorer.license.openUpgrade');
      } else if (choice === 'Open Existing Notebook') {
        const pick = await pickNotebookFromList(connectionNotebookUris, 'Open Existing Notebook', false);
        if (pick.action === 'open') {
          const existingDoc = await vscode.workspace.openNotebookDocument(pick.uri);
          await vscode.window.showNotebookDocument(existingDoc, { preserveFocus: false });
        }
      }
      return;
    }
  }

  let existingNotebookUris: vscode.Uri[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    existingNotebookUris = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.pgsql'))
      .map(([name]) => vscode.Uri.joinPath(folderUri, name));
  } catch {
    existingNotebookUris = [];
  }

  const pick = await pickNotebookFromList(existingNotebookUris, pickerTitle);
  if (pick.action === 'cancel') {
    return;
  }

  if (pick.action === 'open') {
    const existingDoc = await vscode.workspace.openNotebookDocument(pick.uri);
    await vscode.window.showNotebookDocument(existingDoc, { preserveFocus: false });
    return;
  }

  if (pick.action === 'create-random') {
    await createAndOpenRandomNotebook(metadata, cells);
    return;
  }

  const name = normalizeNotebookName(pick.name);
  if (!name) {
    vscode.window.showErrorMessage('Notebook name cannot be empty.');
    return;
  }

  const namedUri = vscode.Uri.joinPath(folderUri, `${name}.pgsql`);
  try {
    await vscode.workspace.fs.stat(namedUri);
    const existingDoc = await vscode.workspace.openNotebookDocument(namedUri);
    await vscode.window.showNotebookDocument(existingDoc, { preserveFocus: false });
    return;
  } catch {
    // File does not exist; continue with create.
  }

  const notebook = await createNotebookAtUri(namedUri, metadata, cells);
  const editor = await vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
  if (notebook.cellCount > 0) {
    editor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.AtTop);
  }
}

async function createAndOpenRandomNotebook(metadata: any, cells: NotebookCellSeed[]): Promise<void> {
  const builder = new NotebookBuilder(metadata);
  for (const cell of cells) {
    if (cell.kind === 'markdown') {
      builder.addMarkdown(cell.value);
    } else {
      builder.addSql(cell.value);
    }
  }
  await builder.showNew();
}

function hasNotebookDbContext(item: DatabaseTreeItem | undefined): boolean {
  return item !== undefined && !!item.connectionId && !!item.databaseName;
}

/**
 * When the command runs from a keybinding there is no tree selection; some tree nodes
 * also omit connectionId/databaseName. Prompt for connection and database in that case.
 */
async function resolveNotebookTreeItem(item: DatabaseTreeItem | undefined): Promise<DatabaseTreeItem | undefined> {
  if (hasNotebookDbContext(item)) {
    return item;
  }
  const connection = await ConnectionUtils.showConnectionPicker(undefined, {
    title: 'New SQL Notebook',
    placeHolder: 'Select a connection for this notebook',
  });
  if (!connection) {
    return undefined;
  }
  const databaseName = await ConnectionUtils.showDatabasePicker(connection, undefined, {
    title: 'New SQL Notebook',
    placeHolder: 'Select a database to connect the notebook to',
  });
  if (!databaseName) {
    return undefined;
  }
  return new DatabaseTreeItem(
    databaseName,
    vscode.TreeItemCollapsibleState.None,
    'database',
    connection.id,
    databaseName
  );
}

export async function cmdNewNotebook(item: DatabaseTreeItem, context?: vscode.ExtensionContext) {
  try {
    const treeItem = await resolveNotebookTreeItem(item);
    if (!treeItem) {
      return;
    }

    const dbConn = await getDatabaseConnection(treeItem, validateNotebookContextItem);
    const { metadata } = dbConn;
    if (dbConn.release) dbConn.release();

    const initialCells: NotebookCellSeed[] = [
      {
        kind: 'markdown',
        value:
          MarkdownUtils.header(`📓 New Notebook: \`${metadata.databaseName}\``) +
          MarkdownUtils.infoBox('Write and execute your SQL queries in the cell below.'),
      },
      {
        kind: 'sql',
        value: `-- Connected to database: ${metadata.databaseName}
-- Write your SQL query here
SELECT * FROM ${treeItem.schema ? `${treeItem.schema}.${treeItem.label}` : 'your_table'}
LIMIT 100;`,
      },
    ];

    if (!context) {
      await createAndOpenRandomNotebook(metadata, initialCells);
      return;
    }

    await openOrCreateNotebookWithPicker(
      metadata,
      initialCells,
      context,
      `Open or Create Notebook (${metadata.databaseName})`
    );

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create new notebook');
  }
}

/**
 * Jump to a section in the active scratch notebook via Quick Pick.
 * Scans all markdown cells for top-level headings (lines starting with #)
 * and lets the user pick one to navigate to.
 */
export async function cmdJumpToSection() {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No notebook is currently open.');
    return;
  }

  const doc = editor.notebook;
  const sections: { label: string; detail: string; cellIndex: number }[] = [];

  doc.getCells().forEach((cell, index) => {
    if (cell.kind !== vscode.NotebookCellKind.Markup) { return; }
    const lines = cell.document.getText().split('\n');
    for (const line of lines) {
      const match = line.match(/^(#{1,3})\s+(.+)/);
      if (match) {
        const depth = match[1].length;
        const title = match[2].trim();
        const indent = depth === 1 ? '' : depth === 2 ? '  ' : '    ';
        sections.push({
          label: `${indent}${depth === 1 ? '$(symbol-namespace)' : depth === 2 ? '$(symbol-class)' : '$(symbol-method)'} ${title}`,
          detail: `Cell ${index + 1}`,
          cellIndex: index
        });
        break; // only use the first heading per cell
      }
    }
  });

  if (sections.length === 0) {
    vscode.window.showInformationMessage('No sections found. Add markdown headings (# Title) to create navigable sections.');
    return;
  }

  const picked = await vscode.window.showQuickPick(sections, {
    placeHolder: 'Jump to section…',
    title: 'Notebook Sections',
    matchOnDetail: true
  });

  if (!picked) { return; }

  await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
  editor.revealRange(
    new vscode.NotebookRange(picked.cellIndex, picked.cellIndex + 1),
    vscode.NotebookEditorRevealType.AtTop
  );
}

/**
 * Execute EXPLAIN or EXPLAIN ANALYZE for a query.
 * Executes in the notebook so results can be sent to chat
 */
export async function cmdExplainQuery(cellUri: vscode.Uri, analyze: boolean) {
  try {
    // Get the notebook cell document
    const doc = await vscode.workspace.openTextDocument(cellUri);
    if (!doc) {
      vscode.window.showErrorMessage('Could not find cell document');
      return;
    }

    let query = doc.getText().trim();
    if (!query) {
      vscode.window.showErrorMessage('Cell is empty');
      return;
    }

    // Get the notebook and its metadata
    const notebook = vscode.workspace.notebookDocuments.find(nb => 
      nb.getCells().some(c => c.document.uri.toString() === cellUri.toString())
    );

    if (!notebook) {
      vscode.window.showErrorMessage('Could not find notebook');
      return;
    }

    const metadata = notebook.metadata as PostgresMetadata;
    if (!metadata || !metadata.connectionId) {
      vscode.window.showErrorMessage('No connection metadata found');
      return;
    }

    // Wrap query in EXPLAIN
    const explainQuery = analyze 
      ? `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS, VERBOSE) ${query}`
      : `EXPLAIN (FORMAT JSON) ${query}`;

    // Find the cell in the notebook
    const cells = notebook.getCells();
    const cellIndex = cells.findIndex(c => c.document.uri.toString() === cellUri.toString());
    
    if (cellIndex === -1) {
      vscode.window.showErrorMessage('Could not locate cell in notebook');
      return;
    }

    // Create workspace edit to insert the EXPLAIN query cell after current cell
    const workspaceEdit = new vscode.WorkspaceEdit();
    
    const notebookEdit = new vscode.NotebookEdit(
      new vscode.NotebookRange(cellIndex + 1, cellIndex + 1),
      [
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          explainQuery,
          'sql'
        )
      ]
    );

    workspaceEdit.set(notebook.uri, [notebookEdit]);
    await vscode.workspace.applyEdit(workspaceEdit);

    vscode.window.showInformationMessage(
      analyze 
        ? 'EXPLAIN ANALYZE query created in next cell. Execute to see the plan with actual statistics. Send results to Chat for AI analysis!'
        : 'EXPLAIN query created in next cell. Execute to see the estimated execution plan. Send results to Chat for optimization suggestions!'
    );

  } catch (error: any) {
    await ErrorHandlers.handleCommandError(error, 'create EXPLAIN query');
  }
}

export async function cmdSwitchNotebookConnection(): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || (editor.notebook.notebookType !== 'postgres-notebook' && editor.notebook.notebookType !== 'postgres-query')) {
    vscode.window.showInformationMessage('Please focus an active PostgreSQL notebook to switch connections.');
    return;
  }

  const notebook = editor.notebook;
  const currentMeta = ConnectionUtils.getEffectiveMetadata(notebook.metadata);
  const currentConnId = currentMeta?.connectionId;

  const connection = await ConnectionUtils.showConnectionPicker(currentConnId, {
    title: 'Switch Notebook Connection',
    placeHolder: 'Select a connection for this notebook'
  });

  if (!connection) {
    return;
  }

  const currentDb = currentMeta?.databaseName || connection.database;
  const dbName = await ConnectionUtils.showDatabasePicker(connection, currentDb, {
    title: 'Switch Notebook Database',
    placeHolder: `Select a database (current: ${currentDb})`
  });

  if (!dbName) {
    return;
  }

  const cleanMetadata = {
    connectionId: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    database: dbName,
    databaseName: dbName,
    title: connection.name && dbName ? `${connection.name}-${dbName}` : dbName,
  };

  const newMetadata = {
    ...notebook.metadata,
    ...cleanMetadata,
    custom: {
      cells: (notebook.metadata as any)?.custom?.cells || [],
      metadata: {
        ...cleanMetadata,
        enableScripts: true
      }
    }
  };

  const applied = await ConnectionUtils.updateNotebookMetadata(notebook, newMetadata);
  if (applied) {
    vscode.window.showInformationMessage(`Notebook switched to "${connection.name || connection.host}" (DB: ${dbName})`);
    vscode.commands.executeCommand('postgres-explorer.notebooks.refresh');
    vscode.commands.executeCommand('postgres-explorer.refresh');
  }
}

export async function cmdQuickOpenNotebook(context: vscode.ExtensionContext): Promise<void> {
  const mru = context.globalState.get<string[] | undefined>('postgresExplorer.mruNotebooks', []) || [];
  const localNotebooks = NotebookIndexService.getInstance().getAllNotebooks();
  const sharedNotebooks: Array<{ name: string; uri: vscode.Uri; isShared: boolean }> = [];
  try {
    const { SyncController } = await import('../features/sync/SyncController');
    const teamItems = SyncController.getInstance().listTeamItems();
    for (const { entry } of teamItems) {
      if (entry.kind === 'notebook' && entry.filePath) {
        sharedNotebooks.push({
          name: entry.name || path.basename(entry.filePath, '.pgsql'),
          uri: vscode.Uri.file(entry.filePath),
          isShared: true
        });
      }
    }
  } catch {
    // Ignore sync failures
  }

  const allItems: Array<{ label: string; description: string; detail: string; uri: vscode.Uri }> = [];
  const addedPaths = new Set<string>();
  const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
  const getConnName = (id?: string) => {
    if (!id) return '';
    const c = connections.find(conn => conn.id === id);
    return c ? `🔌 ${c.name || c.host}` : '';
  };

  for (const nb of localNotebooks) {
    if (addedPaths.has(nb.uri.fsPath)) continue;
    addedPaths.add(nb.uri.fsPath);
    const connLabel = getConnName(nb.connectionId);
    allItems.push({
      label: nb.name,
      description: connLabel || '(no connection)',
      detail: nb.uri.fsPath,
      uri: nb.uri
    });
  }

  for (const snb of sharedNotebooks) {
    if (addedPaths.has(snb.uri.fsPath)) continue;
    addedPaths.add(snb.uri.fsPath);
    allItems.push({
      label: snb.name,
      description: '👥 Shared / Team',
      detail: snb.uri.fsPath,
      uri: snb.uri
    });
  }

  allItems.sort((a, b) => {
    const idxA = mru.indexOf(a.uri.fsPath);
    const idxB = mru.indexOf(b.uri.fsPath);
    if (idxA !== -1 && idxB !== -1) {
      return idxA - idxB;
    }
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.label.localeCompare(b.label);
  });

  const pick = await vscode.window.showQuickPick(allItems, {
    placeHolder: 'Search notebooks by name or connection...',
    title: 'Quick Open Notebook'
  });

  if (pick) {
    const updatedMru = [pick.uri.fsPath, ...mru.filter(p => p !== pick.uri.fsPath)].slice(0, 50);
    await context.globalState.update('postgresExplorer.mruNotebooks', updatedMru);
    const doc = await vscode.workspace.openNotebookDocument(pick.uri);
    await vscode.window.showNotebookDocument(doc);
  }
}