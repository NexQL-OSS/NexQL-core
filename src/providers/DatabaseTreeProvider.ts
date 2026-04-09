import { Client, PoolClient } from 'pg';
import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../services/ConnectionManager';
import { getSchemaCache, SchemaCache } from '../lib/schema-cache';
import { Debouncer } from '../lib/debounce';
import { AutoRefreshService } from '../services/AutoRefreshService';

function buildItemKey(item: DatabaseTreeItem): string {
  return [item.type, item.connectionId || '', item.databaseName || '', item.schema || '', item.label].join(':');
}

export class DatabaseTreeProvider implements vscode.TreeDataProvider<DatabaseTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<DatabaseTreeItem | undefined | null | void> = new vscode.EventEmitter<DatabaseTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DatabaseTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  private disconnectedConnections: Set<string> = new Set();
  private readonly _cache: SchemaCache = getSchemaCache();
  private readonly debouncer = new Debouncer();
  private treeView?: vscode.TreeView<DatabaseTreeItem>;
  private _autoRefreshService: AutoRefreshService | undefined;

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

  private isFavoriteItem(type: string, connectionId?: string, databaseName?: string, schema?: string, name?: string): boolean {
    const key = `${type}:${connectionId || ''}:${databaseName || ''}:${schema || ''}:${name || ''} `;
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

  /**
   * Get database objects (tables, views, functions) for a connection
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

      // Fetch functions
      const functionsQuery = `
        SELECT 
          n.nspname as schema_name,
          p.proname as function_name
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
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
      } else if (element.connectionId && element.databaseName) {
        this._cache.invalidateDatabase(element.connectionId, element.databaseName);
      } else if (element.connectionId) {
        this._cache.invalidateConnection(element.connectionId);
      }
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

    if (element.type === 'connection-group') {
      const groupName = element.label;
      const groupConnections = connections.filter(c => c.group === groupName);

      return groupConnections.map(conn => new DatabaseTreeItem(
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
    }

    if (element.type === 'connection' && element.connectionId && this.disconnectedConnections.has(element.connectionId)) {
      this.markConnectionConnected(element.connectionId);
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


      switch (element.type) {
        case 'connection':
          const items: DatabaseTreeItem[] = [];

          const connectionFavorites = this.getFavoriteKeys().filter(key => key.split(':')[1] === element.connectionId);
          if (connectionFavorites.length > 0) {
            items.push(new DatabaseTreeItem('Favorites', vscode.TreeItemCollapsibleState.Collapsed, 'favorites-group', element.connectionId));
          }

          const connectionRecent = this.getRecentKeys().filter(key => key.split(':')[1] === element.connectionId);
          if (connectionRecent.length > 0) {
            items.push(new DatabaseTreeItem('Recent', vscode.TreeItemCollapsibleState.Collapsed, 'recent-group', element.connectionId));
          }

          const dbCountResult = await client.query('SELECT COUNT(*) FROM pg_database');
          items.push(new DatabaseTreeItem('Databases', vscode.TreeItemCollapsibleState.Collapsed, 'databases-group', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dbCountResult.rows[0].count));

          const rolesCountResult = await client.query('SELECT COUNT(*) FROM pg_roles');
          items.push(new DatabaseTreeItem('Users & Roles', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, rolesCountResult.rows[0].count));
          return items;

        case 'databases-group':
          // Fetch databases with size
          const cacheKey = SchemaCache.buildKey(element.connectionId!, dbName, undefined, 'databases');
          const dbResult = await this._cache.getOrFetch(cacheKey, async () => {
            return await client!.query(`
              SELECT datname, pg_size_pretty(pg_database_size(datname)) as size 
              FROM pg_database 
              ORDER BY datname
            `);
          });
          return dbResult.rows.map(row => new DatabaseTreeItem(
            row.datname,
            vscode.TreeItemCollapsibleState.Collapsed,
            'database',
            element.connectionId,
            row.datname,
            undefined, // schema
            undefined, // tableName
            undefined, // columnName
            undefined, // comment
            undefined, // isInstalled
            undefined, // installedVersion
            undefined, // roleAttributes
            undefined, // isDisconnected
            undefined, // isFavorite
            undefined, // count
            undefined, // rowCount
            row.size   // size
          ));

        case 'favorites-group':
          const favoriteItems: DatabaseTreeItem[] = [];
          const favoriteKeys = this.getFavoriteKeys().filter(key => key.split(':')[1] === element.connectionId);

          for (const key of favoriteKeys) {
            const parts = key.split(':');
            // Key format: type:connectionId:database:schema:name
            const itemType = parts[0] as 'table' | 'view' | 'function' | 'materialized-view';
            const dbName = parts[2];
            const schemaName = parts[3];
            const itemName = parts[4];

            // Determine collapsible state based on type
            const collapsible = (itemType === 'table' || itemType === 'view')
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None;

            // Use just the item name as label (for SQL commands), put extra info in description via isFavorite handling
            favoriteItems.push(new DatabaseTreeItem(
              itemName,    // Just the name - SQL commands use label
              collapsible,
              itemType,
              element.connectionId,
              dbName,
              schemaName,
              itemName,    // tableName - also just the name
              undefined,   // columnName
              `${schemaName}.${dbName} `, // comment - for tooltip
              undefined,   // isInstalled
              undefined,   // installedVersion
              undefined,   // roleAttributes
              undefined,   // isDisconnected
              true         // isFavorite
            ));
          }
          return favoriteItems;

        case 'recent-group':
          // Show all recent items for this connection (max 10)
          const recentItems: DatabaseTreeItem[] = [];
          const recentKeys = this.getRecentKeys().filter(key => {
            const parts = key.split(':');
            return parts[1] === element.connectionId;
          });

          for (const key of recentKeys) {
            const parts = key.split(':');
            // Key format: type:connectionId:database:schema:name
            const itemType = parts[0] as 'table' | 'view' | 'function' | 'materialized-view';
            const dbName = parts[2];
            const schemaName = parts[3];
            const itemName = parts[4];

            // Determine collapsible state based on type
            const collapsible = (itemType === 'table' || itemType === 'view')
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None;

            // Use just the item name as label
            recentItems.push(new DatabaseTreeItem(
              itemName,
              collapsible,
              itemType,
              element.connectionId,
              dbName,
              schemaName,
              itemName,
              undefined,   // columnName
              `${schemaName}.${dbName} `, // comment - for tooltip
              undefined,   // isInstalled
              undefined,   // installedVersion
              undefined,   // roleAttributes
              undefined,   // isDisconnected
              false        // isFavorite - these are recent, not favorites
            ));
          }
          return recentItems;

        case 'database':
          // Return just the categories at database level
          const schemaCountResult = await client.query(
            "SELECT COUNT(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema'"
          );

          const extensionCountResult = await client.query('SELECT COUNT(*) FROM pg_available_extensions WHERE installed_version IS NOT NULL');
          const fdwCountResult = await client.query('SELECT COUNT(*) FROM pg_foreign_data_wrapper');

          return [
            new DatabaseTreeItem('Schemas', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, schemaCountResult.rows[0].count),
            new DatabaseTreeItem('Extensions', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, extensionCountResult.rows[0].count),
            new DatabaseTreeItem('Foreign Data Wrappers', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, fdwCountResult.rows[0].count)
          ];

        case 'category':
          // Handle table sub-categories
          if (element.tableName) {
            switch (element.label) {
              case 'Columns':
                const columnResult = await client.query(
                  "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
                  [element.schema, element.tableName]
                );
                return columnResult.rows.map(row => new DatabaseTreeItem(
                  `${row.column_name} (${row.data_type})`,
                  vscode.TreeItemCollapsibleState.None,
                  'column',
                  element.connectionId,
                  element.databaseName,
                  element.schema,
                  element.tableName,
                  row.column_name
                ));

              case 'Constraints':
                const constraintResult = await client.query(
                  `SELECT
tc.constraint_name,
  tc.constraint_type
                                    FROM information_schema.table_constraints tc
                                    WHERE tc.table_schema = $1 AND tc.table_name = $2
                                    ORDER BY tc.constraint_type, tc.constraint_name`,
                  [element.schema, element.tableName]
                );
                return constraintResult.rows.map(row => {
                  return new DatabaseTreeItem(
                    row.constraint_name,
                    vscode.TreeItemCollapsibleState.None,
                    'constraint',
                    element.connectionId,
                    element.databaseName,
                    element.schema,
                    element.tableName
                  );
                });

              case 'Indexes':
                const indexResult = await client.query(
                  `SELECT
i.relname as index_name,
  ix.indisunique as is_unique,
  ix.indisprimary as is_primary
                                    FROM pg_index ix
                                    JOIN pg_class i ON i.oid = ix.indexrelid
                                    JOIN pg_class t ON t.oid = ix.indrelid
                                    JOIN pg_namespace n ON n.oid = t.relnamespace
                                    WHERE n.nspname = $1 AND t.relname = $2
                                    ORDER BY i.relname`,
                  [element.schema, element.tableName]
                );
                return indexResult.rows.map(row => {
                  return new DatabaseTreeItem(
                    row.index_name,
                    vscode.TreeItemCollapsibleState.None,
                    'index',
                    element.connectionId,
                    element.databaseName,
                    element.schema,
                    element.tableName
                  );
                });
            }
          }

          // Schema-level categories - extract base name (handle badge format "Tables • 5")
          const categoryName = element.label.split(' • ')[0];
          switch (categoryName) {
            case 'Users & Roles':
              const roleResult = await client.query(
                `SELECT r.rolname,
  r.rolsuper,
  r.rolcreatedb,
  r.rolcreaterole,
  r.rolcanlogin
                                 FROM pg_roles r
                                 ORDER BY r.rolname`
              );
              return roleResult.rows.map(row => new DatabaseTreeItem(
                row.rolname,
                vscode.TreeItemCollapsibleState.None,
                'role',
                element.connectionId,
                element.databaseName,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                {
                  rolsuper: row.rolsuper,
                  rolcreatedb: row.rolcreatedb,
                  rolcreaterole: row.rolcreaterole,
                  rolcanlogin: row.rolcanlogin
                }
              ));

            case 'Schemas':
              // Fetch schemas with size (sum of relations)
              const schemaResult = await client.query(
                `SELECT 
                   n.nspname as schema_name,
                   pg_size_pretty(SUM(COALESCE(pg_total_relation_size(c.oid), 0))) as size
                 FROM pg_namespace n
                 LEFT JOIN pg_class c ON n.oid = c.relnamespace
                 WHERE n.nspname NOT LIKE 'pg_%' 
                   AND n.nspname != 'information_schema'
                 GROUP BY n.nspname
                 ORDER BY
                   CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END,
                   n.nspname`
              );

              return schemaResult.rows.map(row => new DatabaseTreeItem(
                row.schema_name,
                vscode.TreeItemCollapsibleState.Collapsed,
                'schema',
                element.connectionId,
                element.databaseName,
                row.schema_name,
                undefined, // tableName
                undefined, // columnName
                undefined, // comment
                undefined, // isInstalled
                undefined, // installedVersion
                undefined, // roleAttributes
                undefined, // isDisconnected
                undefined, // isFavorite
                undefined, // count
                undefined, // rowCount
                row.size   // size
              ));

            case 'Extensions':
              const extensionResult = await client.query(
                `SELECT e.name,
  e.installed_version,
  e.default_version,
  e.comment,
  CASE WHEN e.installed_version IS NOT NULL THEN true ELSE false END as is_installed
                                 FROM pg_available_extensions e
                                 ORDER BY is_installed DESC, name`
              );
              return extensionResult.rows.map(row => new DatabaseTreeItem(
                row.installed_version ? `${row.name} (${row.installed_version})` : `${row.name} (${row.default_version})`,
                vscode.TreeItemCollapsibleState.None,
                'extension',
                element.connectionId,
                element.databaseName,
                undefined,
                undefined,
                undefined,
                row.comment,
                row.is_installed,
                row.installed_version
              ));

            // Existing category cases for schema level items
            case 'Tables':
              // Fetch tables with size and row count
              const tableResult = await client.query(
                `SELECT 
                   t.table_name,
                   c.reltuples::bigint as estimated_rows,
                   pg_size_pretty(pg_total_relation_size(c.oid)) as size
                 FROM information_schema.tables t
                 JOIN pg_class c ON c.relname = t.table_name
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
                 WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
                 ORDER BY t.table_name`,
                [element.schema]
              );
              return tableResult.rows
                .map(row => {
                  const isFav = this.isFavoriteItem('table', element.connectionId, element.databaseName, element.schema, row.table_name);
                  return new DatabaseTreeItem(
                    row.table_name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'table',
                    element.connectionId,
                    element.databaseName,
                    element.schema,
                    undefined, // tableName
                    undefined, // columnName
                    undefined, // comment
                    undefined, // isInstalled
                    undefined, // installedVersion
                    undefined, // roleAttributes
                    undefined, // isDisconnected
                    isFav,     // isFavorite
                    undefined, // count
                    row.estimated_rows, // rowCount
                    row.size   // size
                  );
                });

            case 'Views':
              const viewResult = await client.query(
                "SELECT table_name FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name",
                [element.schema]
              );
              return viewResult.rows
                .map(row => {
                  const isFav = this.isFavoriteItem('view', element.connectionId, element.databaseName, element.schema, row.table_name);
                  return new DatabaseTreeItem(
                    row.table_name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'view',
                    element.connectionId,
                    element.databaseName,
                    element.schema,
                    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                    isFav
                  );
                });

            case 'Functions':
              const functionResult = await client.query(
                "SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION' ORDER BY routine_name",
                [element.schema]
              );
              return functionResult.rows
                .map(row => {
                  const isFav = this.isFavoriteItem('function', element.connectionId, element.databaseName, element.schema, row.routine_name);
                  return new DatabaseTreeItem(
                    row.routine_name,
                    vscode.TreeItemCollapsibleState.None,
                    'function',
                    element.connectionId,
                    element.databaseName,
                    element.schema,
                    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                    isFav
                  );
                });

            case 'Materialized Views':
              // Fetch materialized views with stats
              const materializedViewResult = await client.query(
                `SELECT 
                   m.matviewname as name,
                   c.reltuples::bigint as estimated_rows,
                   pg_size_pretty(pg_total_relation_size(c.oid)) as size
                 FROM pg_matviews m
                 JOIN pg_class c ON c.relname = m.matviewname
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = m.schemaname
                 WHERE m.schemaname = $1 
                 ORDER BY m.matviewname`,
                [element.schema]
              );
              return materializedViewResult.rows
                .map(row => {
                  const isFav = this.isFavoriteItem('materialized-view', element.connectionId, element.databaseName, element.schema, row.name);
                  return new DatabaseTreeItem(
                    row.name,
                    vscode.TreeItemCollapsibleState.None,
                    'materialized-view',
                    element.connectionId,
                    element.databaseName,
                    element.schema,
                    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                    isFav,
                    undefined,
                    row.estimated_rows,
                    row.size
                  );
                });

            case 'Types':
              const typeResult = await client.query(
                `SELECT t.typname as name
                                 FROM pg_type t
                                 JOIN pg_namespace n ON t.typnamespace = n.oid
                                 WHERE n.nspname = $1
                                 AND t.typtype = 'c'
                                 ORDER BY t.typname`,
                [element.schema]
              );
              return typeResult.rows.map(row => new DatabaseTreeItem(
                row.name,
                vscode.TreeItemCollapsibleState.None,
                'type',
                element.connectionId,
                element.databaseName,
                element.schema
              ));

            case 'Foreign Tables':
              const foreignTableResult = await client.query(
                `SELECT c.relname as name
                                 FROM pg_foreign_table ft
                                 JOIN pg_class c ON ft.ftrelid = c.oid
                                 JOIN pg_namespace n ON c.relnamespace = n.oid
                                 WHERE n.nspname = $1
                                 ORDER BY c.relname`,
                [element.schema]
              );
              return foreignTableResult.rows.map(row => new DatabaseTreeItem(
                row.name,
                vscode.TreeItemCollapsibleState.None,
                'foreign-table',
                element.connectionId,
                element.databaseName,
                element.schema
              ));

            case 'Foreign Data Wrappers':
              const fdwResult = await client.query(
                `SELECT fdwname as name
                                 FROM pg_foreign_data_wrapper
                                 ORDER BY fdwname`
              );
              return fdwResult.rows.map(row => new DatabaseTreeItem(
                row.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                'foreign-data-wrapper',
                element.connectionId,
                element.databaseName
              ));
          }
          return [];

        case 'schema':
          const tablesCountResult = await client.query(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
            [element.schema]
          );

          const viewsCountResult = await client.query(
            "SELECT COUNT(*) FROM information_schema.views WHERE table_schema = $1",
            [element.schema]
          );

          const functionsCountResult = await client.query(
            "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION'",
            [element.schema]
          );

          const materializedViewsCountResult = await client.query(
            "SELECT COUNT(*) FROM pg_matviews WHERE schemaname = $1",
            [element.schema]
          );

          const typesCountResult = await client.query(
            "SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = $1 AND t.typtype = 'c'",
            [element.schema]
          );

          const foreignTablesCountResult = await client.query(
            "SELECT COUNT(*) FROM information_schema.foreign_tables WHERE foreign_table_schema = $1",
            [element.schema]
          );

          return [
            new DatabaseTreeItem('Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tablesCountResult.rows[0].count),
            new DatabaseTreeItem('Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, viewsCountResult.rows[0].count),
            new DatabaseTreeItem('Functions', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, functionsCountResult.rows[0].count),
            new DatabaseTreeItem('Materialized Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, materializedViewsCountResult.rows[0].count),
            new DatabaseTreeItem('Types', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, typesCountResult.rows[0].count),
            new DatabaseTreeItem('Foreign Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, foreignTablesCountResult.rows[0].count)
          ];

        case 'table':
          // Show hierarchical structure for tables
          return [
            new DatabaseTreeItem('Columns', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
            new DatabaseTreeItem('Constraints', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
            new DatabaseTreeItem('Indexes', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label)
          ];

        case 'view':
          // Views only have columns
          return [
            new DatabaseTreeItem('Columns', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label)
          ];

        case 'foreign-data-wrapper':
          // FDW node - list all foreign servers using this FDW
          const serversResult = await client.query(
            `SELECT srv.srvname as name
                         FROM pg_foreign_server srv
                         JOIN pg_foreign_data_wrapper fdw ON srv.srvfdw = fdw.oid
                         WHERE fdw.fdwname = $1
                         ORDER BY srv.srvname`,
            [element.label]
          );
          return serversResult.rows.map(row => new DatabaseTreeItem(
            row.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            'foreign-server',
            element.connectionId,
            element.databaseName,
            element.label // Store FDW name in schema field
          ));

        case 'foreign-server':
          // Foreign server node - list all user mappings
          const mappingsResult = await client.query(
            `SELECT um.usename as name
                         FROM pg_user_mappings um
                         WHERE um.srvname = $1
                         ORDER BY um.usename`,
            [element.label]
          );
          return mappingsResult.rows.map(row => new DatabaseTreeItem(
            row.name,
            vscode.TreeItemCollapsibleState.None,
            'user-mapping',
            element.connectionId,
            element.databaseName,
            element.label, // Store server name in schema field
            element.label  // Store server name in tableName for context
          ));

        default:
          return [];
      }
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
    // Do NOT close the client here, as it is managed by ConnectionManager
  }
}

export class DatabaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: 'connection' | 'database' | 'schema' | 'table' | 'view' | 'function' | 'column' | 'category' | 'materialized-view' | 'type' | 'foreign-table' | 'extension' | 'role' | 'databases-group' | 'favorites-group' | 'recent-group' | 'constraint' | 'index' | 'foreign-data-wrapper' | 'foreign-server' | 'user-mapping' | 'connection-group',
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
    public readonly readOnlyMode?: boolean  // Read-only mode flag
  ) {
    super(label, collapsibleState);
    if (type === 'category' && label) {
      // Create specific context value for categories (e.g., category-tables, category-views)
      const suffix = label.toLowerCase().replace(/\s+&\s+/g, '-').replace(/\s+/g, '-');
      this.contextValue = `category-${suffix}`;
    } else if (type === 'connection' && isDisconnected) {
      this.contextValue = 'connection-disconnected';
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
      'favorites-group': new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow')),
      'recent-group': new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.green')),
      schema: new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.yellow')),
      table: new vscode.ThemeIcon('table', new vscode.ThemeColor('charts.blue')),
      view: new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.green')),
      function: new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.orange')),
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
      'connection-group': new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'))
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
    } else if ((type === 'category' || type === 'databases-group') && count !== undefined) {
      desc = `• ${count}`;
    }

    // Append muted star for favorites (★ is more subtle than ⭐)
    if (isFavorite) {
      return desc ? `${desc} ★` : '★';
    }
    return desc;
  }
}
