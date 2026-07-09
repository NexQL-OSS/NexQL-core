/**
 * MCP resources backed by the on-disk database index (dbindex).
 *
 * Exposes every indexed database object as a browsable resource, plus the
 * per-database manifest and join graph:
 *
 *   nexql://<connectionId>/<database>/object/<schema>/<name>
 *   nexql://<connectionId>/<database>/manifest
 *   nexql://<connectionId>/<database>/joingraph
 *
 * Purely disk-backed — listing and reading never open a DB connection, so
 * they are fast and safe for clients to enumerate eagerly.
 */
import * as vscode from 'vscode';
import { IndexStore } from '../features/dbindex/IndexStore';

const PAGE_SIZE = 200;

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

interface CursorState {
  /** Index into the listIndexedDatabases() ordering. */
  db: number;
  /** Offset into the flattened resource list of that database. */
  offset: number;
}

function rpcError(code: number, message: string): Error {
  const err: any = new Error(message);
  err.rpcCode = code;
  return err;
}

export class McpResourceProvider {
  constructor(private readonly _globalStorageUri: vscode.Uri) {}

  private get _store(): IndexStore {
    return new IndexStore(this._globalStorageUri);
  }

  async list(cursor?: string): Promise<{ resources: McpResource[]; nextCursor?: string }> {
    const state = this._decodeCursor(cursor);
    const store = this._store;
    const databases = await store.listIndexedDatabases();

    const resources: McpResource[] = [];
    let dbIndex = state.db;
    let offset = state.offset;

    for (; dbIndex < databases.length; dbIndex++, offset = 0) {
      const { connectionId, database } = databases[dbIndex];
      const all = await this._listForDatabase(store, connectionId, database);
      const page = all.slice(offset, offset + (PAGE_SIZE - resources.length));
      resources.push(...page);

      if (offset + page.length < all.length) {
        // More remain in this database.
        return {
          resources,
          nextCursor: this._encodeCursor({ db: dbIndex, offset: offset + page.length })
        };
      }
      if (resources.length >= PAGE_SIZE && dbIndex + 1 < databases.length) {
        return {
          resources,
          nextCursor: this._encodeCursor({ db: dbIndex + 1, offset: 0 })
        };
      }
    }

    return { resources };
  }

  async read(uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
    const parsed = this._parseUri(uri);
    const store = this._store;
    const baseDir = store.getBaseDir(parsed.connectionId, parsed.database);
    const manifest = await store.readManifest(baseDir);
    if (!manifest) {
      throw rpcError(-32002, `Resource not found: no index for ${parsed.connectionId}/${parsed.database}`);
    }

    let payload: unknown;
    if (parsed.kind === 'manifest') {
      payload = manifest;
    } else if (parsed.kind === 'joingraph') {
      payload = await store.readJoinGraph(baseDir, manifest);
      if (!payload) {
        throw rpcError(-32002, `Resource not found: join graph missing for ${parsed.database}`);
      }
    } else {
      const entry = await store.getObjectEntry(baseDir, manifest, parsed.schema!, parsed.name!);
      if (!entry || entry.excluded) {
        throw rpcError(-32002, `Resource not found: ${uri}`);
      }
      payload = entry;
    }

    return {
      contents: [
        { uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }
      ]
    };
  }

  listTemplates(): { resourceTemplates: Array<Record<string, string>> } {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'nexql://{connectionId}/{database}/object/{schema}/{name}',
          name: 'Database object',
          description:
            'Structural card for an indexed table, view, materialized view, or function ' +
            '(columns, keys, indexes, definition). Use the search_schema tool to discover refs.',
          mimeType: 'application/json'
        }
      ]
    };
  }

  private async _listForDatabase(
    store: IndexStore,
    connectionId: string,
    database: string
  ): Promise<McpResource[]> {
    const baseDir = store.getBaseDir(connectionId, database);
    const manifest = await store.readManifest(baseDir);
    if (!manifest) {
      return [];
    }
    const overrides = await store.readOverrides(baseDir);
    const prefix = `nexql://${encodeURIComponent(connectionId)}/${encodeURIComponent(database)}`;

    const resources: McpResource[] = [
      {
        uri: `${prefix}/manifest`,
        name: `${database} index manifest`,
        description: `Index metadata for ${database} (schemas, counts, fingerprint, build time).`,
        mimeType: 'application/json'
      },
      {
        uri: `${prefix}/joingraph`,
        name: `${database} join graph`,
        description: `Declared and inferred foreign-key relationships between tables in ${database}.`,
        mimeType: 'application/json'
      }
    ];

    for (const shard of manifest.shards) {
      const entries = await store.readShardEntries(baseDir, shard.file);
      if (!entries) {
        continue;
      }
      for (const [ref, entry] of Object.entries(entries)) {
        if (entry.excluded || overrides?.objects?.[ref]?.excluded) {
          continue;
        }
        const [schema, ...nameParts] = ref.split('.');
        const name = nameParts.join('.');
        resources.push({
          uri: `${prefix}/object/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`,
          name: ref,
          description: `${entry.kind}${entry.comment ? ` — ${entry.comment}` : ''}`,
          mimeType: 'application/json'
        });
      }
    }
    return resources;
  }

  private _parseUri(uri: string): {
    connectionId: string;
    database: string;
    kind: 'object' | 'manifest' | 'joingraph';
    schema?: string;
    name?: string;
  } {
    const match = /^nexql:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri || '');
    if (!match) {
      throw rpcError(-32002, `Resource not found: ${uri}`);
    }
    const connectionId = decodeURIComponent(match[1]);
    const database = decodeURIComponent(match[2]);
    const rest = match[3];

    if (rest === 'manifest' || rest === 'joingraph') {
      return { connectionId, database, kind: rest };
    }
    const objectMatch = /^object\/([^/]+)\/([^/]+)$/.exec(rest);
    if (objectMatch) {
      return {
        connectionId,
        database,
        kind: 'object',
        schema: decodeURIComponent(objectMatch[1]),
        name: decodeURIComponent(objectMatch[2])
      };
    }
    throw rpcError(-32002, `Resource not found: ${uri}`);
  }

  private _encodeCursor(state: CursorState): string {
    return Buffer.from(JSON.stringify(state), 'utf-8').toString('base64');
  }

  private _decodeCursor(cursor?: string): CursorState {
    if (!cursor) {
      return { db: 0, offset: 0 };
    }
    try {
      const state = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
      if (typeof state?.db === 'number' && typeof state?.offset === 'number' && state.db >= 0 && state.offset >= 0) {
        return state;
      }
    } catch {
      // fall through
    }
    throw rpcError(-32602, 'Invalid cursor');
  }
}
