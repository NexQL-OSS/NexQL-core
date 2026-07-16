import { Client, PoolClient } from 'pg';
import * as vscode from 'vscode';
import { debugWarn } from '../common/logger';
import { setLastTreeDragPayload } from './chat/dragPayloadStore';
import * as path from 'path';
import { ConnectionManager } from '../services/ConnectionManager';
import { getSchemaCache, SchemaCache } from '../lib/schema-cache';
import { Debouncer } from '../lib/debounce';
import { AutoRefreshService } from '../services/AutoRefreshService';
import { buildTreeItemKey, buildTreeItemKeyFromParts } from './tree/treeItemKey';
import { formatConnectionEnvBadge, getDatabaseTreeIcon } from './tree/treeIconTheme';
import { PlatformConnectionService } from '../services/PlatformConnectionService';
import { profileDisplayLabel } from '../lib/platform/PlatformProfile';
import {
  PG_VERSION_10,
  PG_VERSION_11,
  queryServerVersionNum,
} from '../lib/postgresServerVersion';
import { ConnectionLoader } from './tree/loaders/ConnectionLoader';
import { DatabaseLoader } from './tree/loaders/DatabaseLoader';
import { SchemaLoader } from './tree/loaders/SchemaLoader';
import { TableLoader } from './tree/loaders/TableLoader';
import { LicenseService } from '../services/LicenseService';

const buildItemKey = buildTreeItemKey;

const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);

export class DatabaseTreeProvider implements vscode.TreeDataProvider<DatabaseTreeItem> {
  private readonly connectionLoader = new ConnectionLoader();
  private readonly databaseLoader = new DatabaseLoader();
  private readonly schemaLoader = new SchemaLoader();
  private readonly tableLoader = new TableLoader();

  private _onDidChangeTreeData: vscode.EventEmitter<DatabaseTreeItem | undefined | null | void> = new vscode.EventEmitter<DatabaseTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DatabaseTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  private disconnectedConnections: Set<string> = new Set();
  private readonly _cache: SchemaCache = getSchemaCache();
  private readonly debouncer = new Debouncer();
  private treeView?: vscode.TreeView<DatabaseTreeItem>;
  private _autoRefreshService: AutoRefreshService | undefined;
  /** Cached `SHOW server_version_num` per connection (invalidated on full tree refresh). */
  private readonly _serverVersionByConnection = new Map<string, number>();

  // Filter, Favorites, and Recent Items
  private _favorites: Set<string> = new Set();
  private _recentItems: string[] = [];
  private static readonly MAX_RECENT_ITEMS = 10;
  private static readonly FAVORITES_KEY = 'postgresExplorer.favorites';
  private static readonly RECENT_KEY = 'postgresExplorer.recentItems';
  
  // Virtualization support - only render visible items
  private static readonly VIRTUALIZATION_THRESHOLD = 100; // Use virtual scrolling for 100+ items
  private visibleRange?: vscode.TreeViewExpansionEvent<DatabaseTreeItem>;

  constructor(private readonly extensionContext: vscode.ExtensionContext) {
    // Initialize all connections as disconnected by default
    this.initializeDisconnectedState();
    // Load persisted favorites and recent items
    this.loadPersistedData();
  }

  /**
   * Set the tree view instance for reveal functionality
   */
  public setTreeView(treeView: vscode.TreeView<DatabaseTreeItem>): void {
    this.treeView = treeView;
  }

  setAutoRefreshService(service: AutoRefreshService): void {
    this._autoRefreshService = service;
  }

  /**
   * Reveal an item in the tree view
   */
  public async revealItem(connectionId: string, databaseName?: string, schema?: string, objectName?: string, objectType?: string): Promise<void> {
    if (!this.treeView) {
      debugWarn('TreeView not initialized for reveal');
      return;
    }

    try {
      // Focus the tree view first
      await vscode.commands.executeCommand('postgresExplorer.focus');

      // Find the item to reveal
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const connection = connections.find(c => c.id === connectionId);
      
      if (!connection) {
        vscode.window.showWarningMessage('Connection not found');
        return;
      }

      // Create the connection item
      const connectionItem = new DatabaseTreeItem(
        connection.name || `${connection.host}:${connection.port}`,
        vscode.TreeItemCollapsibleState.Collapsed,
        'connection',
        connectionId
      );

      // Reveal and expand the connection. Deeper levels (database/schema/object)
      // need TreeDataProvider.getParent to build a reveal path, which this tree
      // does not implement; expanding the connection lets the user drill in from
      // a focused, scrolled-into-view starting point without a misleading popup.
      await this.treeView.reveal(connectionItem, { select: true, focus: true, expand: databaseName ? 3 : 1 });
    } catch (err) {
      debugWarn('Error revealing item:', err);
      vscode.window.showWarningMessage('Could not reveal item in explorer');
    }
  }

