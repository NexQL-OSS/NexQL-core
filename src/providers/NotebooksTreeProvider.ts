import * as vscode from 'vscode';
import * as path from 'path';

export type NotebookTreeItemType = 'connection-folder' | 'db-folder' | 'notebook-file';

export class NotebookTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: NotebookTreeItemType,
    public readonly uri?: vscode.Uri,
    description?: string,
    tooltip?: string
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.tooltip = tooltip ?? label;
    this.contextValue = itemType;

    switch (itemType) {
      case 'connection-folder':
        this.iconPath = new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue'));
        break;
      case 'db-folder':
        this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.purple'));
        break;
      case 'notebook-file':
        this.iconPath = new vscode.ThemeIcon('notebook', new vscode.ThemeColor('charts.yellow'));
        this.command = {
          command: 'postgres-explorer.notebooks.open',
          title: 'Open Notebook',
          arguments: [this]
        };
        break;
    }
  }
}

export class NotebooksTreeProvider implements vscode.TreeDataProvider<NotebookTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<NotebookTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly globalStorageUri: vscode.Uri) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: NotebookTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NotebookTreeItem): Promise<NotebookTreeItem[]> {
    try {
      if (!element) {
        return await this._getConnectionFolders();
      }
      if (element.itemType === 'connection-folder' && element.uri) {
        return await this._getDbFolders(element.uri);
      }
      if (element.itemType === 'db-folder' && element.uri) {
        return await this._getNotebookFiles(element.uri);
      }
    } catch {
      // globalStorage may not exist yet
    }
    return [];
  }

  private async _getConnectionFolders(): Promise<NotebookTreeItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.globalStorageUri);
    } catch {
      return [];
    }
    return entries
      .filter(([, type]) => type === vscode.FileType.Directory)
      .map(([name]) => new NotebookTreeItem(
        name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'connection-folder',
        vscode.Uri.joinPath(this.globalStorageUri, name)
      ));
  }

  private async _getDbFolders(connUri: vscode.Uri): Promise<NotebookTreeItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(connUri);
    } catch {
      return [];
    }
    return entries
      .filter(([, type]) => type === vscode.FileType.Directory)
      .map(([name]) => new NotebookTreeItem(
        name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'db-folder',
        vscode.Uri.joinPath(connUri, name)
      ));
  }

  private async _getNotebookFiles(dbUri: vscode.Uri): Promise<NotebookTreeItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dbUri);
    } catch {
      return [];
    }

    const files = entries.filter(([name, type]) =>
      type === vscode.FileType.File && name.endsWith('.pgsql')
    );

    const items: NotebookTreeItem[] = [];
    for (const [name] of files) {
      const uri = vscode.Uri.joinPath(dbUri, name);
      const { description, tooltip } = await this._getFileMeta(uri, name);
      items.push(new NotebookTreeItem(
        name.replace(/\.pgsql$/, ''),
        vscode.TreeItemCollapsibleState.None,
        'notebook-file',
        uri,
        description,
        tooltip
      ));
    }
    // Sort: scratch file first, then named notebooks alphabetically
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
        vscode.workspace.fs.readFile(uri)
      ]);
      const mtime = new Date(stat.mtime).toLocaleDateString();
      let sectionCount = 0;
      try {
        const data = JSON.parse(Buffer.from(raw).toString());
        if (Array.isArray(data.cells)) {
          sectionCount = data.cells.filter((c: any) =>
            c.kind === 'markdown' && /^#{1,3}\s/.test(c.value ?? '')
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
