/**
 * Database object fetching service for @ mentions
 */
import * as vscode from 'vscode';
import { debugLog } from '../../common/logger';
import { extensionContext } from '../../extension';
import { Client, PoolClient } from 'pg';
import { ConnectionManager } from '../../services/ConnectionManager';
import { getSchemaCache, SchemaCache } from '../../lib/schema-cache';
import { DbObject, DbObjectType } from './types';
import {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  TableSchema,
  renderTableSchema,
} from '../../common/schemaRender';

/** P1.5 — schema-fetch retry policy. */
const SCHEMA_FETCH_MAX_ATTEMPTS = 3;
const SCHEMA_FETCH_BASE_DELAY_MS = 200;
const SCHEMA_FETCH_MAX_DELAY_MS = 1500;

/** Optional per-request render context (relevance ranking against the user message). */
export interface SchemaRenderContext {
  userMessage?: string;
}

/**
 * Current breadcrumb location the picker search is scoped to. When a database is set the search
 * stays within that single database (optionally a single schema) instead of scanning every
 * connection × database.
 */
export interface DbSearchScope {
  connectionId?: string;
  database?: string;
  schema?: string;
}

/** Serialized tree item metadata from drag-and-drop (DatabaseDragAndDropController serialization). */
export interface SerializedTreeItem {
  type: string;
  connectionId: string;
  databaseName?: string;
  schema?: string;
  tableName?: string;
  columnName?: string;
  label: string;
  comment?: string;
}

export class DbObjectService {
  private _cache: DbObject[] = [];
  private _dbListCache: SchemaCache = getSchemaCache();
  private _lastSearchQuery = '';
  private _lastSearchResults: DbObject[] = [];
  private _indexedDbsCache: { list: Array<{ connectionId: string; database: string }>; ts: number } | null = null;
  private readonly SEARCH_MIN_CHARS = 2;
  private readonly MAX_RESULTS = 100;
  private readonly INITIAL_RESULTS = 40;

  async getConnections(): Promise<DbObject[]> {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    return connections.map(conn => {
       const connName = conn.name || conn.host;
       return {
          name: connName,
          type: 'connection',
          schema: '',
          database: '',
          connectionId: conn.id,
          connectionName: connName,
          breadcrumb: connName,
          isContainer: true
       };
    });
  }

