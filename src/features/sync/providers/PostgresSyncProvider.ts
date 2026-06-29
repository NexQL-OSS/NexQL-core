import * as vscode from 'vscode';
import type { PushResult, SyncDelta, SyncOp, SyncProviderV2 } from '../types';
import { ConnectionManager } from '../../../services/ConnectionManager';
import { getOrCreateDeviceId } from '../deviceId';
import { LicenseService } from '../../../services/LicenseService';

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  release: () => void;
};

/**
 * Self-hosted sync backend via the nexql_sync schema in a Postgres DB the
 * user controls. Implements the same git-like v2 protocol as the cloud: a
 * monotonic cursor, atomic compare-and-swap push, and a permanent delete log.
 *
 * The connection id only selects which database to talk to. The space_id (the
 * row namespace inside that DB) must be STABLE across a user's devices, so it is
 * keyed by license — every device of the same account, pointed at the same DB,
 * shares one sync stream. `default` is used when running without a license.
 */
export class PostgresSyncProvider implements SyncProviderV2 {
  readonly id = 'postgres' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private connectionId(): string | undefined {
    return vscode.workspace.getConfiguration().get<string>('postgresExplorer.sync.postgresConnectionId');
  }

  private space(): string {
    if (!this.connectionId()) {
      throw new Error('postgresExplorer.sync.postgresConnectionId not configured');
    }
    try {
      return LicenseService.getInstance().getLicenseKey() || 'default';
    } catch {
      return 'default';
    }
  }

  private async getClient(): Promise<Client> {
    const connId = this.connectionId();
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const config = connections.find((c) => c.id === connId);
    if (!config) {
      throw new Error('Sync Postgres connection not found');
    }
    return ConnectionManager.getInstance().getPooledClient(config);
  }

  private async ensureSchema(client: Client): Promise<void> {
    await client.query('CREATE SCHEMA IF NOT EXISTS nexql_sync');
    await client.query("CREATE SEQUENCE IF NOT EXISTS nexql_sync.cursor_seq");
    await client.query(
      `CREATE TABLE IF NOT EXISTS nexql_sync.items_v2 (
         space_id TEXT NOT NULL, item_id TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind IN ('connection','query','notebook')),
         blob BYTEA NOT NULL, content_hash TEXT NOT NULL,
         version BIGINT NOT NULL, device_id TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (space_id, item_id))`,
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS items_v2_cursor_idx ON nexql_sync.items_v2 (space_id, version)',
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS nexql_sync.deletes_v2 (
         space_id TEXT NOT NULL, item_id TEXT NOT NULL,
         version BIGINT NOT NULL, deleted_by TEXT NOT NULL,
         deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (space_id, item_id))`,
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS deletes_v2_cursor_idx ON nexql_sync.deletes_v2 (space_id, version)',
    );
  }

  async testConnection(): Promise<{ ok: boolean; account?: string; error?: string }> {
    try {
      const client = await this.getClient();
      try {
        await this.ensureSchema(client);
        return { ok: true, account: this.connectionId() };
      } finally {
        client.release();
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async spaceCursor(client: Client, space: string): Promise<number> {
    const res = await client.query(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(version) FROM nexql_sync.items_v2   WHERE space_id = $1), 0),
         COALESCE((SELECT MAX(version) FROM nexql_sync.deletes_v2 WHERE space_id = $1), 0)
       ) AS cursor`,
      [space],
    );
    return Number(res.rows[0]?.cursor || 0);
  }

  async pullDelta(since: number): Promise<SyncDelta> {
    const client = await this.getClient();
    const space = this.space();
    try {
      await this.ensureSchema(client);
      const items = await client.query(
        `SELECT item_id, kind, content_hash, version, device_id, blob, updated_at
         FROM nexql_sync.items_v2 WHERE space_id = $1 AND version > $2 ORDER BY version ASC`,
        [space, since],
      );
      const deletes = await client.query(
        `SELECT item_id FROM nexql_sync.deletes_v2 WHERE space_id = $1 AND version > $2 ORDER BY version ASC`,
        [space, since],
      );
      const cursor = await this.spaceCursor(client, space);
      return {
        cursor,
        upserts: items.rows.map((r) => ({
          meta: {
            id: r.item_id,
            kind: r.kind,
            contentHash: r.content_hash,
            version: Number(r.version),
            deviceId: r.device_id,
            updatedAt: new Date(r.updated_at).getTime(),
          },
          blob: Buffer.isBuffer(r.blob) ? r.blob : Buffer.from(r.blob),
        })),
        deletes: deletes.rows.map((r) => r.item_id),
      };
    } finally {
      client.release();
    }
  }

