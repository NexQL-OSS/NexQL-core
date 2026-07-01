import * as vscode from 'vscode';
import { BaseLoader, LoaderContext } from './BaseLoader';
import { DatabaseTreeItem } from '../../DatabaseTreeProvider';
import type { DatabaseTreeProvider } from '../../DatabaseTreeProvider';
import { getSchemaCache, SchemaCache } from '../../../lib/schema-cache';
import { NotebookIndexService } from '../../../services/NotebookIndexService';
import { SavedQueriesService } from '../../../features/savedQueries/SavedQueriesService';
import { QueryHistoryService } from '../../../services/QueryHistoryService';

const UNSPECIFIED_DB = 'Unspecified';

/** Count items grouped by their database name (null/undefined → UNSPECIFIED_DB). */
function countByDatabase<T>(items: T[], getDb: (item: T) => string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const db = getDb(item) || UNSPECIFIED_DB;
    counts.set(db, (counts.get(db) || 0) + 1);
  }
  return counts;
}

/** Build per-database sub-folder tree items, sorted by database name. */
function buildDbGroupItems(
  counts: Map<string, number>,
  connectionId: string,
  type: 'connection-notebooks-db' | 'connection-saved-queries-db' | 'connection-query-history-db',
): DatabaseTreeItem[] {
  return Array.from(counts.entries())
    .sort((a, b) => {
      // Keep "Unspecified" last.
      if (a[0] === UNSPECIFIED_DB) { return 1; }
      if (b[0] === UNSPECIFIED_DB) { return -1; }
      return a[0].localeCompare(b[0]);
    })
    .map(([db, count]) => new DatabaseTreeItem(
      db,
      vscode.TreeItemCollapsibleState.Collapsed,
      type,
      connectionId,
      db,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      count
    ));
}

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
        if (!element.connectionId) return [];
        const cacheKey = SchemaCache.buildKey(element.connectionId!, 'postgres', undefined, 'connection-items');
        return await getSchemaCache().getOrFetch(cacheKey, async () => {
          const items: DatabaseTreeItem[] = [];

          const connectionFavorites = provider.getFavoriteKeys().filter(key => key.split(':')[1] === element.connectionId);
          if (connectionFavorites.length > 0) {
            items.push(new DatabaseTreeItem('Favorites', vscode.TreeItemCollapsibleState.Collapsed, 'favorites-group', element.connectionId));
          }

          const connectionRecent = provider.getRecentKeys().filter(key => key.split(':')[1] === element.connectionId);
          if (connectionRecent.length > 0) {
            items.push(new DatabaseTreeItem('Recent', vscode.TreeItemCollapsibleState.Collapsed, 'recent-group', element.connectionId));
          }

          const countsRes = await client.query(`
            SELECT
              (SELECT COUNT(*) FROM pg_database WHERE has_database_privilege(datname, 'CONNECT')) AS db_count,
              (SELECT COUNT(*) FROM pg_roles) AS roles_count,
              (SELECT COUNT(*) FROM pg_tablespace) AS tablespace_count
          `);
          const row = countsRes.rows[0];

          items.push(new DatabaseTreeItem('Databases', vscode.TreeItemCollapsibleState.Collapsed, 'databases-group', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(row.db_count || 0)));

          const notebooks = NotebookIndexService.getInstance().getNotebooksForConnection(element.connectionId!);
          items.push(new DatabaseTreeItem(
            'Notebooks',
            vscode.TreeItemCollapsibleState.Collapsed,
            'connection-notebooks-folder',
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
            notebooks.length
          ));

          const savedCount = SavedQueriesService.getInstance().getByConnection(element.connectionId!).length;
          items.push(new DatabaseTreeItem(
            'Saved Queries',
            vscode.TreeItemCollapsibleState.Collapsed,
            'connection-saved-queries-folder',
            element.connectionId,
            undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined,
            savedCount
          ));

          const historyCount = QueryHistoryService.getInstance().getByConnection(element.connectionId!).length;
          items.push(new DatabaseTreeItem(
            'Query History',
            vscode.TreeItemCollapsibleState.Collapsed,
            'connection-query-history-folder',
            element.connectionId,
            undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined,
            historyCount
          ));

          items.push(new DatabaseTreeItem('Users & Roles', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(row.roles_count || 0)));

          items.push(new DatabaseTreeItem('Tablespaces', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(row.tablespace_count || 0)));

          return items;
        });
      }

      case 'databases-group': {
        const dbName = element.databaseName || 'postgres';
        const cacheKey = SchemaCache.buildKey(element.connectionId!, dbName, undefined, 'databases');
        const dbResult = await (provider as any)._cache.getOrFetch(cacheKey, async () => {
          return await client.query(`
            SELECT datname,
                   CASE WHEN has_database_privilege(datname, 'CONNECT')
                        THEN pg_size_pretty(pg_database_size(datname))
                        ELSE NULL
                   END AS size 
            FROM pg_database 
            WHERE has_database_privilege(datname, 'CONNECT')
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
                       ELSE NULL
                  END AS size
           FROM pg_database
           WHERE datname = ANY($1) AND has_database_privilege(datname, 'CONNECT')
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

      case 'connection-notebooks-folder': {
        if (!element.connectionId) return [];
        const notebooks = NotebookIndexService.getInstance().getNotebooksForConnection(element.connectionId);
        const counts = countByDatabase(notebooks, nb => nb.databaseName);
        return buildDbGroupItems(counts, element.connectionId, 'connection-notebooks-db');
      }

      case 'connection-notebooks-db': {
        if (!element.connectionId) return [];
        const notebooks = NotebookIndexService.getInstance()
          .getNotebooksForConnection(element.connectionId)
          .filter(nb => (nb.databaseName || UNSPECIFIED_DB) === element.databaseName);

        notebooks.sort((a, b) => {
          const aIsScratch = a.name === 'scratch';
          const bIsScratch = b.name === 'scratch';
          if (aIsScratch !== bIsScratch) {
            return aIsScratch ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        return notebooks.map(nb => {
          const item = new DatabaseTreeItem(
            nb.name,
            vscode.TreeItemCollapsibleState.None,
            'connection-notebook-file',
            element.connectionId,
            nb.databaseName
          );
          (item as any).uri = nb.uri;
          item.command = {
            command: 'postgres-explorer.notebooks.open',
            title: 'Open Notebook',
            arguments: [item]
          };
          item.resourceUri = nb.uri;
          const mtimeStr = new Date(nb.mtime).toLocaleDateString();
          item.description = nb.sectionCount > 0 ? `${nb.sectionCount} section${nb.sectionCount !== 1 ? 's' : ''} · ${mtimeStr}` : mtimeStr;
          item.tooltip = `${nb.name}.pgsql\nDatabase: ${nb.databaseName || '(none)'}\nModified: ${mtimeStr}`;
          item.contextValue = 'connection-notebook-file';
          return item;
        });
      }

      case 'connection-saved-queries-folder': {
        if (!element.connectionId) return [];
        const queries = SavedQueriesService.getInstance().getByConnection(element.connectionId);
        const counts = countByDatabase(queries, q => q.databaseName);
        return buildDbGroupItems(counts, element.connectionId, 'connection-saved-queries-db');
      }

      case 'connection-saved-queries-db': {
        if (!element.connectionId) return [];
        const queries = SavedQueriesService.getInstance()
          .getByConnection(element.connectionId)
          .filter(q => (q.databaseName || UNSPECIFIED_DB) === element.databaseName);

        return queries.map(sq => {
          const item = new DatabaseTreeItem(
            sq.title,
            vscode.TreeItemCollapsibleState.None,
            'connection-saved-query-item',
            element.connectionId,
            sq.databaseName
          );
          (item as any).query = sq;
          item.command = {
            command: 'postgres-explorer.openSavedQueryInNotebook',
            title: 'Open Saved Query',
            arguments: [item]
          };
          const meta = sq.schemaName || sq.tags?.join(', ');
          if (meta) {
            item.description = meta;
          }
          item.tooltip = `${sq.title}${sq.description ? `\n${sq.description}` : ''}\n\n${sq.query}`;
          item.contextValue = 'connection-saved-query-item';
          return item;
        });
      }

      case 'connection-query-history-folder': {
        if (!element.connectionId) return [];
        const history = QueryHistoryService.getInstance().getByConnection(element.connectionId);
        const counts = countByDatabase(history, h => h.databaseName);
        return buildDbGroupItems(counts, element.connectionId, 'connection-query-history-db');
      }

      case 'connection-query-history-db': {
        if (!element.connectionId) return [];
        const history = QueryHistoryService.getInstance()
          .getByConnection(element.connectionId)
          .filter(h => (h.databaseName || UNSPECIFIED_DB) === element.databaseName)
          .sort((a, b) => b.timestamp - a.timestamp);

        return history.map(h => {
          const label = h.query.replace(/\s+/g, ' ').trim().slice(0, 60);
          const item = new DatabaseTreeItem(
            label || '(empty query)',
            vscode.TreeItemCollapsibleState.None,
            'connection-query-history-item',
            element.connectionId,
            h.databaseName
          );
          (item as any).query = h.query;
          item.id = h.id; // required by deleteHistoryItem (reads item.id)
          item.command = {
            command: 'postgres-explorer.openQuery',
            title: 'Open Query',
            arguments: [h]
          };
          item.description = `${new Date(h.timestamp).toLocaleString()}${h.success ? '' : ' · failed'}`;
          item.tooltip = h.query;
          item.contextValue = 'connection-query-history-item';
          return item;
        });
      }

      default:
        return [];
    }
  }
}