  async getDatabases(connectionId: string): Promise<DbObject[]> {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return [];

    let client: PoolClient | undefined;
    try {
        const connName = conn.name || conn.host;
        client = await ConnectionManager.getInstance().getPooledClient({
          id: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          database: 'postgres',
          name: conn.name
        });
        
        if (!client) return [];

        const dbListKey = SchemaCache.buildKey(conn.id, 'postgres', undefined, 'db-list');
        const dbResult = await this._dbListCache.getOrFetch(dbListKey, async () => {
          return await client!.query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
          );
        }, 300000);

        return dbResult.rows.map(row => ({
            name: row.datname,
            type: 'database',
            schema: '',
            database: row.datname,
            connectionId: conn.id,
            connectionName: connName,
            breadcrumb: `${connName} > ${row.datname}`,
            isContainer: true
        }));
    } catch (e) {
        console.error('Error fetching databases:', e);
        return [];
    }
  }

  async getSchemas(connectionId: string, database: string): Promise<DbObject[]> {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return [];

    let client: PoolClient | undefined;
    try {
        const connName = conn.name || conn.host;
        client = await ConnectionManager.getInstance().getPooledClient({
            id: conn.id,
            host: conn.host,
            port: conn.port,
            username: conn.username,
            database: database,
            name: conn.name
        });

        if (!client) return [];

        const schemaKey = SchemaCache.buildKey(conn.id, database, undefined, 'schema-list');
        const schemaResult = await this._dbListCache.getOrFetch(schemaKey, async () => {
             return await client!.query(
              "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema' ORDER BY nspname"
            );
        }, 300000);

         return schemaResult.rows.map(row => ({
            name: row.nspname,
            type: 'schema',
            schema: row.nspname,
            database: database,
            connectionId: conn.id,
            connectionName: connName,
            breadcrumb: `${connName} > ${database} > ${row.nspname}`,
            isContainer: true
        }));
    } catch (e) {
        console.error('Error fetching schemas:', e);
        return [];
    }
  }

  async getSchemaObjects(connectionId: string, database: string, schema: string): Promise<DbObject[]> {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return [];
    
    const objects: DbObject[] = [];
    let client: PoolClient | undefined;

     try {
        const connName = conn.name || conn.host;
        client = await ConnectionManager.getInstance().getPooledClient({
            id: conn.id,
            host: conn.host,
            port: conn.port,
            username: conn.username,
            database: database,
            name: conn.name
        });

        if (!client) return [];

         // Get tables
         const tableResult = await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
            [schema]
          );
          for (const row of tableResult.rows) {
            objects.push({
              name: row.table_name,
              type: 'table',
              schema: schema,
              database: database,
              connectionId: conn.id,
              connectionName: connName,
              breadcrumb: `${connName} > ${database} > ${schema} > ${row.table_name}`,
              isContainer: false
            });
          }

          // Get views
          const viewResult = await client.query(
            "SELECT table_name FROM information_schema.views WHERE table_schema = $1",
            [schema]
          );
           for (const row of viewResult.rows) {
            objects.push({
              name: row.table_name,
              type: 'view',
              schema: schema,
              database: database,
              connectionId: conn.id,
              connectionName: connName,
              breadcrumb: `${connName} > ${database} > ${schema} > ${row.table_name}`,
              isContainer: false
            });
          }

          // Get functions
          const funcResult = await client.query(
            "SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION'",
            [schema]
          );
           for (const row of funcResult.rows) {
            objects.push({
              name: row.routine_name,
              type: 'function',
              schema: schema,
              database: database,
              connectionId: conn.id,
              connectionName: connName,
              breadcrumb: `${connName} > ${database} > ${schema} > ${row.routine_name}`,
              isContainer: false
            });
          }

          // Get materialized views
          const matViewResult = await client.query(
            "SELECT matviewname FROM pg_matviews WHERE schemaname = $1",
            [schema]
          );
          for (const row of matViewResult.rows) {
            objects.push({
                name: row.matviewname,
                type: 'materialized-view',
                schema: schema,
                database: database,
                connectionId: conn.id,
                connectionName: connName,
                breadcrumb: `${connName} > ${database} > ${schema} > ${row.matviewname}`,
                isContainer: false
            });
          }

          return objects;

     } catch(e) {
         console.error('Error fetching schema objects:', e);
         return [];
     }
  }

  async fetchDbObjects(): Promise<DbObject[]> {
    const objects: DbObject[] = [];
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];

    debugLog('[ChatView] Fetching DB objects, connections found:', connections.length);

    if (connections.length === 0) {
      debugLog('[ChatView] No connections configured');
      return objects;
    }

    for (const conn of connections) {
      let client: PoolClient | undefined;
      try {
        const connName = conn.name || conn.host;
        debugLog('[ChatView] Processing connection:', connName);

        client = await ConnectionManager.getInstance().getPooledClient({
          id: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          database: 'postgres',
          name: conn.name
        });

        const dbResult = await client.query(
          "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
        );

        debugLog('[ChatView] Found databases:', dbResult.rows.length);

        for (const dbRow of dbResult.rows) {
          const dbName = dbRow.datname;
          let dbClient: PoolClient | undefined;

          try {
            dbClient = await ConnectionManager.getInstance().getPooledClient({
              id: conn.id,
              host: conn.host,
              port: conn.port,
              username: conn.username,
              database: dbName,
              name: conn.name
            });

            const schemaResult = await dbClient.query(
              "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema'"
            );

            for (const schemaRow of schemaResult.rows) {
              const schemaName = schemaRow.nspname;

              objects.push({
                name: schemaName,
                type: 'schema',
                schema: schemaName,
                database: dbName,
                connectionId: conn.id,
                connectionName: connName,
                breadcrumb: `${connName} > ${dbName} > ${schemaName}`
              });

              // Get tables
              const tableResult = await dbClient.query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
                [schemaName]
              );
              for (const row of tableResult.rows) {
                objects.push({
                  name: row.table_name,
                  type: 'table',
                  schema: schemaName,
                  database: dbName,
                  connectionId: conn.id,
                  connectionName: connName,
                  breadcrumb: `${connName} > ${dbName} > ${schemaName} > ${row.table_name}`
                });
              }

              // Get views
              const viewResult = await dbClient.query(
                "SELECT table_name FROM information_schema.views WHERE table_schema = $1",
                [schemaName]
              );
              for (const row of viewResult.rows) {
                objects.push({
                  name: row.table_name,
                  type: 'view',
                  schema: schemaName,
                  database: dbName,
                  connectionId: conn.id,
                  connectionName: connName,
                  breadcrumb: `${connName} > ${dbName} > ${schemaName} > ${row.table_name}`
                });
              }

              // Get functions
              const funcResult = await dbClient.query(
                "SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION'",
                [schemaName]
              );
              for (const row of funcResult.rows) {
                objects.push({
                  name: row.routine_name,
                  type: 'function',
                  schema: schemaName,
                  database: dbName,
                  connectionId: conn.id,
                  connectionName: connName,
                  breadcrumb: `${connName} > ${dbName} > ${schemaName} > ${row.routine_name}`
                });
              }

              // Get materialized views
              const matViewResult = await dbClient.query(
                "SELECT matviewname FROM pg_matviews WHERE schemaname = $1",
                [schemaName]
              );
              for (const row of matViewResult.rows) {
                objects.push({
                  name: row.matviewname,
                  type: 'materialized-view',
                  schema: schemaName,
                  database: dbName,
                  connectionId: conn.id,
                  connectionName: connName,
                  breadcrumb: `${connName} > ${dbName} > ${schemaName} > ${row.matviewname}`
                });
              }

              // Get types
              const typeResult = await dbClient.query(
                "SELECT t.typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = $1 AND t.typtype = 'c'",
                [schemaName]
              );
              for (const row of typeResult.rows) {
                objects.push({
                  name: row.typname,
                  type: 'type',
                  schema: schemaName,
                  database: dbName,
                  connectionId: conn.id,
                  connectionName: connName,
                  breadcrumb: `${connName} > ${dbName} > ${schemaName} > ${row.typname}`
                });
              }
            }
          } catch (e) {
            console.error('[ChatView] Error fetching from database ' + dbName + ':', e);
          } finally {
            if (dbClient) dbClient.release();
          }
        }
      } catch (e) {
        console.error('[ChatView] Error fetching from connection ' + conn.name + ':', e);
      } finally {
        if (client) client.release();
      }
    }

    debugLog('[ChatView] Total objects found:', objects.length);
    this._cache = objects;
    return objects;
  }

  /**
   * Search for DB objects. When {@link scope} is provided the search is scoped to the current
   * breadcrumb location and resolves from in-memory / cached data (no per-keystroke live scan).
   * Without a scope it falls back to the legacy all-connections search for backward compatibility.
   */
  async searchObjectsAsync(query: string, scope?: DbSearchScope): Promise<DbObject[]> {
    if (scope) {
      return this.searchScoped(query, scope);
    }

    const trimmed = query.trim();
    if (trimmed.length < this.SEARCH_MIN_CHARS) {
      return this._cache.slice(0, 20);
    }
    if (trimmed === this._lastSearchQuery && this._lastSearchResults.length > 0) {
      return this._lastSearchResults;
    }
    const results = await this.fetchDbObjectsBySearch(trimmed, this.MAX_RESULTS, false);
    this._lastSearchQuery = trimmed;
    this._lastSearchResults = results;
    return results;
  }

  /**
   * Scope-aware search. Filters within the current breadcrumb location instead of scanning every
   * connection × database. Each level resolves from cached / in-memory data after the first load,
   * so incremental typing does no live DB round-trips.
   */
  async searchScoped(query: string, scope: DbSearchScope): Promise<DbObject[]> {
    const lower = query.trim().toLowerCase();

    // Root: no connection selected.
    if (!scope.connectionId) {
      const conns = await this.getConnections();
      if (!lower) { return conns; }
      const connMatches = conns.filter(c => c.name.toLowerCase().includes(lower));
      // Below the object-search threshold, only match connection names.
      if (lower.length < this.SEARCH_MIN_CHARS) { return connMatches; }
      // Global object search backed by the local DB indexes (graph/lexical), no live scans.
      const objectHits = await this.searchAllIndexes(query.trim(), this.MAX_RESULTS);
      return [...connMatches, ...objectHits];
    }

    // Connection selected, no database -> filter database names.
    if (!scope.database) {
      const dbs = await this.getDatabases(scope.connectionId);
      return lower ? dbs.filter(d => d.name.toLowerCase().includes(lower)) : dbs;
    }

    // Database (optionally schema) selected -> search objects within that one database.
    const inSchema = (o: DbObject) => !scope.schema || o.schema === scope.schema;

    // Fast-path: local dbindex, if one is built for this connection+database.
    if (lower.length >= this.SEARCH_MIN_CHARS) {
      const indexHits = await this._searchLocalIndex(scope.connectionId, scope.database, query.trim());
      if (indexHits && indexHits.length > 0) {
        const scoped = indexHits.filter(inSchema);
        if (scoped.length > 0) return scoped.slice(0, this.MAX_RESULTS);
      }
    }

    // Fallback: filter the cached flat catalog in-memory.
    const catalog = await this.getDatabaseCatalog(scope.connectionId, scope.database);
    let filtered = catalog.filter(inSchema);
    if (lower) {
      filtered = filtered.filter(o =>
        o.name.toLowerCase().includes(lower) || o.schema.toLowerCase().includes(lower)
      );
    }
    return filtered.slice(0, this.MAX_RESULTS);
  }

  /**
   * Lightweight initial list to populate the picker quickly. The picker opens at the root, so
   * return the configured connections (no DB round-trip) rather than scanning every database.
   */
  async getInitialObjects(): Promise<DbObject[]> {
    const results = await this.getConnections();
    this._cache = results;
    return results;
  }

  private _getConn(connectionId: string): any | undefined {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    return connections.find(c => c.id === connectionId);
  }

  /**
   * Flat catalog (name/schema/type) for a single database, built with ONE query and cached
   * (5-min TTL) via {@link SchemaCache}. Keystroke filtering runs against this in memory.
   */
  private async getDatabaseCatalog(connectionId: string, database: string): Promise<DbObject[]> {
    const conn = this._getConn(connectionId);
    if (!conn) return [];
    const connName = conn.name || conn.host;
    const key = SchemaCache.buildKey(connectionId, database, undefined, 'obj-catalog');

    return this._dbListCache.getOrFetch<DbObject[]>(key, async () => {
      let client: PoolClient | undefined;
      try {
        client = await ConnectionManager.getInstance().getPooledClient({
          id: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          database,
          name: conn.name
        });
        if (!client) return [];

        const res = await client.query(
          `SELECT CASE c.relkind
                    WHEN 'v' THEN 'view'
                    WHEN 'm' THEN 'materialized-view'
                    ELSE 'table'
                  END AS type,
                  n.nspname AS schema, c.relname AS name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
           UNION ALL
           SELECT 'function' AS type, n.nspname AS schema, p.proname AS name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           LIMIT 5000`
        );

        return res.rows.map((row: any) => ({
          name: row.name,
          type: row.type as DbObjectType,
          schema: row.schema,
          database,
          connectionId: conn.id,
          connectionName: connName,
          breadcrumb: `${connName} > ${database} > ${row.schema} > ${row.name}`,
          isContainer: false
        }));
      } catch (e) {
        console.error('[ChatView] Catalog build error for db ' + database + ':', e);
        return [];
      } finally {
        if (client) client.release();
      }
    }, 300000);
  }

  /**
   * Query the local dbindex for this connection+database when an index has been built. Returns
   * mapped {@link DbObject}s, or null when no index exists / no hits (caller falls back to catalog).
   */
  private async _searchLocalIndex(connectionId: string, database: string, query: string): Promise<DbObject[] | null> {
    if (!extensionContext) return null;
    try {
      const { IndexStore } = await import('../../features/dbindex/IndexStore');
      const { IndexQueryService } = await import('../../features/dbindex/IndexQueryService');
      const store = new IndexStore(extensionContext.globalStorageUri);
      const queryService = new IndexQueryService(store);
      const hits = await queryService.search(connectionId, database, query, this.MAX_RESULTS);
      if (!hits || hits.length === 0) return null;

      const conn = this._getConn(connectionId);
      const connName = conn ? (conn.name || conn.host) : '';
      return hits.map(h => {
        const parts = h.ref.split('.');
        const schema = parts[0] || 'public';
        const name = parts[1] || h.ref;
        return {
          name,
          type: this._indexKindToType(h.kind),
          schema,
          database,
          connectionId,
          connectionName: connName,
          breadcrumb: `${connName} > ${database} > ${schema} > ${name}`,
          isContainer: false
        } as DbObject;
      });
    } catch (e) {
      debugLog('[ChatView] Local index search bypassed or failed:', e);
      return null;
    }
  }

  /**
   * Global object search across every built local index (all connections × databases). Reads only
   * on-disk index shards — no live DB connections — so it stays fast even with many connections.
   * Returns [] when no index has been built yet.
   */
  private async searchAllIndexes(query: string, limit: number): Promise<DbObject[]> {
    if (!extensionContext) { return []; }
    try {
      const { IndexStore } = await import('../../features/dbindex/IndexStore');
      const { IndexQueryService } = await import('../../features/dbindex/IndexQueryService');
      const store = new IndexStore(extensionContext.globalStorageUri);

      // Cache the built-index list briefly so incremental typing doesn't re-scan manifests.
      const now = Date.now();
      if (!this._indexedDbsCache || now - this._indexedDbsCache.ts > 30000) {
        this._indexedDbsCache = { list: await store.listIndexedDatabases(), ts: now };
      }
      const indexed = this._indexedDbsCache.list;
      if (indexed.length === 0) { return []; }

      const queryService = new IndexQueryService(store);
      const perLimit = Math.max(5, Math.ceil(limit / indexed.length));
      const collected: Array<{ obj: DbObject; score: number }> = [];

      for (const { connectionId, database } of indexed) {
        const hits = await queryService.search(connectionId, database, query, perLimit);
        if (!hits || hits.length === 0) { continue; }
        const conn = this._getConn(connectionId);
        const connName = conn ? (conn.name || conn.host) : connectionId;
        for (const h of hits) {
          const parts = h.ref.split('.');
          const schema = parts[0] || 'public';
          const name = parts[1] || h.ref;
          collected.push({
            score: h.score,
            obj: {
              name,
              type: this._indexKindToType(h.kind),
              schema,
              database,
              connectionId,
              connectionName: connName,
              breadcrumb: `${connName} > ${database} > ${schema} > ${name}`,
              isContainer: false
            }
          });
        }
      }

      collected.sort((a, b) => b.score - a.score);
      return collected.slice(0, limit).map(c => c.obj);
    } catch (e) {
      debugLog('[ChatView] Global index search failed:', e);
      return [];
    }
  }

  private _indexKindToType(kind: string): DbObjectType {
    switch (kind) {
      case 'view': return 'view';
      case 'materialized_view':
      case 'materialized-view':
      case 'matview': return 'materialized-view';
      case 'function': return 'function';
      case 'type': return 'type';
      default: return 'table';
    }
  }

  private async fetchDbObjectsBySearch(query: string, maxResults: number, allowEmptyQuery: boolean): Promise<DbObject[]> {
    const objects: DbObject[] = [];
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];

    if (connections.length === 0) return objects;
    if (!allowEmptyQuery && query.length < this.SEARCH_MIN_CHARS) return objects;

    const like = `%${query}%`;
    const perDbLimit = 25;

    for (const conn of connections) {
      if (objects.length >= maxResults) break;

      let client: PoolClient | undefined;
      try {
        const connName = conn.name || conn.host;

        client = await ConnectionManager.getInstance().getPooledClient({
          id: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          database: 'postgres',
          name: conn.name
        });

        if (!client) {
          throw new Error('Failed to acquire connection client');
        }
        const clientRef = client;

        const dbListKey = SchemaCache.buildKey(conn.id, 'postgres', undefined, 'db-list');
        const dbResult = await this._dbListCache.getOrFetch(dbListKey, async () => {
          return await clientRef.query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
          );
        }, 300000);

        for (const dbRow of dbResult.rows) {
          if (objects.length >= maxResults) break;

          const dbName = dbRow.datname;
          let dbClient: PoolClient | undefined;

          try {
            dbClient = await ConnectionManager.getInstance().getPooledClient({
              id: conn.id,
              host: conn.host,
              port: conn.port,
              username: conn.username,
              database: dbName,
              name: conn.name
            });

            if (query.length > 0) {
              const searchResult = await dbClient.query(
                `SELECT 'table' as type, n.nspname as schema, c.relname as name
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                   AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
                   AND c.relname ILIKE $1
                 UNION ALL
                 SELECT 'function' as type, n.nspname as schema, p.proname as name
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                   AND p.proname ILIKE $1
                 LIMIT $2`,
                [like, perDbLimit]
              );

              for (const row of searchResult.rows) {
                if (objects.length >= maxResults) break;
                objects.push({
                  name: row.name,
                  type: row.type,
                  schema: row.schema,
                  database: dbName,
                  connectionId: conn.id,
                  connectionName: connName,
                  breadcrumb: `${connName} > ${dbName} > ${row.schema} > ${row.name}`
                });
              }
            } else if (allowEmptyQuery) {
              const initialResult = await dbClient.query(
                `SELECT 'table' as type, n.nspname as schema, c.relname as name
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                   AND c.relkind IN ('r', 'v', 'm')
                 ORDER BY c.relpages DESC NULLS LAST
                 LIMIT $1`,
                [perDbLimit]
              );

              for (const row of initialResult.rows) {
                if (objects.length >= maxResults) break;
                objects.push({
                  name: row.name,
                  type: row.type,
                  schema: row.schema,
                  database: dbName,
                  connectionId: conn.id,
                  connectionName: connName,
                  breadcrumb: `${connName} > ${dbName} > ${row.schema} > ${row.name}`
                });
              }
            }
          } catch (e) {
            console.error('[ChatView] Search error in db ' + dbName + ':', e);
          } finally {
            if (dbClient) dbClient.release();
          }
        }
      } catch (e) {
        console.error('[ChatView] Search error in connection ' + conn.name + ':', e);
      } finally {
        if (client) client.release();
      }
    }

    return objects;
  }

  /**
   * Cache holds the STRUCTURED {@link TableSchema} for tables (so relevance ranking +
   * truncation re-run per request) and rendered markdown strings for other object types.
   */
  private _objectSchemaCache: Map<string, TableSchema | string> = new Map();
  private readonly MAX_CACHE_SIZE = 50;

  /**
   * Resolve schema context for an `@mention`. For tables the structured schema is cached and
   * re-rendered per request (ranked against {@link ctx}.userMessage and byte-capped). Other
   * object types are cached as rendered markdown.
   *
   * On fetch failure, retries with backoff (P1.5) and finally returns a structured
   * `<schema unavailable for …>` marker instead of a raw error string.
   */
  async getObjectSchema(obj: DbObject, ctx?: SchemaRenderContext): Promise<string> {
    const cacheKey = `${obj.connectionId}:${obj.schema}:${obj.name}:${obj.type}`;

    // Check memory cache first
    if (this._objectSchemaCache.has(cacheKey)) {
      debugLog('[ChatView] Cache hit for:', cacheKey);
      const cached = this._objectSchemaCache.get(cacheKey)!;
      // Refresh LRU order (delete and re-add)
      this._objectSchemaCache.delete(cacheKey);
      this._objectSchemaCache.set(cacheKey, cached);
      return typeof cached === 'string'
        ? cached
        : renderTableSchema(cached, { userMessage: ctx?.userMessage });
    }

    // Check local database index first
    try {
      if (extensionContext) {
        const { IndexStore } = await import('../../features/dbindex/IndexStore');
        const { IndexQueryService } = await import('../../features/dbindex/IndexQueryService');
        const { mapObjectEntryToTableSchema } = await import('../../features/dbindex/contextPack');
        
        const store = new IndexStore(extensionContext.globalStorageUri);
        const queryService = new IndexQueryService(store);
        const entry = await queryService.describe(obj.connectionId, obj.database, `${obj.schema}.${obj.name}`);
        if (entry) {
          debugLog('[ChatView] Local index hit for:', obj.schema + '.' + obj.name);
          const mapped = mapObjectEntryToTableSchema(obj.schema, obj.name, entry);
          this._objectSchemaCache.set(cacheKey, mapped);
          return renderTableSchema(mapped, { userMessage: ctx?.userMessage });
        }
      }
    } catch (e) {
      debugLog('[ChatView] Local index read bypassed or failed:', e);
    }

    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === obj.connectionId);
    if (!conn) {
      debugLog(
        '[ChatView] getObjectSchema: no configured connection matches connectionId=%s (known ids: %s)',
        obj.connectionId,
        connections.map(c => c.id).join(', ') || '<none>'
      );
      // P1.5: same structured marker as the catch-block below — this is what triggers the
      // `schemaError` toast in _composeUserTurnPayload. A bare string here used to fail silently:
      // it got baked into the schema-context block sent to the model with no user-visible warning.
      return `<schema unavailable for ${obj.schema}.${obj.name}: connection "${obj.connectionId}" not found>`;
    }

    try {
      const fetched = await this._fetchObjectSchemaWithRetry(conn, obj);

      // Update cache with LRU eviction
      if (this._objectSchemaCache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this._objectSchemaCache.keys().next().value;
        if (firstKey) this._objectSchemaCache.delete(firstKey);
      }
      this._objectSchemaCache.set(cacheKey, fetched);

      return typeof fetched === 'string'
        ? fetched
        : renderTableSchema(fetched, { userMessage: ctx?.userMessage });
    } catch (e) {
      // P1.5: structured marker, never a raw error string injected into the prompt.
      const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 120);
      return `<schema unavailable for ${obj.schema}.${obj.name}: ${reason}>`;
    }
  }

  /** Fetch one object's schema (structured for tables, markdown otherwise) with retry + backoff. */
  private async _fetchObjectSchemaWithRetry(conn: any, obj: DbObject): Promise<TableSchema | string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < SCHEMA_FETCH_MAX_ATTEMPTS; attempt++) {
      let client: PoolClient | undefined;
      try {
        client = await ConnectionManager.getInstance().getPooledClient({
          id: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          database: obj.database,
          name: conn.name
        });
        if (!client) {
          throw new Error('Failed to acquire database client');
        }

        switch (obj.type) {
          case 'table':
            return await this._fetchTableSchema(client, obj.schema, obj.name);
          case 'view':
            return await this._getViewSchema(client, obj.schema, obj.name);
          case 'function':
            return await this._getFunctionSchema(client, obj.schema, obj.name);
          case 'procedure':
            return await this._getProcedureSchema(client, obj.schema, obj.name);
          case 'materialized-view':
            return await this._getMaterializedViewSchema(client, obj.schema, obj.name);
          case 'type':
            return await this._getTypeSchema(client, obj.schema, obj.name);
          case 'schema':
            return await this._getSchemaInfo(client, obj.schema);
          case 'aggregate':
            return await this._getAggregateSchema(client, obj.schema, obj.name);
          default:
            return 'Unknown object type';
        }
      } catch (e) {
        lastErr = e;
        if (attempt < SCHEMA_FETCH_MAX_ATTEMPTS - 1) {
          const delay = Math.min(SCHEMA_FETCH_BASE_DELAY_MS * 2 ** attempt, SCHEMA_FETCH_MAX_DELAY_MS);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } finally {
        if (client) client.release();
      }
    }
    throw lastErr;
  }

  clearCache(): void {
    this._objectSchemaCache.clear();
    this._dbListCache.clear();
    debugLog('[ChatView] Schema caches cleared');
  }

  /** Convert serialized tree item from drag-and-drop into a DbObject. */
  static buildDbObjectFromTreeItem(item: SerializedTreeItem): DbObject {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === item.connectionId);
    const connectionName = conn?.name || conn?.host || 'Unknown';
    const schema = item.schema || '';

    const database = item.databaseName || '';

    if (item.type === 'column') {
      const tableRef = item.tableName || '';
      return {
        name: `${tableRef}.${item.label}`,
        type: 'column',
        schema,
        database,
        connectionId: item.connectionId,
        connectionName,
        breadcrumb: [connectionName, database, schema, tableRef, item.label].filter(Boolean).join(' > '),
      };
    }

    const breadcrumbParts = [connectionName, database, schema, item.label].filter(Boolean);
    return {
      name: item.label,
      type: item.type as DbObject['type'],
      schema,
      database,
      connectionId: item.connectionId,
      connectionName,
      breadcrumb: breadcrumbParts.join(' > '),
    };
  }

  /**
   * Fetch a table's structured schema. P1.2: the four catalog reads (columns, combined
   * PK+FK constraints, indexes, row estimate) run concurrently via `Promise.all`, collapsing
   * what used to be five sequential round-trips into a single round-trip's worth of latency.
   * All SQL stays parameterized.
   */
  private async _fetchTableSchema(client: any, schema: string, table: string): Promise<TableSchema> {
    const colsRes = await client.query(
      'SELECT column_name, data_type, is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      [schema, table]
    );
    const constraintsRes = await client.query(
      `SELECT tc.constraint_type, tc.constraint_name, kcu.column_name, kcu.ordinal_position,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       LEFT JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
       WHERE tc.table_schema = $1 AND tc.table_name = $2
         AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
       ORDER BY tc.constraint_type, kcu.ordinal_position`,
      [schema, table]
    );
    const idxRes = await client.query(
      'SELECT i.relname as index_name, ix.indisunique, ix.indisprimary, array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) WHERE n.nspname = $1 AND t.relname = $2 GROUP BY i.relname, ix.indisunique, ix.indisprimary',
      [schema, table]
    );
    const countRes = await client.query(
      'SELECT reltuples::bigint as estimate FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)',
      [table, schema]
    );

    const columns: ColumnInfo[] = colsRes.rows.map((col: any) => {
      let dtype = col.data_type;
      if (col.character_maximum_length) { dtype += `(${col.character_maximum_length})`; }
      else if (col.numeric_precision) { dtype += `(${col.numeric_precision},${col.numeric_scale || 0})`; }
      return {
        name: col.column_name,
        dataType: dtype,
        isNullable: col.is_nullable,
        default: col.column_default ?? null,
      };
    });

    const pk: string[] = [];
    const fks: ForeignKeyInfo[] = [];
    for (const row of constraintsRes.rows) {
      if (row.constraint_type === 'PRIMARY KEY') {
        pk.push(row.column_name);
      } else if (row.constraint_type === 'FOREIGN KEY') {
        fks.push({
          constraintName: row.constraint_name,
          column: row.column_name,
          refSchema: row.ref_schema,
          refTable: row.ref_table,
          refColumn: row.ref_column,
        });
      }
    }

    const indexes: IndexInfo[] = idxRes.rows.map((idx: any) => ({
      name: idx.index_name,
      // pg driver may return an array or a brace-wrapped string depending on version.
      columns: Array.isArray(idx.columns)
        ? idx.columns
        : String(idx.columns || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean),
      isUnique: !!idx.indisunique,
      isPrimary: !!idx.indisprimary,
    }));

    const rowEstimate = countRes.rows.length > 0 ? Number(countRes.rows[0].estimate) : null;

    return { schema, table, columns, pk, fks, indexes, rowEstimate };
  }

  private async _getViewSchema(client: any, schema: string, view: string): Promise<string> {
    let info = `## View: ${schema}.${view}\n\n`;

    const cols = await client.query(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      [schema, view]
    );

    info += '### Columns\n| Column | Type |\n|--------|------|\n';
    for (const col of cols.rows) {
      info += `| ${col.column_name} | ${col.data_type} |\n`;
    }

    const def = await client.query('SELECT definition FROM pg_views WHERE schemaname = $1 AND viewname = $2', [schema, view]);
    if (def.rows.length > 0) {
      info += `\n### Definition\n\`\`\`sql\n${def.rows[0].definition}\`\`\`\n`;
    }

    return info;
  }

  private async _getFunctionSchema(client: any, schema: string, func: string): Promise<string> {
    const result = await client.query(
      'SELECT p.proname, pg_get_functiondef(p.oid) as definition, pg_get_function_arguments(p.oid) as arguments, pg_get_function_result(p.oid) as return_type, l.lanname as language, p.provolatile, p.proisstrict FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid JOIN pg_language l ON p.prolang = l.oid WHERE n.nspname = $1 AND p.proname = $2',
      [schema, func]
    );

    if (result.rows.length === 0) { return `Function ${schema}.${func} not found`; }

    const fn = result.rows[0];
    let info = `## Function: ${schema}.${fn.proname}\n\n`;
    info += `### Signature\n\`${fn.proname}(${fn.arguments}) → ${fn.return_type}\`\n\n`;
    info += `### Properties\n- Language: ${fn.language}\n`;
    const volatility = fn.provolatile === 'i' ? 'IMMUTABLE' : fn.provolatile === 's' ? 'STABLE' : 'VOLATILE';
    info += `- Volatility: ${volatility}\n`;
    info += `- Strict: ${fn.proisstrict ? 'Yes' : 'No'}\n\n`;
    info += `### Definition\n\`\`\`sql\n${fn.definition}\`\`\`\n`;

    return info;
  }

  private async _getProcedureSchema(client: any, schema: string, proc: string): Promise<string> {
    const result = await client.query(
      `SELECT p.proname, pg_get_function_arguments(p.oid) as arguments, l.lanname as language,
              pg_get_functiondef(p.oid) as definition
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       JOIN pg_language l ON p.prolang = l.oid
       WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'p'`,
      [schema, proc]
    );

    if (result.rows.length === 0) { return `Procedure ${schema}.${proc} not found`; }

    const p = result.rows[0];
    let info = `## Procedure: ${schema}.${p.proname}\n\n`;
    info += `### Signature\n\`CALL ${p.proname}(${p.arguments})\`\n\n`;
    info += `### Properties\n- Language: ${p.language}\n\n`;
    info += `### Definition\n\`\`\`sql\n${p.definition}\`\`\`\n`;

    return info;
  }

  private async _getAggregateSchema(client: any, schema: string, agg: string): Promise<string> {
    const result = await client.query(
      `SELECT p.proname, pg_get_function_arguments(p.oid) as arguments,
              pg_get_function_result(p.oid) as return_type,
              format_type(p.prorettype, NULL) as return_type_raw,
              obj_description(p.oid, 'pg_proc') as description
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'a'`,
      [schema, agg]
    );

    if (result.rows.length === 0) { return `Aggregate ${schema}.${agg} not found`; }

    const a = result.rows[0];
    let info = `## Aggregate: ${schema}.${a.proname}\n\n`;
    info += `### Signature\n\`${a.proname}(${a.arguments}) → ${a.return_type || a.return_type_raw}\`\n`;

    return info;
  }

  private async _getMaterializedViewSchema(client: any, schema: string, matview: string): Promise<string> {
    let info = `## Materialized View: ${schema}.${matview}\n\n`;

    const cols = await client.query(
      'SELECT attname as column_name, format_type(atttypid, atttypmod) as data_type FROM pg_attribute WHERE attrelid = (SELECT oid FROM pg_class WHERE relname = $2 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)) AND attnum > 0 AND NOT attisdropped ORDER BY attnum',
      [schema, matview]
    );

    info += '### Columns\n| Column | Type |\n|--------|------|\n';
    for (const col of cols.rows) {
      info += `| ${col.column_name} | ${col.data_type} |\n`;
    }

    const def = await client.query('SELECT definition FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2', [schema, matview]);
    if (def.rows.length > 0) {
      info += `\n### Definition\n\`\`\`sql\n${def.rows[0].definition}\`\`\`\n`;
    }

    return info;
  }

  private async _getTypeSchema(client: any, schema: string, typeName: string): Promise<string> {
    let info = `## Type: ${schema}.${typeName}\n\n`;

    const attrs = await client.query(
      'SELECT a.attname, format_type(a.atttypid, a.atttypmod) as data_type FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid JOIN pg_attribute a ON a.attrelid = t.typrelid WHERE n.nspname = $1 AND t.typname = $2 AND a.attnum > 0 ORDER BY a.attnum',
      [schema, typeName]
    );

    if (attrs.rows.length > 0) {
      info += '### Attributes\n| Name | Type |\n|------|------|\n';
      for (const attr of attrs.rows) {
        info += `| ${attr.attname} | ${attr.data_type} |\n`;
      }
    }

    return info;
  }

  private async _getSchemaInfo(client: any, schema: string): Promise<string> {
    let info = `## Schema: ${schema}\n\n`;

    const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'", [schema]);
    const views = await client.query('SELECT table_name FROM information_schema.views WHERE table_schema = $1', [schema]);
    const funcs = await client.query('SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1', [schema]);

    info += `### Summary\n- Tables: ${tables.rows.length}\n- Views: ${views.rows.length}\n- Functions: ${funcs.rows.length}\n\n`;

    if (tables.rows.length > 0) {
      info += '### Tables\n' + tables.rows.map((r: any) => `- ${r.table_name}`).join('\n') + '\n\n';
    }
    if (views.rows.length > 0) {
      info += '### Views\n' + views.rows.map((r: any) => `- ${r.table_name}`).join('\n') + '\n\n';
    }
    if (funcs.rows.length > 0) {
      info += '### Functions\n' + funcs.rows.map((r: any) => `- ${r.routine_name}`).join('\n') + '\n';
    }

    return info;
  }

  getCache(): DbObject[] {
    return this._cache;
  }

  searchObjects(query: string): DbObject[] {
    const lowerQuery = query.toLowerCase();
    return this._cache.filter(obj =>
      obj.name.toLowerCase().includes(lowerQuery) ||
      obj.type.toLowerCase().includes(lowerQuery) ||
      obj.schema.toLowerCase().includes(lowerQuery)
    ).slice(0, 20);
  }
}
