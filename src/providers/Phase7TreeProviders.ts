import * as vscode from 'vscode';
import { setLastTreeDragPayload } from './dragPayloadStore';
import { ProfileManager } from '../features/connections/ProfileManager';
import { SavedQueriesService } from '../features/savedQueries/SavedQueriesService';
import { extensionContext } from '../extension';
import { getSyncDataSource } from '../services/syncRegistry';
import {
  SharedTeamRootTreeItem,
  WorkspaceFolderTreeItem,
  groupTeamItemsByWorkspace,
  isViewerForSpace,
  workspaceDisplayName,
} from './SharedTeamTree';

/**
 * Tree view item for connection profiles
 */
class ProfileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly profile: any,
    public readonly isActive: boolean = false,
    public readonly command?: vscode.Command
  ) {
    const label = isActive 
      ? `● ${profile.profileName || profile.name || `${profile.host}:${profile.port}`}`
      : profile.profileName || profile.name || `${profile.host}:${profile.port}`;
    
    super(
      label,
      vscode.TreeItemCollapsibleState.None
    );
    this.description = isActive ? `${profile.description || `${profile.host}:${profile.port}`} (ACTIVE)` : (profile.description || `${profile.host}:${profile.port}`);
    this.tooltip = `${profile.profileName}\n${profile.description || ''}\nHost: ${profile.host}:${profile.port}${isActive ? '\n\n✓ This profile is currently active' : ''}`;
    this.contextValue = 'profile';
    this.iconPath = new vscode.ThemeIcon(profile.readOnlyMode ? 'lock' : 'person');
    
    // Highlight active profile with bold styling if supported
    if (isActive) {
      this.resourceUri = vscode.Uri.parse('profile://active');
    }
  }
}

/**
 * Tree view item for saved queries
 */
class SavedQueryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly query: any,
    readOnly = false,
  ) {
    super(query.title, vscode.TreeItemCollapsibleState.None);
    
    // Build description with metadata
    const parts: string[] = [];
    
    // Add database name if available
    if (query.databaseName) {
      parts.push(`📊 ${query.databaseName}`);
    }
    
    // Add connection name if available
    if (query.connectionId) {
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const connection = connections.find(c => c.id === query.connectionId);
      if (connection) {
        parts.push(`🔗 ${connection.name || connection.host}`);
      }
    }
    
    // Add usage count
    parts.push(`${query.usageCount || 0}x used`);
    
    this.description = parts.join(' • ');
    
    // Build rich tooltip with all details
    const createdDate = new Date(query.createdAt).toLocaleString();
    const lastUsedDate = query.lastUsed ? new Date(query.lastUsed).toLocaleString() : 'Never';
    const queryPreview = query.query.replace(/\n/g, ' ').substring(0, 120);
    
    const tooltipParts: string[] = [
      `📝 ${queryPreview}${query.query.length > 120 ? '...' : ''}`,
      '',
      `📅 Created: ${createdDate}`,
      `⏱️  Last Used: ${lastUsedDate}`,
      `📊 Database: ${query.databaseName || 'N/A'}`,
      `🔗 Schema: ${query.schemaName || 'N/A'}`
    ];
    
    if (query.description) {
      tooltipParts.push('', `📋 ${query.description}`);
    }
    
    if (query.tags && query.tags.length > 0) {
      tooltipParts.push('', `🏷️  Tags: ${query.tags.join(', ')}`);
    }
    
    this.tooltip = tooltipParts.join('\n');
    this.contextValue = readOnly ? 'sharedQuery' : 'savedQuery';
    if (readOnly) {
      parts.push('read-only');
      this.description = parts.join(' • ');
    }
    this.iconPath = new vscode.ThemeIcon(readOnly ? 'lock' : 'save');
  }
}

/**
 * Tree view item for query tags - shows count and can be expanded
 */
class TagTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tag: string,
    public readonly queryCount: number
  ) {
    super(`${tag} (${queryCount})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${queryCount} quer${queryCount === 1 ? 'y' : 'ies'}`;
    this.tooltip = `Click to expand and see all queries tagged with "${tag}"`;
    this.contextValue = 'tag';
    this.iconPath = new vscode.ThemeIcon('tag');
  }
}

/**
 * Tree view provider for connection profiles
 */
export class ProfilesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor() {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const profileManager = ProfileManager.getInstance();
    const profiles = profileManager.getProfiles();

    if (profiles.length === 0) {
      const noItemsItem = new vscode.TreeItem('No profiles yet');
      noItemsItem.contextValue = 'emptyProfiles';
      noItemsItem.iconPath = new vscode.ThemeIcon('info');
      return [noItemsItem];
    }

    // Get currently active notebook to check which profile is active
    const activeEditor = vscode.window.activeNotebookEditor;
    const notebookKey = activeEditor 
      ? `activeProfile-${activeEditor.notebook.uri.toString()}`
      : null;
    const activeProfileContext = notebookKey 
      ? extensionContext?.globalState.get<any>(notebookKey)
      : null;

    return profiles.map(
      (profile) => {
        const isActive = activeProfileContext?.profileId === profile.id;
        return new ProfileTreeItem(profile, isActive, {
          command: 'postgres-explorer.switchConnectionProfile',
          title: 'Switch Profile',
          arguments: [profile.id],
        });
      }
    );
  }
}

/**
 * Tree view provider for saved queries
 */