  async pushBatch(ops: SyncOp[]): Promise<PushResult> {
    const client = await this.getClient();
    const space = this.space();
    const device = getOrCreateDeviceId(this.context);
    const accepted: PushResult['accepted'] = [];
    const rejected: PushResult['rejected'] = [];
    try {
      await this.ensureSchema(client);
      await client.query('BEGIN');
      try {
        // Serialize concurrent pushers on the same space for a consistent cursor.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [space]);
        for (const op of ops) {
          const row = op.op === 'delete'
            ? await this.applyDelete(client, space, device, op)
            : await this.applyUpsert(client, space, device, op);
          if (row.new_version != null) {
            accepted.push({ itemId: op.itemId, version: Number(row.new_version) });
          } else {
            rejected.push({
              itemId: op.itemId,
              remoteVersion: row.remote_version == null ? null : Number(row.remote_version),
              remoteHash: row.remote_hash ?? null,
            });
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      const cursor = await this.spaceCursor(client, space);
      return { cursor, accepted, rejected };
    } finally {
      client.release();
    }
  }

  private async applyUpsert(client: Client, space: string, device: string, op: SyncOp): Promise<any> {
    const res = await client.query(
      `WITH existing AS (
         SELECT version, content_hash FROM nexql_sync.items_v2 WHERE space_id = $1 AND item_id = $2
       ), up AS (
         INSERT INTO nexql_sync.items_v2 (space_id, item_id, kind, blob, content_hash, version, device_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, nextval('nexql_sync.cursor_seq'), $6, now())
         ON CONFLICT (space_id, item_id) DO UPDATE
           SET kind = EXCLUDED.kind, blob = EXCLUDED.blob, content_hash = EXCLUDED.content_hash,
               version = nextval('nexql_sync.cursor_seq'), device_id = EXCLUDED.device_id, updated_at = now()
           WHERE nexql_sync.items_v2.version <= $7 OR nexql_sync.items_v2.content_hash = EXCLUDED.content_hash
         RETURNING version
       )
       SELECT (SELECT version FROM up) AS new_version,
              (SELECT version FROM existing) AS remote_version,
              (SELECT content_hash FROM existing) AS remote_hash`,
      [space, op.itemId, op.kind, op.blob ?? Buffer.alloc(0), op.contentHash, device, op.baseVersion],
    );
    return res.rows[0] ?? {};
  }

  private async applyDelete(client: Client, space: string, device: string, op: SyncOp): Promise<any> {
    const res = await client.query(
      `WITH existing AS (
         SELECT version FROM nexql_sync.items_v2 WHERE space_id = $1 AND item_id = $2
       ), del AS (
         DELETE FROM nexql_sync.items_v2
         WHERE space_id = $1 AND item_id = $2 AND version <= $3 RETURNING item_id
       ), logged AS (
         INSERT INTO nexql_sync.deletes_v2 (space_id, item_id, version, deleted_by, deleted_at)
         SELECT $1, $2, nextval('nexql_sync.cursor_seq'), $4, now()
         WHERE EXISTS (SELECT 1 FROM del) OR NOT EXISTS (SELECT 1 FROM existing)
         ON CONFLICT (space_id, item_id) DO UPDATE
           SET version = nextval('nexql_sync.cursor_seq'), deleted_by = EXCLUDED.deleted_by, deleted_at = now()
         RETURNING version
       )
       SELECT (SELECT version FROM logged) AS new_version,
              (SELECT version FROM existing) AS remote_version,
              NULL::text AS remote_hash`,
      [space, op.itemId, op.baseVersion, device],
    );
    return res.rows[0] ?? {};
  }

  async resetSpace(): Promise<void> {
    const client = await this.getClient();
    const space = this.space();
    try {
      await this.ensureSchema(client);
      await client.query('DELETE FROM nexql_sync.items_v2 WHERE space_id = $1', [space]);
      await client.query('DELETE FROM nexql_sync.deletes_v2 WHERE space_id = $1', [space]);
    } finally {
      client.release();
    }
  }
}
