import * as vscode from 'vscode';
import * as path from 'path';
import { SyncIndex } from '../features/sync/SyncIndex';
import { SyncController } from '../features/sync/SyncController';
import {
  SharedTeamRootTreeItem,
  WorkspaceFolderTreeItem,
  groupTeamItemsByWorkspace,
  isViewerForSpace,
  workspaceDisplayName,
} from '../features/sync/SharedTeamTree';

export type NotebookTreeItemType =
  | 'folder'
  | 'notebook-file'
  | 'shared-team-root'
  | 'workspace-folder'
  | 'shared-notebook-file';

export class NotebookTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: NotebookTreeItemType,
    public readonly uri?: vscode.Uri,
    description?: string,
    tooltip?: string,
    public readonly spaceId?: string,
    public readonly syncItemId?: string,
    folderDepth = 0,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.tooltip = tooltip ?? label;
    this.contextValue = itemType;

    switch (itemType) {
      case 'folder':
        this.iconPath = folderDepth === 1
          ? new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue'))
          : folderDepth === 2
            ? new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.purple'))
            : new vscode.ThemeIcon('folder');
        break;
      case 'notebook-file':
        this.iconPath = new vscode.ThemeIcon('notebook', new vscode.ThemeColor('charts.yellow'));
        this.command = {
          command: 'postgres-explorer.notebooks.open',
          title: 'Open Notebook',
          arguments: [this],
        };
        break;
      case 'shared-team-root':
        this.iconPath = new vscode.ThemeIcon('organization');
        break;
      case 'workspace-folder':
        this.iconPath = new vscode.ThemeIcon('folder-library');
        break;
      case 'shared-notebook-file':
        this.iconPath = new vscode.ThemeIcon('notebook', new vscode.ThemeColor('charts.orange'));
        this.command = {
          command: 'postgres-explorer.notebooks.open',
          title: 'Open Notebook',
          arguments: [this],
        };
        break;
    }
  }
}

