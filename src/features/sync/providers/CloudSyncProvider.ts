import * as vscode from 'vscode';
import type {
  CloudQuotaView,
  PushResult,
  SyncDelta,
  SyncDeviceView,
  SyncOp,
  SyncProviderV2,
} from '../types';
import { AccountService } from '../AccountService';
import { withAuthRetry } from '../syncAuth';
import { getOrCreateDeviceId } from '../deviceId';
import { httpRequest } from './httpUtils';
import { DEFAULT_SYNC_API_ENDPOINT } from '../constants';

interface RawDelta {
  cursor: number;
  upserts: Array<{
    item_id: string;
    kind: 'connection' | 'query' | 'notebook';
    content_hash: string;
    version: number;
    device_id: string;
    blob: string;
    updated_at: string;
  }>;
  deletes: string[];
}

/** NexQL Cloud sync backend (nexql.astrx.dev) — git-like v2 protocol. */
export class CloudSyncProvider implements SyncProviderV2 {
  readonly id = 'cloud' as const;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly spaceId?: string,
  ) {}

  private baseUrl(): string {
    const configured = vscode.workspace.getConfiguration().get<string>('postgresExplorer.sync.apiEndpoint');
    return configured?.trim() || DEFAULT_SYNC_API_ENDPOINT;
  }

  async testConnection(): Promise<{ ok: boolean; account?: string; error?: string }> {
    try {
      await withAuthRetry(
        this.context,
        (headers) => httpRequest(`${this.baseUrl()}/sync/v2-pull?since=0${this.spaceQuery()}`, { headers }),
        () => undefined,
        'Connection test',
      );
      return { ok: true, account: await AccountService.getInstance(this.context).getAccountEmail() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private spaceQuery(): string {
    return this.spaceId ? `&space=${encodeURIComponent(this.spaceId)}` : '';
  }

  async pullDelta(since: number): Promise<SyncDelta> {
    return withAuthRetry(
      this.context,
      (headers) => httpRequest(
        `${this.baseUrl()}/sync/v2-pull?since=${since}${this.spaceQuery()}`,
        { headers },
      ),
      (res) => {
        const raw = JSON.parse(res.body.toString()) as RawDelta;
        return {
          cursor: Number(raw.cursor) || 0,
          upserts: raw.upserts.map((u) => ({
            meta: {
              id: u.item_id,
              kind: u.kind,
              contentHash: u.content_hash,
              version: Number(u.version),
              deviceId: u.device_id,
              updatedAt: new Date(u.updated_at).getTime(),
            },
            blob: Buffer.from(u.blob, 'base64'),
          })),
          deletes: raw.deletes ?? [],
        };
      },
      'Pull failed',
    );
  }

  async pushBatch(ops: SyncOp[]): Promise<PushResult> {
    const body = JSON.stringify({
      space: this.spaceId,
      ops: ops.map((op) => ({
        op: op.op,
        item_id: op.itemId,
        kind: op.kind,
        base_version: op.baseVersion,
        content_hash: op.contentHash,
        blob: op.blob ? op.blob.toString('base64') : undefined,
      })),
    });
    return withAuthRetry(
      this.context,
      (headers) => httpRequest(`${this.baseUrl()}/sync/v2-push`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      }),
      (res) => {
        const raw = JSON.parse(res.body.toString()) as {
          cursor: number;
          accepted: Array<{ item_id: string; version: number }>;
          rejected: Array<{ item_id: string; remote_version: number | null; remote_hash: string | null }>;
        };
        return {
          cursor: Number(raw.cursor) || 0,
          accepted: raw.accepted.map((a) => ({ itemId: a.item_id, version: Number(a.version) })),
          rejected: raw.rejected.map((r) => ({
            itemId: r.item_id,
            remoteVersion: r.remote_version == null ? null : Number(r.remote_version),
            remoteHash: r.remote_hash,
          })),
        };
      },
      'Push failed',
    );
  }

  async resetSpace(): Promise<void> {
    await withAuthRetry(
      this.context,
      (headers) => httpRequest(`${this.baseUrl()}/sync/v2-reset`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ space: this.spaceId }),
      }),
      () => undefined,
      'Reset failed',
    );
  }

  async getQuota(): Promise<CloudQuotaView | undefined> {
    try {
      return await withAuthRetry(
        this.context,
        (headers) => httpRequest(`${this.baseUrl()}/sync/quota`, { headers }),
        (res) => {
          const data = JSON.parse(res.body.toString()) as {
            tier: string;
            bytes_used: number;
            bytes_limit: number;
            item_count: number;
          };
          return {
            tier: data.tier,
            bytesUsed: data.bytes_used,
            bytesLimit: data.bytes_limit,
            itemCount: data.item_count,
          };
        },
        'Quota fetch',
      );
    } catch {
      return undefined;
    }
  }

  async listDevices(): Promise<SyncDeviceView[]> {
    try {
      return await withAuthRetry(
        this.context,
        (headers) => httpRequest(`${this.baseUrl()}/sync/devices`, { headers }),
        (res) => {
          const rows = JSON.parse(res.body.toString()) as Array<{
            device_id: string;
            device_name?: string;
            last_seen: string;
          }>;
          const thisId = getOrCreateDeviceId(this.context);
          return rows.map((r) => ({
            deviceId: r.device_id,
            deviceName: r.device_name,
            lastSeen: r.last_seen,
            isThisDevice: r.device_id === thisId,
          }));
        },
        'List devices',
      );
    } catch {
      return [];
    }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    try {
      const res = await withAuthRetry(
        this.context,
        (headers) => httpRequest(`${this.baseUrl()}/sync/devices/${encodeURIComponent(deviceId)}`, {
          method: 'DELETE',
          headers,
        }),
        (r) => r,
        'Revoke device',
      );
      return res.statusCode === 204;
    } catch {
      return false;
    }
  }
}
