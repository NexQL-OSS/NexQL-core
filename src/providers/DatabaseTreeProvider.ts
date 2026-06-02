import { Client, PoolClient } from 'pg';
import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../services/ConnectionManager';
import { getSchemaCache, SchemaCache } from '../lib/schema-cache';
import { Debouncer } from '../lib/debounce';
import { AutoRefreshService } from '../services/AutoRefreshService';
import { buildTreeItemKey, buildTreeItemKeyFromParts } from './tree/treeItemKey';
import {
  PG_VERSION_10,
  PG_VERSION_11,
  queryServerVersionNum,
} from '../lib/postgresServerVersion';
import { ConnectionLoader } from './tree/loaders/ConnectionLoader';
import { DatabaseLoader } from './tree/loaders/DatabaseLoader';
import { SchemaLoader } from './tree/loaders/SchemaLoader';
import { TableLoader } from './tree/loaders/TableLoader';

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
      console.warn('TreeView not initialized for reveal');
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

      // Reveal with expand
      await this.treeView.reveal(connectionItem, { select: true, focus: true, expand: 1 });

      // If database is specified, try to expand and reveal it
      if (databaseName) {
        // TODO: Implement deeper reveal logic for database/schema/object
        // This would require fetching children and finding the exact item
        vscode.window.showInformationMessage(`Revealed connection: ${connection.name || connection.host}`);
      } else {
        vscode.window.showInformationMessage(`Revealed connection: ${connection.name || connection.host}`);
      }
    } catch (err) {
      console.error('Error revealing item:', err);
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

  markConnectionDisconnected(connectionId: string): void {
    this.disconnectedConnections.add(connectionId);
    // Fire a full refresh to update tree state and collapse items
    this._onDidChangeTreeData.fire(undefined);
    this._autoRefreshService?.onConnectionDisconnected(connectionId);
  }

  public markConnectionConnected(connectionId: string): void {
    this.disconnectedConnections.delete(connectionId);
    // Fire a full refresh to update tree state
    this._onDidChangeTreeData.fire(undefined);
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
      const groupedConnections: { [key: string]: any[] } = {};
      const ungroupedConnections: any[] = [];

      connections.forEach(conn => {
        if (conn.group) {
          if (!groupedConnections[conn.group]) {
            groupedConnections[conn.group] = [];
          }
          groupedConnections[conn.group].push(conn);
        } else {
          ungroupedConnections.push(conn);
        }
      });

      // Add groups first
      for (const groupName of Object.keys(groupedConnections).sort()) {
        rootItems.push(new DatabaseTreeItem(
          groupName,
          vscode.TreeItemCollapsibleState.Collapsed,
          'connection-group',
          undefined
        ));
      }

      // Add ungrouped connections
      ungroupedConnections.forEach(conn => {
        rootItems.push(new DatabaseTreeItem(
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
          conn.readOnlyMode // readOnlyMode
        ));
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

      const ctx = { provider: this, client, element, pgVer };

      // Connection/Databases/Favorites/Recent Loader
      if (
        element.type === 'connection' ||
        element.type === 'databases-group' ||
        element.type === 'system-databases-group' ||
        element.type === 'favorites-group' ||
        element.type === 'recent-group'
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

      // Table, View, Columns, Constraints, Indexes, RLS Policies, Partitions, FDW Loader
      if (
        element.type === 'table' ||
        element.type === 'view' ||
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
    public readonly type: 'connection' | 'database' | 'schema' | 'table' | 'view' | 'function' | 'procedure' | 'column' | 'category' | 'materialized-view' | 'type' | 'foreign-table' | 'extension' | 'role' | 'databases-group' | 'system-databases-group' | 'favorites-group' | 'recent-group' | 'constraint' | 'index' | 'foreign-data-wrapper' | 'foreign-server' | 'user-mapping' | 'connection-group' | 'trigger' | 'sequence' | 'partition' | 'domain' | 'aggregate' | 'event-trigger' | 'rule' | 'tablespace' | 'publication' | 'subscription' | 'cron-job' | 'policy',
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
  ) {
    super(label, collapsibleState);
    if (type === 'category' && label) {
      // Create specific context value for categories (e.g., category-tables, category-views)
      const suffix = label.toLowerCase().replace(/\s+&\s+/g, '-').replace(/\s+/g, '-');
      this.contextValue = `category-${suffix}`;
    } else if (type === 'connection' && isDisconnected) {
      this.contextValue = 'connection-disconnected';
    } else if (type === 'cron-job' && cronJobId === undefined) {
      this.contextValue = 'cron-setup';
    } else {
      // Keep original contextValue - isFavorite flag is stored separately for star indicator
      // For favorites menu detection, we use description containing ★
      this.contextValue = isInstalled ? `${type}-installed` : type;
    }
    this.tooltip = this.getTooltip(type, comment, roleAttributes, environment, readOnlyMode);
    this.description = this.getDescription(type, isInstalled, installedVersion, roleAttributes, isFavorite, count, rowCount, size, environment, readOnlyMode);
    this.iconPath = {
      connection: new vscode.ThemeIcon('plug', isDisconnected ? new vscode.ThemeColor('disabledForeground') : new vscode.ThemeColor('charts.blue')),
      database: new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.purple')),
      'databases-group': new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.purple')),
      'system-databases-group': new vscode.ThemeIcon('folder-library', new vscode.ThemeColor('charts.gray')),
      'favorites-group': new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow')),
      'recent-group': new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.green')),
      schema: new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.yellow')),
      table: new vscode.ThemeIcon('table', new vscode.ThemeColor('charts.blue')),
      view: new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.green')),
      function: new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.orange')),
      procedure: new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.red')),
      column: new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('charts.blue')),
      category: new vscode.ThemeIcon('list-tree'),
      'materialized-view': new vscode.ThemeIcon('symbol-structure', new vscode.ThemeColor('charts.green')),
      type: new vscode.ThemeIcon('symbol-type-parameter', new vscode.ThemeColor('charts.red')),
      'foreign-table': new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.blue')),
      extension: new vscode.ThemeIcon(isInstalled ? 'extensions-installed' : 'extensions', isInstalled ? new vscode.ThemeColor('charts.green') : undefined),
      role: new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.yellow')),
      constraint: new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.orange')),
      index: new vscode.ThemeIcon('search', new vscode.ThemeColor('charts.purple')),
      'foreign-data-wrapper': new vscode.ThemeIcon('extensions', new vscode.ThemeColor('charts.blue')),
      'foreign-server': new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.green')),
      'user-mapping': new vscode.ThemeIcon('account', new vscode.ThemeColor('charts.yellow')),
      'connection-group': new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue')),
      'trigger': new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.orange')),
      'sequence': new vscode.ThemeIcon('list-ordered', new vscode.ThemeColor('charts.blue')),
      'partition': new vscode.ThemeIcon('symbol-array', new vscode.ThemeColor('charts.purple')),
      'domain': new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.red')),
      'aggregate': new vscode.ThemeIcon('symbol-operator', new vscode.ThemeColor('charts.green')),
      'event-trigger': new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('charts.orange')),
      'rule': new vscode.ThemeIcon('law', new vscode.ThemeColor('charts.yellow')),
      'tablespace': new vscode.ThemeIcon('folder-library', new vscode.ThemeColor('charts.blue')),
      'publication': new vscode.ThemeIcon('rss', new vscode.ThemeColor('charts.green')),
      'subscription': new vscode.ThemeIcon('inbox', new vscode.ThemeColor('charts.purple')),
      'cron-job': new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.orange')),
      policy: new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.green')),
    }[type];
  }

  private getTooltip(type: string, comment?: string, roleAttributes?: { [key: string]: boolean }, environment?: string, readOnlyMode?: boolean): string {
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

    if (type === 'connection') {
      const badges = [];
      if (environment === 'production') {
        badges.push('🔴 PROD');
      } else if (environment === 'staging') {
        badges.push('🟡 STAGING');
      } else if (environment === 'development') {
        badges.push('🟢 DEV');
      }
      if (readOnlyMode) {
        badges.push('🔒');
      }
      return badges.length > 0 ? badges.join(' ') : undefined;
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