export class NotebooksTreeProvider implements vscode.TreeDataProvider<NotebookTreeItem | SharedTeamRootTreeItem | WorkspaceFolderTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<NotebookTreeItem | SharedTeamRootTreeItem | WorkspaceFolderTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly extensionContext?: vscode.ExtensionContext,
  ) {}

  private _folderDepth(folderUri: vscode.Uri): number {
    const rel = path.relative(this.globalStorageUri.fsPath, folderUri.fsPath);
    if (!rel || rel.startsWith('..')) {
      return 0;
    }
    return rel.split(path.sep).filter(Boolean).length;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: NotebookTreeItem | SharedTeamRootTreeItem | WorkspaceFolderTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: NotebookTreeItem | SharedTeamRootTreeItem | WorkspaceFolderTreeItem,
  ): Promise<Array<NotebookTreeItem | SharedTeamRootTreeItem | WorkspaceFolderTreeItem>> {
    try {
      if (!element) {
        const folders = await this._getRootFolders();
        const sharedRoot = this._getSharedTeamRoot();
        return sharedRoot ? [...folders, sharedRoot] : folders;
      }
      if (element instanceof SharedTeamRootTreeItem) {
        return this._getWorkspaceFolders();
      }
      if (element instanceof WorkspaceFolderTreeItem) {
        return this._getSharedNotebookFiles(element.spaceId);
      }
      if (element.itemType === 'folder' && element.uri) {
        return await this._getFolderChildren(element.uri);
      }
    } catch {
      // globalStorage may not exist yet
    }
    return [];
  }

  private _getSharedTeamRoot(): SharedTeamRootTreeItem | undefined {
    if (!this.extensionContext) {
      return undefined;
    }
    const notebooks = SyncController.getInstance()
      .listTeamItems()
      .filter((i) => i.entry.kind === 'notebook');
    if (!notebooks.length) {
      return undefined;
    }
    return new SharedTeamRootTreeItem(notebooks.length);
  }

  private _getWorkspaceFolders(): WorkspaceFolderTreeItem[] {
    const grouped = groupTeamItemsByWorkspace(SyncController.getInstance().listTeamItems(), 'notebook');
    return [...grouped.entries()].map(
      ([spaceId, items]) => new WorkspaceFolderTreeItem(spaceId, workspaceDisplayName(spaceId), items.length),
    );
  }

  private _getSharedNotebookFiles(spaceId: string): NotebookTreeItem[] {
    const items: NotebookTreeItem[] = [];
    for (const { id, entry } of SyncController.getInstance().listTeamItems()) {
      if (entry.kind !== 'notebook' || entry.spaceId !== spaceId || !entry.filePath) {
        continue;
      }
      const uri = vscode.Uri.file(entry.filePath);
      const name = entry.name ?? path.basename(entry.filePath, '.pgsql');
      const readOnly = isViewerForSpace(spaceId);
      items.push(
        new NotebookTreeItem(
          name,
          vscode.TreeItemCollapsibleState.None,
          'shared-notebook-file',
          uri,
          readOnly ? 'read-only' : 'team',
          readOnly ? `${name}\nRead-only (viewer)` : name,
          spaceId,
          id,
        ),
      );
    }
    items.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return items;
  }

  private _isTeamNotebookPath(filePath: string): boolean {
    if (!this.extensionContext) {
      return false;
    }
    const match = new SyncIndex(this.extensionContext).findByPath(filePath);
    return !!match?.entry.spaceId?.startsWith('ws_');
  }

  private async _getRootFolders(): Promise<NotebookTreeItem[]> {
    return this._listSubfolders(this.globalStorageUri);
  }

  private async _getFolderChildren(folderUri: vscode.Uri): Promise<NotebookTreeItem[]> {
    const folders = await this._listSubfolders(folderUri);
    const notebooks = await this._listNotebooks(folderUri);
    return [...folders, ...notebooks];
  }

  private async _listSubfolders(parentUri: vscode.Uri): Promise<NotebookTreeItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(parentUri);
    } catch {
      return [];
    }
    return entries
      .filter(([, type]) => type === vscode.FileType.Directory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name]) => {
        const uri = vscode.Uri.joinPath(parentUri, name);
        return new NotebookTreeItem(
          name,
          vscode.TreeItemCollapsibleState.Collapsed,
          'folder',
          uri,
          undefined,
          undefined,
          undefined,
          undefined,
          this._folderDepth(uri),
        );
      });
  }

  private async _listNotebooks(folderUri: vscode.Uri): Promise<NotebookTreeItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folderUri);
    } catch {
      return [];
    }

    const files = entries.filter(([name, type]) =>
      type === vscode.FileType.File && name.endsWith('.pgsql'),
    );

    const items: NotebookTreeItem[] = [];
    for (const [name] of files) {
      const uri = vscode.Uri.joinPath(folderUri, name);
      if (this._isTeamNotebookPath(uri.fsPath)) {
        continue;
      }
      const { description, tooltip } = await this._getFileMeta(uri, name);
      items.push(new NotebookTreeItem(
        name.replace(/\.pgsql$/, ''),
        vscode.TreeItemCollapsibleState.None,
        'notebook-file',
        uri,
        description,
        tooltip,
      ));
    }
    items.sort((a, b) => {
      const aLabel = a.label as string;
      const bLabel = b.label as string;
      const aIsScratch = aLabel === 'scratch';
      const bIsScratch = bLabel === 'scratch';
      if (aIsScratch !== bIsScratch) { return aIsScratch ? -1 : 1; }
      return aLabel.localeCompare(bLabel);
    });
    return items;
  }

  private async _getFileMeta(uri: vscode.Uri, filename: string): Promise<{ description: string; tooltip: string }> {
    try {
      const [stat, raw] = await Promise.all([
        vscode.workspace.fs.stat(uri),
        vscode.workspace.fs.readFile(uri),
      ]);
      const mtime = new Date(stat.mtime).toLocaleDateString();
      let sectionCount = 0;
      try {
        const data = JSON.parse(Buffer.from(raw).toString());
        if (Array.isArray(data.cells)) {
          sectionCount = data.cells.filter((c: { kind?: string; value?: string }) =>
            c.kind === 'markdown' && /^#{1,3}\s/.test(c.value ?? ''),
          ).length;
        }
      } catch { /* malformed file */ }
      const desc = sectionCount > 0 ? `${sectionCount} section${sectionCount !== 1 ? 's' : ''} · ${mtime}` : mtime;
      return { description: desc, tooltip: `${filename}\nModified: ${mtime}\nSections: ${sectionCount}` };
    } catch {
      return { description: '', tooltip: filename };
    }
  }
}