  private loadPersistedData(): void {
    const favorites = this.extensionContext.globalState.get<string[]>(DatabaseTreeProvider.FAVORITES_KEY, []);
    this._favorites = new Set(favorites);
    this._recentItems = this.extensionContext.globalState.get<string[]>(DatabaseTreeProvider.RECENT_KEY, []);
  }

  private async saveFavorites(): Promise<void> {
    await this.extensionContext.globalState.update(DatabaseTreeProvider.FAVORITES_KEY, Array.from(this._favorites));
  }

  private async saveRecentItems(): Promise<void> {
    await this.extensionContext.globalState.update(DatabaseTreeProvider.RECENT_KEY, this._recentItems);
  }

  // Favorites methods
  isFavorite(item: DatabaseTreeItem): boolean {
    return this._favorites.has(buildItemKey(item));
  }

  async addToFavorites(item: DatabaseTreeItem): Promise<void> {
    const key = buildItemKey(item);
    this._favorites.add(key);
    await this.saveFavorites();
    this.refresh();
    vscode.window.showInformationMessage(`Added "${item.label}" to favorites`);
  }

  async removeFromFavorites(item: DatabaseTreeItem): Promise<void> {
    const key = buildItemKey(item);
    this._favorites.delete(key);
    await this.saveFavorites();
    this.refresh();
    vscode.window.showInformationMessage(`Removed "${item.label}" from favorites`);
  }

  getFavoriteKeys(): string[] {
    return Array.from(this._favorites);
  }

  // Recent items methods
  async addToRecent(item: DatabaseTreeItem): Promise<void> {
    const key = buildItemKey(item);
    // Remove if already exists (to move to front)
    this._recentItems = this._recentItems.filter(k => k !== key);
    // Add to front
    this._recentItems.unshift(key);
    // Trim to max size
    if (this._recentItems.length > DatabaseTreeProvider.MAX_RECENT_ITEMS) {
      this._recentItems = this._recentItems.slice(0, DatabaseTreeProvider.MAX_RECENT_ITEMS);
    }
    await this.saveRecentItems();
  }

  getRecentKeys(): string[] {
    return [...this._recentItems];
  }

  public isFavoriteItem(type: string, connectionId?: string, databaseName?: string, schema?: string, name?: string): boolean {
    const key = buildTreeItemKeyFromParts(type, connectionId, databaseName, schema, name);
    return this._favorites.has(key);
  }

  private initializeDisconnectedState(): void {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    connections.forEach(conn => {
      this.disconnectedConnections.add(conn.id);
    });
  }

