import * as vscode from 'vscode';
import type {
  CloudQuotaView,
  CloudSyncManifestEntry,
  SyncDeviceView,
  SyncProvider,
  SyncPushItem,
  SyncSnapshot,
  SyncItemMeta,
} from '../types';
import { AccountService } from '../AccountService';
import { getDeviceName, getOrCreateDeviceId } from '../deviceId';
import { httpRequest } from './httpUtils';
import { DEFAULT_SYNC_API_ENDPOINT } from '../constants';

/** NexQL Cloud sync backend (nexql.astrx.dev) — Sponsor+ tier. */
export class CloudSyncProvider implements SyncProvider {
  readonly id = 'cloud' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private baseUrl(): string {
    const configured = vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.apiEndpoint');
    return (configured?.trim()) || DEFAULT_SYNC_API_ENDPOINT;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    let token = await AccountService.getInstance().getAccessToken();
    if (!token) {
      token = await AccountService.getInstance().refreshAccessToken();
    }
    if (!token) {
      throw new Error('Not signed in to NexQL account');
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const deviceId = getOrCreateDeviceId(this.context);
    headers['X-Device-Id'] = deviceId;
    const deviceName = getDeviceName(this.context);
    if (deviceName) {
      headers['X-Device-Name'] = deviceName;
    }
    return headers;
  }

  async testConnection(): Promise<{ ok: boolean; account?: string; error?: string }> {
    try {
      const headers = await this.authHeaders();
      const res = await httpRequest(`${this.baseUrl()}/sync/manifest`, { headers });
      if (res.statusCode === 404) {
        const email = await AccountService.getInstance().getAccountEmail();
        return { ok: true, account: email };
      }
      if (res.statusCode >= 400) {
        return { ok: false, error: `API ${res.statusCode}` };
      }
      const email = await AccountService.getInstance().getAccountEmail();
      return { ok: true, account: email };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async pull(sinceRevision?: number): Promise<SyncSnapshot> {
    const headers = await this.authHeaders();
    const since = sinceRevision ? `?since=${sinceRevision}` : '';
    const res = await httpRequest(`${this.baseUrl()}/sync/manifest${since}`, { headers });

    if (res.statusCode === 404) {
      return { manifest: [], getBlob: async () => undefined };
    }

    const entries = JSON.parse(res.body.toString()) as CloudSyncManifestEntry[];
    const manifest: SyncItemMeta[] = entries.map((e) => ({
      id: e.item_id,
      kind: e.kind,
      contentHash: e.content_hash,
      revision: e.revision,
      updatedAt: new Date(e.updated_at).getTime(),
      deviceId: e.device_id,
      deleted: e.deleted,
    }));

    return {
      manifest,
      getBlob: async (id: string) => {
        const blobRes = await httpRequest(`${this.baseUrl()}/sync/items/${encodeURIComponent(id)}`, { headers });
        if (blobRes.statusCode === 404) {
          return undefined;
        }
        return blobRes.body;
      },
    };
  }

  async push(items: SyncPushItem[], options?: import('../types').SyncPushOptions): Promise<void> {
    const headers = {
      ...(await this.authHeaders()),
      'Content-Type': 'application/json',
    };

    for (const item of items) {
      const payload = JSON.stringify({
        kind: item.meta.kind,
        content_hash: item.meta.contentHash,
        revision: item.meta.revision,
        device_id: item.meta.deviceId,
        deleted: item.meta.deleted,
        blob: item.blob.toString('base64'),
      });

      await httpRequest(`${this.baseUrl()}/sync/items/${encodeURIComponent(item.meta.id)}`, {
        method: 'PUT',
        headers,
        body: payload,
      });
    }

    const { publishableManifest } = await import('../syncManifest');
    const manifest = options?.manifest ?? items.map((i) => i.meta);
    const remoteManifest = options?.manifest ? publishableManifest(manifest) : manifest;
    await httpRequest(`${this.baseUrl()}/sync/manifest`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(remoteManifest),
    });
  }

  async getQuota(): Promise<CloudQuotaView | undefined> {
    try {
      const headers = await this.authHeaders();
      const res = await httpRequest(`${this.baseUrl()}/sync/quota`, { headers });
      if (res.statusCode >= 400) {
        return undefined;
      }
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
    } catch {
      return undefined;
    }
  }

  async listDevices(): Promise<SyncDeviceView[]> {
    const headers = await this.authHeaders();
    const res = await httpRequest(`${this.baseUrl()}/sync/devices`, { headers });
    if (res.statusCode >= 400) {
      return [];
    }
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
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const headers = await this.authHeaders();
    const res = await httpRequest(
      `${this.baseUrl()}/sync/devices/${encodeURIComponent(deviceId)}`,
      { method: 'DELETE', headers },
    );
    return res.statusCode === 204;
  }
}
