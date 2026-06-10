import * as vscode from 'vscode';
import type { SyncProvider, SyncPushItem, SyncSnapshot, SyncItemMeta } from '../types';
import { ConnectionManager } from '../../../services/ConnectionManager';
/**
 * Optional team-sharing backend via pgstudio_sync schema in a shared Postgres DB.
 * Uses the connection configured in postgresExplorer.sync.postgresConnectionId.
 */
export class PostgresSyncProvider implements SyncProvider {
  readonly id = 'postgres' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private connectionId(): string | undefined {
    return vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.postgresConnectionId');
  }

  private async getClient(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void }> {
    const connId = this.connectionId();
    if (!connId) {
      throw new Error('postgresExplorer.sync.postgresConnectionId not configured');
    }
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const config = connections.find((c) => c.id === connId);
    if (!config) {
      throw new Error('Sync Postgres connection not found');
    }
    const client = await ConnectionManager.getInstance().getPooledClient(config);
    return client;
  }

  async testConnection(): Promise<{ ok: boolean; account?: string; error?: string }> {
    try {
      const client = await this.getClient();
      try {
        await client.query('SELECT 1 FROM pgstudio_sync.sync_items LIMIT 1');
        return { ok: true, account: this.connectionId() };
      } catch {
        return { ok: false, error: 'pgstudio_sync schema not found — run migration first' };
      } finally {
        client.release();
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async pull(_sinceRevision?: number): Promise<SyncSnapshot> {
    const client = await this.getClient();
    const accountId = this.connectionId()!;

    try {
      // Tombstones included — deletes must propagate to other devices.
      const rows = await client.query(
        `SELECT item_id, kind, content_hash, revision, device_id, deleted, updated_at, blob
         FROM pgstudio_sync.sync_items
         WHERE account_id = $1`,
        [accountId],
      );

      const manifest: SyncItemMeta[] = (rows.rows as any[]).map((r) => ({
        id: r.item_id,
        kind: r.kind,
        contentHash: r.content_hash,
        revision: r.revision,
        updatedAt: new Date(r.updated_at).getTime(),
        deviceId: r.device_id,
        deleted: r.deleted,
      }));

      const blobMap = new Map<string, Buffer>();
      for (const r of rows.rows as any[]) {
        blobMap.set(r.item_id, Buffer.isBuffer(r.blob) ? r.blob : Buffer.from(r.blob));
      }

      return {
        manifest,
        getBlob: async (id: string) => blobMap.get(id),
      };
    } finally {
      client.release();
    }
  }

  async push(items: SyncPushItem[], _options?: import('../types').SyncPushOptions): Promise<void> {
    const client = await this.getClient();
    const accountId = this.connectionId()!;

    try {
      for (const item of items) {
        await client.query(
          `INSERT INTO pgstudio_sync.sync_items
             (account_id, item_id, kind, blob, content_hash, revision, device_id, deleted, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (account_id, item_id) DO UPDATE SET
             kind = EXCLUDED.kind,
             blob = EXCLUDED.blob,
             content_hash = EXCLUDED.content_hash,
             revision = EXCLUDED.revision,
             device_id = EXCLUDED.device_id,
             deleted = EXCLUDED.deleted,
             updated_at = now()`,
          [
            accountId,
            item.meta.id,
            item.meta.kind,
            item.meta.deleted ? Buffer.alloc(0) : item.blob,
            item.meta.contentHash,
            item.meta.revision,
            item.meta.deviceId,
            item.meta.deleted,
          ],
        );
      }
    } finally {
      client.release();
    }
  }

  private async ensureMetaTable(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Promise<void> {
    await client.query(
      `CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_meta (
         account_id      TEXT        PRIMARY KEY,
         bound_device_id TEXT,
         updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  }

  async getBoundDeviceId(): Promise<string | undefined> {
    const client = await this.getClient();
    try {
      await this.ensureMetaTable(client);
      const res = await client.query(
        'SELECT bound_device_id FROM pgstudio_sync.sync_meta WHERE account_id = $1',
        [this.connectionId()!],
      );
      const row = res.rows[0] as { bound_device_id?: string } | undefined;
      return row?.bound_device_id ?? undefined;
    } finally {
      client.release();
    }
  }

  async setBoundDeviceId(deviceId: string): Promise<void> {
    const client = await this.getClient();
    try {
      await this.ensureMetaTable(client);
      await client.query(
        `INSERT INTO pgstudio_sync.sync_meta (account_id, bound_device_id, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (account_id) DO UPDATE SET
           bound_device_id = EXCLUDED.bound_device_id,
           updated_at = now()`,
        [this.connectionId()!, deviceId],
      );
    } finally {
      client.release();
    }
  }
}