  private _getConnectionItem(connectionId: string): DatabaseTreeItem | undefined {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return undefined;

    return new DatabaseTreeItem(
      conn.name || `${conn.host}:${conn.port}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      'connection',
      conn.id,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
      this.disconnectedConnections.has(conn.id),
      undefined, undefined, undefined, undefined,
      conn.environment,
      conn.readOnlyMode,
      undefined, undefined, undefined, undefined,
      conn.color
    );
  }

  markConnectionDisconnected(connectionId: string): void {
    this.disconnectedConnections.add(connectionId);
    this._cache.invalidateConnection(connectionId);
    const item = this._getConnectionItem(connectionId);
    this._onDidChangeTreeData.fire(item);
    this._autoRefreshService?.onConnectionDisconnected(connectionId);
  }

  public markConnectionConnected(connectionId: string): void {
    this.disconnectedConnections.delete(connectionId);
    this._cache.invalidateConnection(connectionId);
    const item = this._getConnectionItem(connectionId);
    this._onDidChangeTreeData.fire(item);
    this._autoRefreshService?.onConnectionConnected(connectionId);
  }

  private async getCachedServerVersion(connectionId: string, client: PoolClient): Promise<number> {
    const cached = this._serverVersionByConnection.get(connectionId);
    if (cached !== undefined) {
      return cached;
    }
    const v = await queryServerVersionNum(client);
    this._serverVersionByConnection.set(connectionId, v);
    return v;
  }

  /**
   * Get database objects (tables, views, functions, procedures) for a connection
   * Used by AI Generate Query feature to provide schema context
   */
  public async getDbObjectsForConnection(connection: any): Promise<Array<{ type: string, schema: string, name: string, columns?: string[] }>> {
    const client = await ConnectionManager.getInstance().getPooledClient({
      ...connection,
      id: connection.id,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      database: connection.database,
      name: connection.name
    });

    try {
      const pgVer = await queryServerVersionNum(client);
      const objects: Array<{ type: string, schema: string, name: string, columns?: string[] }> = [];

      // Fetch tables with columns
      const tablesQuery = `
        SELECT 
          t.table_schema,
          t.table_name,
          array_agg(c.column_name ORDER BY c.ordinal_position) as columns
        FROM information_schema.tables t
        LEFT JOIN information_schema.columns c 
          ON t.table_schema = c.table_schema 
          AND t.table_name = c.table_name
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND t.table_type = 'BASE TABLE'
        GROUP BY t.table_schema, t.table_name
        ORDER BY t.table_schema, t.table_name
        LIMIT 100
      `;

      const tablesResult = await client.query(tablesQuery);
      tablesResult.rows.forEach((row: any) => {
        objects.push({
          type: 'table',
          schema: row.table_schema,
          name: row.table_name,
          columns: row.columns
        });
      });

      // Fetch views with columns
      const viewsQuery = `
        SELECT 
          t.table_schema,
          t.table_name,
          array_agg(c.column_name ORDER BY c.ordinal_position) as columns
        FROM information_schema.tables t
        LEFT JOIN information_schema.columns c 
          ON t.table_schema = c.table_schema 
          AND t.table_name = c.table_name
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND t.table_type = 'VIEW'
        GROUP BY t.table_schema, t.table_name
        ORDER BY t.table_schema, t.table_name
        LIMIT 50
      `;

      const viewsResult = await client.query(viewsQuery);
      viewsResult.rows.forEach((row: any) => {
        objects.push({
          type: 'view',
          schema: row.table_schema,
          name: row.table_name,
          columns: row.columns
        });
      });

      // Fetch functions (pg_proc.prokind is PostgreSQL 11+)
      const functionsQuery =
        pgVer >= PG_VERSION_11
          ? `
        SELECT 
          n.nspname as schema_name,
          p.proname as function_name
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND p.prokind = 'f'
        ORDER BY n.nspname, p.proname
        LIMIT 50
      `
          : `
        SELECT 
          n.nspname as schema_name,
          p.proname as function_name
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND NOT p.proisagg
        ORDER BY n.nspname, p.proname
        LIMIT 50
      `;

      const functionsResult = await client.query(functionsQuery);
      functionsResult.rows.forEach((row: any) => {
        objects.push({
          type: 'function',
          schema: row.schema_name,
          name: row.function_name
        });
      });

      // Fetch procedures (SQL procedures are PostgreSQL 11+)
      if (pgVer >= PG_VERSION_11) {
        const proceduresQuery = `
        SELECT 
          n.nspname as schema_name,
          p.proname as procedure_name
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND p.prokind = 'p'
        ORDER BY n.nspname, p.proname
        LIMIT 50
      `;

        const proceduresResult = await client.query(proceduresQuery);
        proceduresResult.rows.forEach((row: any) => {
          objects.push({
            type: 'procedure',
            schema: row.schema_name,
            name: row.procedure_name
          });
        });
      }

      return objects;
    } finally {
      client.release();
    }
  }

  refresh(element?: DatabaseTreeItem): void {
    // Debounce tree refresh to prevent excessive updates during rapid operations
    this.debouncer.debounce('tree-refresh', () => {
      // Clear cache on manual refresh to ensure fresh data
      if (!element) {
        this._cache.clear();
        this._serverVersionByConnection.clear();
      } else if (element.connectionId && element.databaseName) {
        this._cache.invalidateDatabase(element.connectionId, element.databaseName);
      } else if (element.connectionId) {
        this._cache.invalidateConnection(element.connectionId);
      }
      void import('./SqlCompletionProvider').then(({ SqlCompletionProvider }) => {
        const completion = SqlCompletionProvider.getInstance();
        if (!completion) {
          return;
        }
        if (!element) {
          completion.invalidateAll();
        } else if (element.connectionId && element.databaseName) {
          completion.invalidate(element.connectionId, element.databaseName);
        } else if (element.connectionId) {
          completion.invalidate(element.connectionId);
        }
      });
      this._onDidChangeTreeData.fire(element);
    }, 300); // Debounce for 300ms to batch rapid updates
  }

  collapseAll(): void {
    // This will trigger a refresh of the tree view with all items collapsed
    this._onDidChangeTreeData.fire();
  }

  /**
   * Apply virtual rendering for large item collections
   * Returns only visible items based on virtualization threshold
   */
  private applyVirtualization(items: DatabaseTreeItem[]): DatabaseTreeItem[] {
    if (items.length < DatabaseTreeProvider.VIRTUALIZATION_THRESHOLD) {
      return items;
    }

    // For very large collections, could implement viewport-based filtering
    // For now, return all items but sorted by relevance (favorites/recent first)
    const sorted = [...items];
    sorted.sort((a, b) => {
      const aFav = this._favorites.has(buildItemKey(a)) ? 0 : 1;
      const bFav = this._favorites.has(buildItemKey(b)) ? 0 : 1;
      const aRecent = this._recentItems.includes(buildItemKey(a)) ? 0 : 1;
      const bRecent = this._recentItems.includes(buildItemKey(b)) ? 0 : 1;

      // Prioritize: favorites > recent > others
      const aScore = aFav * 2 + aRecent;
      const bScore = bFav * 2 + bRecent;
      return aScore - bScore;
    });

    return sorted;
  }

  getTreeItem(element: DatabaseTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];

    if (!element) {
      // Root level - show connections (grouped if configured)
      const rootItems: DatabaseTreeItem[] = [];

      // Add subscription badge if user is subscribed to Sponsor or Team
      const tier = LicenseService.getInstance().getTier();
      if (tier === 'sponsor' || tier === 'singularity') {
        const badgeLabel = tier === 'sponsor' ? 'NexQL Sponsor' : 'NexQL Team';
        const badgeType = tier === 'sponsor' ? 'sponsor-badge' : 'team-badge';
        const badgeItem = new DatabaseTreeItem(
          badgeLabel,
          vscode.TreeItemCollapsibleState.None,
          badgeType
        );
        badgeItem.command = {
          command: 'postgres-explorer.license.manage',
          title: 'Manage License'
        };
        rootItems.push(badgeItem);
      }

      const createConnectionItem = (conn: any, isPinned = false) => {
        const item = new DatabaseTreeItem(
          conn.name || `${conn.host}:${conn.port}`,
          vscode.TreeItemCollapsibleState.Collapsed,
          'connection',
          conn.id,
          undefined, // databaseName
          undefined, // schema
          undefined, // tableName
          undefined, // columnName
          undefined, // comment
          undefined, // isInstalled
          undefined, // installedVersion
          undefined, // roleAttributes
          this.disconnectedConnections.has(conn.id), // isDisconnected
          undefined, // isFavorite
          undefined, // count
          undefined, // rowCount
          undefined, // size
          conn.environment, // environment
          conn.readOnlyMode, // readOnlyMode
          undefined, // cronJobId
          undefined, // cronSchedule
          undefined, // cronJobActive
          undefined, // capabilityTags
          conn.color // color
        );
        if (isPinned) {
          if (item.contextValue === 'connection-disconnected') {
            item.contextValue = 'connection-pinned-disconnected';
          } else {
            item.contextValue = 'connection-pinned';
          }
          item.description = item.description ? `📌 Pinned · ${item.description}` : '📌 Pinned';
        }
        const platformSuffix =
          PlatformConnectionService.getInstance().connectionTooltipSuffix(conn);
        item.tooltip = item.tooltip
          ? `${item.tooltip}\n${platformSuffix}`
          : platformSuffix;
        const profile =
          PlatformConnectionService.getInstance().getEstimatedProfile(conn);
        if (profile.platform !== 'vanilla') {
          const platformLabel = profileDisplayLabel(profile);
          item.description = item.description
            ? `${item.description} · ${platformLabel}`
            : platformLabel;
        }
        return item;
      };

      const pinnedIds = this.extensionContext.globalState.get<string[]>('postgresExplorer.pinnedConnections', []);
      const pinnedSet = new Set(pinnedIds);

      // Add pinned connections first
      connections.forEach(conn => {
        if (pinnedSet.has(conn.id)) {
          rootItems.push(createConnectionItem(conn, true));
        }
      });

      const groupedConnections: { [key: string]: any[] } = {};
      const ungroupedConnections: any[] = [];

      connections.forEach(conn => {
        if (pinnedSet.has(conn.id)) {
          return;
        }
        if (conn.group) {
          if (!groupedConnections[conn.group]) {
            groupedConnections[conn.group] = [];
          }
          groupedConnections[conn.group].push(conn);
        } else {
          ungroupedConnections.push(conn);
        }
      });

      // Add groups next
      for (const groupName of Object.keys(groupedConnections).sort()) {
        rootItems.push(new DatabaseTreeItem(
          groupName,
          vscode.TreeItemCollapsibleState.Collapsed,
          'connection-group',
          undefined
        ));
      }

      // Add ungrouped unpinned connections
      ungroupedConnections.forEach(conn => {
        rootItems.push(createConnectionItem(conn, false));
      });

      return rootItems;
    }

    if (element.type === 'connection' && element.connectionId && this.disconnectedConnections.has(element.connectionId)) {
      this.markConnectionConnected(element.connectionId);
    }

    if (element.type === 'connection-group') {
      return this.connectionLoader.getConnectionGroupChildren(this, element);
    }

    const connection = connections.find(c => c.id === element.connectionId);
    if (!connection) {
      vscode.window.showErrorMessage('Connection not found');
      return [];
    }

    let client: PoolClient | undefined;
    try {
      const dbName = element.databaseName || connection.database || 'postgres';

      client = await ConnectionManager.getInstance().getPooledClient({
        ...connection,
        database: dbName,
      });

      const pgVer =
        element.connectionId != null
          ? await this.getCachedServerVersion(element.connectionId, client)
          : PG_VERSION_11;

      await PlatformConnectionService.getInstance().probeIfNeeded(
        { ...connection, database: dbName },
        client,
      );
      const platformProfile = PlatformConnectionService.getInstance().getProfile(
        element.connectionId!,
        dbName,
      );

      const ctx = { provider: this, client, element, pgVer, platformProfile };

      // Connection/Databases/Favorites/Recent Loader
      if (
        element.type === 'connection' ||
        element.type === 'databases-group' ||
        element.type === 'system-databases-group' ||
        element.type === 'favorites-group' ||
        element.type === 'recent-group' ||
        element.type === 'connection-notebooks-folder' ||
        element.type === 'connection-notebooks-db' ||
        element.type === 'connection-saved-queries-folder' ||
        element.type === 'connection-saved-queries-db' ||
        element.type === 'connection-query-history-folder' ||
        element.type === 'connection-query-history-db'
      ) {
        return await this.connectionLoader.getChildren(ctx);
      }

      // Database and database-level categories Loader
      if (
        element.type === 'database' ||
        (element.type === 'category' && !element.schema && !element.tableName)
      ) {
        return await this.databaseLoader.getChildren(ctx);
      }

      // Schema and schema-level categories Loader
      if (
        element.type === 'schema' ||
        (element.type === 'category' && element.schema && !element.tableName)
      ) {
        return await this.schemaLoader.getChildren(ctx);
      }

      // Table, View, Materialized View, Columns, Constraints, Indexes, RLS Policies, Partitions, FDW Loader
      if (
        element.type === 'table' ||
        element.type === 'view' ||
        element.type === 'materialized-view' ||
        element.type === 'foreign-data-wrapper' ||
        element.type === 'foreign-server' ||
        (element.type === 'category' && element.tableName)
      ) {
        return await this.tableLoader.getChildren(ctx);
      }

      return [];
    } catch (err: any) {
      const errorMessage = err.message || err.toString() || 'Unknown error';
      const errorCode = err.code || 'NO_CODE';
      const errorDetails = `Error getting tree items for ${element?.type || 'root'}: [${errorCode}] ${errorMessage} `;

      console.error(errorDetails);
      console.error('Full error:', err);

      // Only show error message to user if it's not a connection initialization issue
      if (element && element.type !== 'connection') {
        vscode.window.showErrorMessage(`Failed to get tree items: ${errorMessage} `);
      }

      return [];
    } finally {
      // Release the pooled client
      if (client) {
        try {
          client.release();
        } catch (e) { console.error('Error releasing client', e); }
      }
    }
  }
}

export class DatabaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: 'connection' | 'database' | 'schema' | 'table' | 'view' | 'function' | 'procedure' | 'column' | 'category' | 'materialized-view' | 'type' | 'foreign-table' | 'extension' | 'role' | 'databases-group' | 'system-databases-group' | 'favorites-group' | 'recent-group' | 'constraint' | 'index' | 'foreign-data-wrapper' | 'foreign-server' | 'user-mapping' | 'connection-group' | 'trigger' | 'sequence' | 'partition' | 'domain' | 'aggregate' | 'event-trigger' | 'rule' | 'tablespace' | 'publication' | 'subscription' | 'cron-job' | 'policy' | 'sponsor-badge' | 'team-badge' | 'connection-notebooks-folder' | 'connection-notebooks-db' | 'connection-notebook-file' | 'connection-saved-queries-folder' | 'connection-saved-queries-db' | 'connection-saved-query-item' | 'connection-query-history-folder' | 'connection-query-history-db' | 'connection-query-history-item',
    public readonly connectionId?: string,
    public readonly databaseName?: string,
    public readonly schema?: string,
    public readonly tableName?: string,
    public readonly columnName?: string,
    public readonly comment?: string,
    public readonly isInstalled?: boolean,
    public readonly installedVersion?: string,
    public readonly roleAttributes?: { [key: string]: boolean },
    public readonly isDisconnected?: boolean,
    public readonly isFavorite?: boolean,
    public readonly count?: number,  // For category item counts
    public readonly rowCount?: string | number, // Data row count
    public readonly size?: string,   // Data size
    public readonly environment?: 'production' | 'staging' | 'development',  // Environment tag
    public readonly readOnlyMode?: boolean,  // Read-only mode flag
    public readonly cronJobId?: number,
    public readonly cronSchedule?: string,
    public readonly cronJobActive?: boolean,
    public readonly capabilityTags?: string[],
    public readonly color?: 'red' | 'orange' | 'blue' | 'green' | 'gray',
  ) {
    super(label, collapsibleState);
    if (type === 'connection' && connectionId) {
      this.id = connectionId;
    }
    if (type === 'category' && label) {
      // Create specific context value for categories (e.g., category-tables, category-views)
      const suffix = label.toLowerCase().replace(/\s+&\s+/g, '-').replace(/\s+/g, '-');
      this.contextValue = `category-${suffix}`;
    } else if (type === 'connection' && isDisconnected) {
      this.contextValue = 'connection-disconnected';
    } else if (type === 'cron-job' && cronJobId === undefined) {
      this.contextValue = 'cron-setup';
    } else {
      let contextValue = isInstalled ? `${type}-installed` : type;
      if (capabilityTags?.length) {
        contextValue += `:${capabilityTags.join(':')}`;
      }
      this.contextValue = contextValue;
    }
    this.tooltip = this.getTooltip(type, comment, roleAttributes, environment, readOnlyMode);
    this.description = this.getDescription(type, isInstalled, installedVersion, roleAttributes, isFavorite, count, rowCount, size, environment, readOnlyMode);
    this.iconPath = getDatabaseTreeIcon(type, {
      isDisconnected,
      isInstalled,
      color,
      label: this.label,
    });
  }

  private getTooltip(type: string, comment?: string, roleAttributes?: { [key: string]: boolean }, environment?: string, readOnlyMode?: boolean): string {
    if (type === 'sponsor-badge') {
      return 'NexQL Sponsor — License Active';
    }
    if (type === 'team-badge') {
      return 'NexQL Team — License Active';
    }
    if (type === 'connection') {
      const parts = [this.label];
      if (environment) {
        parts.push(`\nEnvironment: ${environment.charAt(0).toUpperCase() + environment.slice(1)}`);
      }
      if (readOnlyMode) {
        parts.push('\nMode: Read-Only');
      }
      return parts.join('');
    }
    if (type === 'role' && roleAttributes) {
      const attributes = [];
      if (roleAttributes.rolsuper) attributes.push('Superuser');
      if (roleAttributes.rolcreatedb) attributes.push('Create DB');
      if (roleAttributes.rolcreaterole) attributes.push('Create Role');
      if (roleAttributes.rolcanlogin) attributes.push('Can Login');
      return `${this.label} \n\nAttributes: \n${attributes.join('\n')}`;
    }
    return comment ? `${this.label} \n\n${comment}` : this.label;
  }

  private getDescription(type: string, isInstalled?: boolean, installedVersion?: string, roleAttributes?: { [key: string]: boolean }, isFavorite?: boolean, count?: number, rowCount?: string | number, size?: string, environment?: string, readOnlyMode?: boolean): string | undefined {
    let desc: string | undefined = undefined;

    if (type === 'sponsor-badge' || type === 'team-badge') {
      return 'Active';
    }

    if (type === 'connection') {
      return formatConnectionEnvBadge(
        environment as 'production' | 'staging' | 'development' | undefined,
        readOnlyMode,
      );
    } else if (type === 'extension' && isInstalled) {
      desc = `v${installedVersion} (installed)`;
    } else if (type === 'role' && roleAttributes) {
      const tags = [];
      if (roleAttributes.rolsuper) tags.push('superuser');
      if (roleAttributes.rolcanlogin) tags.push('login');
      desc = tags.length > 0 ? `(${tags.join(', ')})` : undefined;
    } else if ((type === 'table' || type === 'materialized-view') && (rowCount !== undefined || size)) {
      const parts = [];
      if (rowCount !== undefined && rowCount !== null) {
        // Handle -1 for never analyzed tables
        const countVal = Number(rowCount);
        if (countVal >= 0) {
          parts.push(`${countVal} rows`);
        } else {
          // Optional: show "Not analyzed" or just size. 
          // If -1, it usually means empty or not analyzed.
          // Let's hide rows if negative
        }
      }
      if (size) parts.push(size);

      if (parts.length > 0) {
        desc = parts.join(', ');
      }
    } else if ((type === 'database' || type === 'schema') && size) {
      desc = size;
    } else if (type === 'category' && count !== undefined && this.label === 'Extensions') {
      desc = `• ${count} installed`;
    } else if (type === 'category' && count !== undefined && this.label === 'Cron Jobs') {
      desc = `• ${count} job${Number(count) === 1 ? '' : 's'}`;
    } else if ((type === 'category' || type === 'databases-group') && count !== undefined) {
      desc = `• ${count}`;
    } else if (type === 'cron-job' && this.cronSchedule) {
      desc = `${this.cronSchedule} · ${this.cronJobActive === false ? 'paused' : 'active'}`;
    } else if (type === 'cron-job' && !this.cronSchedule) {
      desc = 'not installed';
    }

    // Append muted star for favorites (★ is more subtle than ⭐)
    if (isFavorite) {
      return desc ? `${desc} ★` : '★';
    }
    return desc;
  }
}

export class DatabaseDragAndDropController implements vscode.TreeDragAndDropController<DatabaseTreeItem> {
  private static readonly DRAG_MIME = 'application/vnd.code.tree.postgresExplorer';
  dragMimeTypes = [DatabaseDragAndDropController.DRAG_MIME, 'text/plain'];
  dropMimeTypes = ['application/vnd.code.tree.postgresExplorer.notebooks'];

  constructor(
    private readonly provider: DatabaseTreeProvider,
    private readonly context: vscode.ExtensionContext
  ) {}

  private static readonly DRAGGABLE_TYPES = new Set([
    'connection', 'database', 'schema', 'table', 'partition', 'view', 'function', 'procedure',
    'materialized-view', 'type', 'foreign-table', 'column', 'sequence', 'domain', 'trigger',
    'index', 'constraint', 'extension', 'policy', 'rule', 'aggregate', 'foreign-data-wrapper',
    'foreign-server', 'event-trigger',
  ]);

  handleDrag(
    source: readonly DatabaseTreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    const items = source.filter(item => item.connectionId && DatabaseDragAndDropController.DRAGGABLE_TYPES.has(item.type));
    if (items.length === 0) {
      return;
    }

    const serialized = items.map(item => ({
      type: item.type,
      connectionId: item.connectionId!,
      databaseName: item.databaseName,
      schema: item.schema,
      tableName: item.tableName,
      columnName: item.columnName,
      label: item.label,
      comment: item.comment,
    }));

    setLastTreeDragPayload(serialized);

    dataTransfer.set(
      DatabaseDragAndDropController.DRAG_MIME,
      new vscode.DataTransferItem(JSON.stringify(serialized))
    );

    const textParts = items.map(item => {
      if (item.type === 'column' && item.tableName && item.columnName) {
        return `${item.tableName}.${item.columnName}`;
      }
      if (item.type === 'connection' || item.type === 'database') {
        return item.label;
      }
      if ((item.type === 'function' || item.type === 'procedure' || item.type === 'aggregate') && item.comment) {
        return `${item.schema || 'public'}.${item.label}(${item.comment})`;
      }
      return `${item.schema || 'public'}.${item.label}`;
    });

    // text/plain fallback for drops onto plain text targets (e.g. a notebook cell/editor).
    // The chat webview reads the JSON straight off DRAG_MIME instead — text/plain does NOT
    // survive the tree → webview drag bridge, only the declared custom mime type does.
    dataTransfer.set(
      'text/plain',
      new vscode.DataTransferItem(textParts.join(' '))
    );
  }

  async handleDrop(
    target: DatabaseTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!target || !target.connectionId) {
      return;
    }

    const item = dataTransfer.get('application/vnd.code.tree.postgresExplorer.notebooks');
    if (!item) {
      return;
    }

    const urisStr = await item.asString();
    if (!urisStr) return;

    let uris: string[] = [];
    try {
      uris = JSON.parse(urisStr);
    } catch {
      uris = urisStr.split(',');
    }

    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const connection = connections.find(c => c.id === target.connectionId);
    if (!connection) {
      vscode.window.showErrorMessage('Target connection configuration not found.');
      return;
    }

    const dbName = target.databaseName || connection.database || 'postgres';
    const { NotebookIndexService } = require('../services/NotebookIndexService');
    const indexService = NotebookIndexService.getInstance();
    const safeConnectionName = (connection.name || connection.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeDatabaseName = dbName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const destFolder = vscode.Uri.joinPath(this.context.globalStorageUri, safeConnectionName, safeDatabaseName);

    try {
      await vscode.workspace.fs.createDirectory(destFolder);
    } catch (err) {
      // Ignore directory exists/creation errors
    }

    for (const uriStr of uris) {
      const sourceUri = vscode.Uri.parse(uriStr);
      const filename = path.basename(sourceUri.fsPath);
      const destUri = vscode.Uri.joinPath(destFolder, filename);

      if (sourceUri.fsPath === destUri.fsPath) {
        continue;
      }

      try {
        await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: false });
        const raw = await vscode.workspace.fs.readFile(destUri);
        const data = JSON.parse(Buffer.from(raw).toString());

        const fileMetadata = {
          connectionId: connection.id,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          database: dbName,
          databaseName: dbName,
          title: connection.name && dbName ? `${connection.name}-${dbName}` : dbName,
        };

        data.metadata = {
          ...data.metadata,
          ...fileMetadata,
          custom: {
            cells: data.metadata?.custom?.cells || [],
            metadata: {
              ...fileMetadata,
              enableScripts: true
            }
          }
        };

        await vscode.workspace.fs.writeFile(destUri, Buffer.from(JSON.stringify(data)));
        indexService.removeNotebook(sourceUri);
        await indexService.updateNotebook(destUri);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to move notebook "${filename}": ${err.message}`);
      }
    }

    this.provider.refresh();
    vscode.commands.executeCommand('postgres-explorer.notebooks.refresh');
    vscode.window.showInformationMessage('Notebook reassigned to connection.');
  }
}