export class SavedQueriesTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _expandedTags = new Set<string>();

  constructor() {}

  private _isTeamQuery(queryId: string): boolean {
    if (!extensionContext) {
      return false;
    }
    const entry = getSyncDataSource()?.getEntryById(queryId);
    return !!entry?.entry.spaceId?.startsWith('ws_');
  }

  private _personalQueries(queries: any[]): any[] {
    return queries.filter((q) => !this._isTeamQuery(q.id));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const service = SavedQueriesService.getInstance();
    const queries = this._personalQueries(service.getQueries());

    if (!element) {
      const items = queries.length ? await this._getRootItems(queries) : [];
      const sharedRoot = this._getSharedTeamRoot();
      if (sharedRoot) {
        return [sharedRoot, ...items];
      }
      if (!queries.length) {
        const noItemsItem = new vscode.TreeItem('No saved queries yet');
        noItemsItem.contextValue = 'emptySavedQueries';
        noItemsItem.iconPath = new vscode.ThemeIcon('info');
        return [noItemsItem];
      }
      return items;
    }

    if (element instanceof SharedTeamRootTreeItem) {
      return this._getWorkspaceFolders();
    }
    if (element instanceof WorkspaceFolderTreeItem) {
      return this._getSharedQueries(element.spaceId);
    }

    // If a TagTreeItem was clicked, return queries with that tag
    if (element instanceof TagTreeItem) {
      return queries
        .filter((q) => q.tags && q.tags.includes(element.tag))
        .map((q) => new SavedQueryTreeItem(q));
    }

    return [];
  }

  private _getSharedTeamRoot(): SharedTeamRootTreeItem | undefined {
    const teamQueries = (getSyncDataSource()?.listTeamItems() ?? [])
      .filter((i) => i.entry.kind === 'query');
    if (!teamQueries.length) {
      return undefined;
    }
    return new SharedTeamRootTreeItem(teamQueries.length);
  }

  private _getWorkspaceFolders(): WorkspaceFolderTreeItem[] {
    const grouped = groupTeamItemsByWorkspace(getSyncDataSource()?.listTeamItems() ?? [], 'query');
    return [...grouped.entries()].map(
      ([spaceId, items]) => new WorkspaceFolderTreeItem(spaceId, workspaceDisplayName(spaceId), items.length),
    );
  }

  private _getSharedQueries(spaceId: string): SavedQueryTreeItem[] {
    const service = SavedQueriesService.getInstance();
    const readOnly = isViewerForSpace(spaceId);
    const items: SavedQueryTreeItem[] = [];
    for (const { id, entry } of getSyncDataSource()?.listTeamItems() ?? []) {
      if (entry.kind !== 'query' || entry.spaceId !== spaceId) {
        continue;
      }
      const query = service.getQuery(id);
      if (query) {
        items.push(new SavedQueryTreeItem(query, readOnly));
      }
    }
    return items.sort((a, b) => a.query.title.localeCompare(b.query.title));
  }

  private _getRootItems(queries: any[]): vscode.TreeItem[] {
    // Collect all unique tags and their query counts
    const tagMap = new Map<string, any[]>();
    const untaggedQueries: any[] = [];

    for (const query of queries) {
      if (query.tags && query.tags.length > 0) {
        for (const tag of query.tags) {
          if (!tagMap.has(tag)) {
            tagMap.set(tag, []);
          }
          tagMap.get(tag)!.push(query);
        }
      } else {
        untaggedQueries.push(query);
      }
    }

    const items: vscode.TreeItem[] = [];

    // Add tag groups (sorted alphabetically)
    const sortedTags = Array.from(tagMap.keys()).sort();
    for (const tag of sortedTags) {
      const queryCount = tagMap.get(tag)!.length;
      items.push(new TagTreeItem(tag, queryCount));
    }

    // Add untagged queries section if there are any
    if (untaggedQueries.length > 0) {
      // Group untagged queries by database for better organization
      const dbMap = new Map<string, any[]>();
      for (const query of untaggedQueries) {
        const db = query.databaseName || 'No Database';
        if (!dbMap.has(db)) {
          dbMap.set(db, []);
        }
        dbMap.get(db)!.push(query);
      }

      // If only one database, just show the queries
      if (dbMap.size === 1) {
        const [, dbQueries] = Array.from(dbMap.entries())[0];
        items.push(...dbQueries.map(q => new SavedQueryTreeItem(q)));
      } else {
        // Show untagged queries (recent ones first, limit to 10)
        items.push(...untaggedQueries.slice(0, 10).map(q => new SavedQueryTreeItem(q)));
      }
    }

    return items;
  }
}

export class SavedQueriesDragAndDropController implements vscode.TreeDragAndDropController<SavedQueryTreeItem> {
  dragMimeTypes = ['application/vnd.code.tree.postgresExplorer', 'text/plain'];
  dropMimeTypes = [];

  handleDrag(
    source: readonly SavedQueryTreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    if (source.length === 0) { return; }
    const items = source.map(item => ({
      type: 'saved-query',
      queryId: item.query.id,
      label: item.query.title,
      connectionId: item.query.connectionId || '',
      databaseName: item.query.databaseName || '',
      schema: item.query.schemaName || '',
      tableName: '',
      columnName: '',
      comment: '',
    }));
    dataTransfer.set('application/vnd.code.tree.postgresExplorer', new vscode.DataTransferItem(JSON.stringify(items)));
    dataTransfer.set('text/plain', new vscode.DataTransferItem(items.map(i => i.label).join(', ')));
    setLastTreeDragPayload(items as any);
  }
}
