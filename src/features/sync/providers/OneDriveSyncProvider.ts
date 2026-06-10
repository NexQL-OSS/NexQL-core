import * as vscode from 'vscode';
import type { SyncProvider, SyncPushItem, SyncPushOptions, SyncSnapshot, SyncItemMeta } from '../types';
import { publishableManifest, resolvePushManifest } from '../syncManifest';
import { entraDeviceFlowSignIn, getOneDriveToken } from '../auth/entraDeviceFlow';
import { httpRequest } from './httpUtils';

const MANIFEST_PATH = '/pgstudio-sync/manifest.json';

/** OneDrive appFolder backend via Microsoft Graph. */
export class OneDriveSyncProvider implements SyncProvider {
  readonly id = 'onedrive' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private clientId(): string {
    // Placeholder — register a free Entra public client app.
    return vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.onedriveClientId', '00000000-0000-0000-0000-PLACEHOLDER');
  }

  async ensureAuth(): Promise<string> {
    let token = await getOneDriveToken(this.context);
    if (!token) {
      const res = await entraDeviceFlowSignIn(this.context, this.clientId());
      token = res.token;
    }
    return token;
  }

  async testConnection(): Promise<{ ok: boolean; account?: string; error?: string }> {
    try {
      const token = await this.ensureAuth();
      const res = await httpRequest('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.statusCode >= 400) {
        return { ok: false, error: `Graph API ${res.statusCode}` };
      }
      const user = JSON.parse(res.body.toString());
      return { ok: true, account: user.userPrincipalName ?? user.mail };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private appRootUrl(path: string): string {
    return `https://graph.microsoft.com/v1.0/me/drive/special/approot:${path}`;
  }

  async pull(_sinceRevision?: number): Promise<SyncSnapshot> {
    const token = await this.ensureAuth();
    const res = await httpRequest(this.appRootUrl(MANIFEST_PATH), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.statusCode === 404) {
      return { manifest: [], getBlob: async () => undefined };
    }

    const manifest = JSON.parse(res.body.toString()) as SyncItemMeta[];
    return {
      manifest,
      getBlob: async (id: string) => {
        const blobRes = await httpRequest(this.appRootUrl(`/pgstudio-sync/item-${id}.bin`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (blobRes.statusCode === 404) {
          return undefined;
        }
        return blobRes.body;
      },
    };
  }

  async push(items: SyncPushItem[], options?: SyncPushOptions): Promise<void> {
    const token = await this.ensureAuth();
    const snapshot = await this.pull();
    const manifest = resolvePushManifest(snapshot.manifest, items, options);
    const remoteManifest = options?.manifest ? publishableManifest(manifest) : manifest;

    await this.uploadFile(token, MANIFEST_PATH, Buffer.from(JSON.stringify(remoteManifest)));
    for (const item of items) {
      await this.uploadFile(token, `/pgstudio-sync/item-${item.meta.id}.bin`, item.blob);
    }
  }

  private async uploadFile(token: string, path: string, content: Buffer): Promise<void> {
    await httpRequest(this.appRootUrl(path), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });
  }
}
