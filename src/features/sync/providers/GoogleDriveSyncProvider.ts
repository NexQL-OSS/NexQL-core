import * as vscode from 'vscode';
import type { SyncProvider, SyncPushItem, SyncPushOptions, SyncSnapshot, SyncItemMeta } from '../types';
import { publishableManifest, resolvePushManifest } from '../syncManifest';
import { getGDriveToken, googleLoopbackPkceSignIn } from '../auth/googleLoopbackPkce';
import { httpRequest } from './httpUtils';

const APPDATA_FOLDER = 'pgstudio-sync';

/** Google Drive appdata backend (drive.appdata scope). */
export class GoogleDriveSyncProvider implements SyncProvider {
  readonly id = 'gdrive' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private clientId(): string {
    // Placeholder — requires Google OAuth verification for production.
    return vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.googleClientId', '000000000000-placeholder.apps.googleusercontent.com');
  }

  async ensureAuth(): Promise<string> {
    let token = await getGDriveToken(this.context);
    if (!token) {
      const res = await googleLoopbackPkceSignIn(this.context, this.clientId());
      token = res.token;
    }
    return token;
  }

  async testConnection(): Promise<{ ok: boolean; account?: string; error?: string }> {
    try {
      const token = await this.ensureAuth();
      const res = await httpRequest('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.statusCode >= 400) {
        return { ok: false, error: `Drive API ${res.statusCode}` };
      }
      const about = JSON.parse(res.body.toString());
      return { ok: true, account: about.user?.emailAddress ?? 'google-user' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async pull(_sinceRevision?: number): Promise<SyncSnapshot> {
    const token = await this.ensureAuth();
    const manifestFile = await this.findFile(token, 'manifest.json');
    if (!manifestFile) {
      return { manifest: [], getBlob: async () => undefined };
    }

    const content = await this.downloadFile(token, manifestFile);
    const manifest = JSON.parse(content.toString()) as SyncItemMeta[];

    return {
      manifest,
      getBlob: async (id: string) => {
        const file = await this.findFile(token, `item-${id}.bin`);
        if (!file) {
          return undefined;
        }
        return this.downloadFile(token, file);
      },
    };
  }

  async push(items: SyncPushItem[], options?: SyncPushOptions): Promise<void> {
    const token = await this.ensureAuth();
    const snapshot = await this.pull();
    const manifest = resolvePushManifest(snapshot.manifest, items, options);
    const remoteManifest = options?.manifest ? publishableManifest(manifest) : manifest;

    await this.uploadFile(token, 'manifest.json', Buffer.from(JSON.stringify(remoteManifest)));
    for (const item of items) {
      await this.uploadFile(token, `item-${item.meta.id}.bin`, item.blob);
    }
  }

  private async findFile(token: string, name: string): Promise<string | undefined> {
    const q = encodeURIComponent(`name='${name}' and 'appDataFolder' in parents`);
    const res = await httpRequest(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const parsed = JSON.parse(res.body.toString()) as { files?: Array<{ id: string }> };
    return parsed.files?.[0]?.id;
  }

  private async downloadFile(token: string, fileId: string): Promise<Buffer> {
    const res = await httpRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.body;
  }

  private async uploadFile(token: string, name: string, content: Buffer): Promise<void> {
    const existing = await this.findFile(token, name);
    const metadata = JSON.stringify({ name, parents: ['appDataFolder'] });
    const boundary = 'pgstudio_sync_boundary';

    if (existing) {
      await httpRequest(`https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: content,
      });
      return;
    }

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    await httpRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
  }
}
