import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as vscode from 'vscode';
import { AccountService } from './AccountService';
import { VaultService } from './VaultService';
import { SyncController } from './SyncController';
import { SavedQueriesService } from '../savedQueries/SavedQueriesService';
import { NotebookSyncService } from './NotebookSyncService';
import { SyncIndex } from './SyncIndex';
import { getOrCreateDeviceId } from './deviceId';
import { DEFAULT_SYNC_API_ENDPOINT } from './constants';
import {
  decryptWithShareKey,
  encryptWithShareKey,
  generateShareKey,
  openSealed,
  sealTo,
} from './shareCrypto';
import { materializeShared, scrubForShare, type SharedItemPayload } from './shareScrub';
import type { SyncKind } from './types';

export interface IncomingShare {
  shareId: string;
  ownerEmail: string;
  kind: SyncKind;
  name?: string;
  shareBlob: string;
  wrappedKey: string;
  createdAt: string;
}

export type ImportMode = 'merge' | 'copy';

/**
 * Team sharing over the NexQL Cloud backend. Owners seal selected items to a
 * grantee's X25519 public key; grantees import them, merging with or copying
 * into their own library — never receiving the owner's connection or secrets.
 */
export class SharingService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private endpoint(): string {
    const configured = vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.apiEndpoint');
    return (configured?.trim() || DEFAULT_SYNC_API_ENDPOINT).replace(/\/$/, '');
  }

  /** Publish this vault's public key so others can share to this account. */
  async registerPublicKey(): Promise<void> {
    const publicKey = await VaultService.getInstance().getIdentityPublicKey();
    await this.request('POST', '/sync/keys', { public_key: publicKey });
  }

  private async fetchPublicKey(email: string): Promise<string> {
    const res = await this.request<{ public_key?: string }>(
      'GET',
      `/sync/keys?email=${encodeURIComponent(email)}`,
    );
    if (!res?.public_key) {
      throw new Error(`No NexQL identity found for ${email}. Ask them to enable sync first.`);
    }
    return res.public_key;
  }

  /** Seal the given local items to a grantee and create server-side shares. */
  async shareItems(granteeEmail: string, itemIds: string[]): Promise<number> {
    const controller = SyncController.getInstance();
    const recipientPublicKey = await this.fetchPublicKey(granteeEmail);

    // One share key per batch, sealed once to the grantee and reused per item.
    const shareKey = generateShareKey();
    const wrappedKey = sealTo(recipientPublicKey, Buffer.from(shareKey, 'base64'));

    const items: Array<{ share_id: string; kind: SyncKind; name: string; share_blob: string; wrapped_key: string }> = [];
    for (const id of itemIds) {
      const local = await controller.getShareableItem(id);
      if (!local) {
        continue;
      }
      const scrubbed = scrubForShare(local.kind, local.raw);
      const shareBlob = encryptWithShareKey(shareKey, Buffer.from(JSON.stringify(scrubbed)));
      items.push({
        share_id: crypto.randomUUID(),
        kind: local.kind,
        name: local.name,
        share_blob: shareBlob,
        wrapped_key: wrappedKey,
      });
    }

    if (items.length === 0) {
      return 0;
    }
    await this.request('POST', '/sync/shares', { grantee_email: granteeEmail, items });
    return items.length;
  }

  async listIncomingShares(): Promise<IncomingShare[]> {
    const rows = await this.request<Array<{
      share_id: string;
      owner_email: string;
      kind: SyncKind;
      name?: string;
      share_blob: string;
      wrapped_key: string;
      created_at: string;
    }>>('GET', '/sync/shares');
    return (rows ?? []).map((r) => ({
      shareId: r.share_id,
      ownerEmail: r.owner_email,
      kind: r.kind,
      name: r.name,
      shareBlob: r.share_blob,
      wrappedKey: r.wrapped_key,
      createdAt: r.created_at,
    }));
  }

  async listOutgoingShares(): Promise<Array<{
    shareId: string;
    granteeEmail: string;
    kind: SyncKind;
    name?: string;
    createdAt: string;
    revoked: boolean;
  }>> {
    const rows = await this.request<Array<{
      share_id: string;
      grantee_email: string;
      item_kind: SyncKind;
      item_name?: string;
      created_at: string;
      revoked: boolean;
    }>>('GET', '/sync/shares?direction=outgoing');
    return (rows ?? []).map((r) => ({
      shareId: r.share_id,
      granteeEmail: r.grantee_email,
      kind: r.item_kind,
      name: r.item_name,
      createdAt: r.created_at,
      revoked: r.revoked,
    }));
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.request('DELETE', `/sync/shares/${encodeURIComponent(shareId)}`);
  }

  /** Decrypt a single incoming share into its scrubbed payload. */
  private async decryptShare(share: IncomingShare): Promise<SharedItemPayload> {
    const { privateKey } = await VaultService.getInstance().getIdentityKeyPair();
    const shareKey = openSealed(privateKey, share.wrappedKey).toString('base64');
    const plain = decryptWithShareKey(shareKey, share.shareBlob);
    return JSON.parse(plain.toString()) as SharedItemPayload;
  }

  /**
   * Import incoming shares into the grantee's library.
   * - `copy`: each item gets a fresh id (detached duplicate).
   * - `merge`: reuse a stable id derived from the share so re-imports update
   *   in place rather than piling up duplicates.
   * Imported items carry no connection binding; the grantee may attach one.
   */
  async importShares(
    shares: IncomingShare[],
    mode: ImportMode,
    connectionId: string | undefined,
  ): Promise<number> {
    let imported = 0;
    const now = Date.now();
    const index = new SyncIndex(this.context);
    const nbSvc = new NotebookSyncService(this.context, index);
    const deviceId = getOrCreateDeviceId(this.context);

    for (const share of shares) {
      let scrubbed: SharedItemPayload;
      try {
        scrubbed = await this.decryptShare(share);
      } catch {
        void vscode.window.showWarningMessage(`Could not decrypt shared item from ${share.ownerEmail}.`);
        continue;
      }

      const newId = mode === 'merge'
        ? `shared-${crypto.createHash('sha256').update(share.shareId).digest('hex').slice(0, 24)}`
        : crypto.randomUUID();
      const materialized = materializeShared(scrubbed, newId, connectionId, now);

      if (scrubbed.kind === 'query') {
        await SavedQueriesService.getInstance().saveQuery(materialized as never);
        imported += 1;
      } else if (scrubbed.kind === 'notebook') {
        await nbSvc.applyNotebook(materialized as never, {
          id: newId,
          kind: 'notebook',
          contentHash: '',
          revision: 1,
          updatedAt: now,
          deviceId,
          deleted: false,
        });
        imported += 1;
      }
    }
    await index.flush();
    return imported;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T | undefined> {
    const account = AccountService.getInstance(this.context);
    let token = await account.getAccessToken();
    if (!token) {
      throw new Error('Not signed in to NexQL Cloud. Set up Cloud sync first.');
    }
    let res = await this.send<T>(method, path, token, body);
    if (res.status === 401) {
      const refreshed = await account.refreshAccessToken();
      if (refreshed) {
        token = refreshed;
        res = await this.send<T>(method, path, token, body);
      }
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Sharing requires an active Teams (Singularity) subscription.');
    }
    if (res.status >= 400) {
      throw new Error(res.error || `Request failed (${res.status})`);
    }
    return res.data;
  }

  private send<T>(
    method: string,
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data?: T; error?: string }> {
    const url = new URL(`${this.endpoint()}${path}`);
    const payload = body ? JSON.stringify(body) : undefined;
    const lib = url.protocol === 'http:' ? http : https;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
          timeout: 20000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status === 204 || !data) {
              resolve({ status });
              return;
            }
            try {
              const parsed = JSON.parse(data);
              resolve({ status, data: parsed as T, error: parsed?.error });
            } catch {
              resolve({ status, error: 'Invalid JSON response' });
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
