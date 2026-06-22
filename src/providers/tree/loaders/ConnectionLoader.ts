import * as vscode from 'vscode';
import { BaseLoader, LoaderContext } from './BaseLoader';
import { DatabaseTreeItem } from '../../DatabaseTreeProvider';
import type { DatabaseTreeProvider } from '../../DatabaseTreeProvider';
import { SchemaCache } from '../../../lib/schema-cache';

const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);

export class ConnectionLoader extends BaseLoader {
  /** Group folder nodes have no DB connection; expand from workspace config only. */
  getConnectionGroupChildren(
    provider: DatabaseTreeProvider,
    element: DatabaseTreeItem,
  ): DatabaseTreeItem[] {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const groupName = element.label;
    const groupConnections = connections.filter(c => c.group === groupName);

    return groupConnections.map(conn => new DatabaseTreeItem(
      conn.name || `${conn.host}:${conn.port}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      'connection',
      conn.id,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (provider as any).disconnectedConnections.has(conn.id),
      undefined,
      undefined,
      undefined,
      undefined,
      conn.environment,
      conn.readOnlyMode
    ));
  }

  async getChildren(ctx: LoaderContext): Promise<DatabaseTreeItem[]> {
    const { provider, client, element, pgVer } = ctx;
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];

    switch (element.type) {
      case 'connection': {
        const items: DatabaseTreeItem[] = [];
        if (!element.connectionId) return [];

        const connectionFavorites = provider.getFavoriteKeys().filter(key => key.split(':')[1] === element.connectionId);
        if (connectionFavorites.length > 0) {
          items.push(new DatabaseTreeItem('Favorites', vscode.TreeItemCollapsibleState.Collapsed, 'favorites-group', element.connectionId));
        }

        const connectionRecent = provider.getRecentKeys().filter(key => key.split(':')[1] === element.connectionId);
        if (connectionRecent.length > 0) {
          items.push(new DatabaseTreeItem('Recent', vscode.TreeItemCollapsibleState.Collapsed, 'recent-group', element.connectionId));
        }

        const dbCountResult = await client.query('SELECT COUNT(*) FROM pg_database');
        items.push(new DatabaseTreeItem('Databases', vscode.TreeItemCollapsibleState.Collapsed, 'databases-group', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dbCountResult.rows[0].count));

        const rolesCountResult = await client.query('SELECT COUNT(*) FROM pg_roles');
        items.push(new DatabaseTreeItem('Users & Roles', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, rolesCountResult.rows[0].count));

        const tablespaceCountResult = await client.query("SELECT COUNT(*) FROM pg_tablespace");
        items.push(new DatabaseTreeItem('Tablespaces', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tablespaceCountResult.rows[0].count));

        return items;
      }

      case 'databases-group': {
        const dbName = element.databaseName || 'postgres';
        const cacheKey = SchemaCache.buildKey(element.connectionId!, dbName, undefined, 'databases');
        const dbResult = await (provider as any)._cache.getOrFetch(cacheKey, async () => {
          return await client.query(`
            SELECT datname,
                   CASE WHEN has_database_privilege(datname, 'CONNECT')
                        THEN pg_size_pretty(pg_database_size(datname))
                   END as size
            FROM pg_database
            ORDER BY datname
          `);
        });
        const systemDatabases = dbResult.rows.filter((row: any) => SYSTEM_DATABASES.has(row.datname));
        const userDatabases = dbResult.rows.filter((row: any) => !SYSTEM_DATABASES.has(row.datname));

        const databaseItems = userDatabases.map((row: any) => new DatabaseTreeItem(
          row.datname,
          vscode.TreeItemCollapsibleState.Collapsed,
          'database',
          element.connectionId,
          row.datname,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          row.size
        ));

        if (systemDatabases.length > 0) {
          databaseItems.push(new DatabaseTreeItem(
            'System Databases',
            vscode.TreeItemCollapsibleState.Collapsed,
            'system-databases-group',
            element.connectionId,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            systemDatabases.length
          ));
        }

        return databaseItems;
      }

      case 'system-databases-group': {
        const systemDbResult = await client.query(
          `SELECT datname,
                  CASE WHEN has_database_privilege(datname, 'CONNECT')
                       THEN pg_size_pretty(pg_database_size(datname))
                  END as size
           FROM pg_database
           WHERE datname = ANY($1)
           ORDER BY datname`,
          [Array.from(SYSTEM_DATABASES)]
        );

        return systemDbResult.rows.map((row: any) => new DatabaseTreeItem(
          row.datname,
          vscode.TreeItemCollapsibleState.Collapsed,
          'database',
          element.connectionId,
          row.datname,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          row.size
        ));
      }

      case 'favorites-group': {
        const favoriteItems: DatabaseTreeItem[] = [];
        const favoriteKeys = provider.getFavoriteKeys().filter(key => key.split(':')[1] === element.connectionId);

        for (const key of favoriteKeys) {
          const parts = key.split(':');
          const itemType = parts[0] as 'table' | 'view' | 'function' | 'procedure' | 'materialized-view';
          const dbName = parts[2];
          const schemaName = parts[3];
          const itemName = parts[4];

          const collapsible = (itemType === 'table' || itemType === 'view')
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

          favoriteItems.push(new DatabaseTreeItem(
            itemName,
            collapsible,
            itemType,
            element.connectionId,
            dbName,
            schemaName,
            itemName,
            undefined,
            `${schemaName}.${dbName} `,
            undefined,
            undefined,
            undefined,
            undefined,
            true
          ));
        }
        return favoriteItems;
      }

      case 'recent-group': {
        const recentItems: DatabaseTreeItem[] = [];
        const recentKeys = provider.getRecentKeys().filter(key => {
          const parts = key.split(':');
          return parts[1] === element.connectionId;
        });

        for (const key of recentKeys) {
          const parts = key.split(':');
          const itemType = parts[0] as 'table' | 'view' | 'function' | 'procedure' | 'materialized-view';
          const dbName = parts[2];
          const schemaName = parts[3];
          const itemName = parts[4];

          const collapsible = (itemType === 'table' || itemType === 'view')
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

          recentItems.push(new DatabaseTreeItem(
            itemName,
            collapsible,
            itemType,
            element.connectionId,
            dbName,
            schemaName,
            itemName,
            undefined,
            `${schemaName}.${dbName} `,
            undefined,
            undefined,
            undefined,
            undefined,
            false
          ));
        }
        return recentItems;
      }

      default:
        return [];
    }
  }
}
