import * as vscode from 'vscode';
import type { SyncProvider, SyncPushItem, SyncPushOptions, SyncSnapshot, SyncItemMeta } from '../types';
import {
  activeManifestIds,
  parseSyncBlobId,
  publishableManifest,
  resolvePushManifest,
  syncBlobName,
} from '../syncManifest';
import { getGithubToken, githubDeviceFlowSignIn } from '../auth/githubDeviceFlow';
import { httpRequest } from './httpUtils';
import { GIST_DESCRIPTION, GIST_MAX_FILE_BYTES, GIST_META_FILE, SYNC_CONFIG_KEY } from '../constants';
import type { SyncConfig } from '../types';
import { VaultService } from '../VaultService';

const GIST_MANIFEST_FILE = 'manifest.json';
const GIST_ID_KEY = 'postgresExplorer.sync.gistId';

export interface GistCandidate {
  id: string;
  description: string;
  updatedAt: string;
  generation?: string;
  itemCount: number;
}

export interface GistLinkOptions {
  mode: 'unlock' | 'create';
  vaultGeneration?: string;
}

interface GithubGistSummary {
  id: string;
  description: string | null;
  updated_at: string;
  files: Record<string, { filename?: string }>;
}

/**
 * Private GitHub Gist backend — zero registration when vscode GitHub auth is available.
 * Fallback: GitHub OAuth device flow (client id from settings).
 */
export class GistSyncProvider implements SyncProvider {
  readonly id = 'gist' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  static async clearStoredGistId(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(GIST_ID_KEY);
  }

  private clientId(): string {
    return vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.githubClientId', 'Ov23liPLACEHOLDER_GITHUB_CLIENT');
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'PgStudio-Sync',
    };
  }

  async ensureAuth(): Promise<string> {
    let token = await getGithubToken(this.context);
    if (!token) {
      try {
        const session = await vscode.authentication.getSession('github', ['gist'], { createIfNone: true });
        token = session?.accessToken;
      } catch {
        // GitHub auth unavailable in this editor fork
      }
    }
    if (!token) {
      const res = await githubDeviceFlowSignIn(this.context, this.clientId());
      token = res.token;
    }
    return token;
  }

  async testConnection(): Promise<{ ok: boolean; account?: string; error?: string }> {
    try {
      const token = await this.ensureAuth();
      const res = await httpRequest('https://api.github.com/user', {
        headers: this.authHeaders(token),
      });
      if (res.statusCode >= 400) {
        return { ok: false, error: `GitHub API ${res.statusCode}` };
      }
      const user = JSON.parse(res.body.toString());
      return { ok: true, account: user.login };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Bind this editor to an existing PgStudio gist (second device / repair). */
  async linkToRemoteStorage(options: GistLinkOptions): Promise<boolean> {
    const token = await this.ensureAuth();
    const stored = await this.getStoredGistId();
    if (stored && await this.validateGistId(token, stored)) {
      return true;
    }

    const candidates = await this.listPgStudioGists(token);

    if (options.mode === 'unlock') {
      return this.linkOnUnlock(token, candidates, options.vaultGeneration);
    }

    const sameVault = options.vaultGeneration
      ? candidates.filter((c) => c.generation === options.vaultGeneration)
      : [];
    if (sameVault.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        'An existing PgStudio sync gist matches this vault. Link to it instead of creating a duplicate?',
        'Link Existing',
        'Create New Gist',
      );
      if (choice === 'Link Existing') {
        const picked = sameVault.length === 1
          ? sameVault[0]
          : await this.pickGistCandidate(sameVault);
        if (!picked) {
          return false;
        }
        await this.storeGistId(picked.id);
        return true;
      }
    }

    return true;
  }

  /** Manual repair — pick or paste an existing gist id. */
  async linkExistingGistInteractive(): Promise<boolean> {
    const token = await this.ensureAuth();
    const candidates = await this.listPgStudioGists(token);
    if (candidates.length > 0) {
      const picked = await this.pickGistCandidate(candidates);
      if (picked) {
        await this.storeGistId(picked.id);
        return true;
      }
    }

    const manual = await vscode.window.showInputBox({
      title: 'Link GitHub Gist',
      prompt: 'Paste the gist ID or URL from github.com/gist/…',
      ignoreFocusOut: true,
    });
    if (!manual?.trim()) {
      return false;
    }
    const gistId = this.parseGistId(manual.trim());
    if (!gistId || !(await this.validateGistId(token, gistId))) {
      await vscode.window.showErrorMessage('Gist not found or not a PgStudio sync vault.');
      return false;
    }
    await this.storeGistId(gistId);
    return true;
  }

  async pull(_sinceRevision?: number): Promise<SyncSnapshot> {
    const token = await this.ensureAuth();
    const gistId = await this.resolveGistId(token);
    if (!gistId) {
      return { manifest: [], getBlob: async () => undefined };
    }

    const res = await httpRequest(`https://api.github.com/gists/${gistId}`, {
      headers: this.authHeaders(token),
    });

    if (res.statusCode === 404) {
      return { manifest: [], getBlob: async () => undefined };
    }

    const gist = JSON.parse(res.body.toString()) as {
      files: Record<string, { content?: string }>;
    };

    const manifestRaw = gist.files[GIST_MANIFEST_FILE]?.content ?? '[]';
    const manifest = JSON.parse(manifestRaw) as SyncItemMeta[];
    const files = gist.files;

    return {
      manifest,
      getBlob: async (id: string) => {
        const file = files[`item-${id}.bin`];
        if (!file?.content) {
          return undefined;
        }
        return Buffer.from(file.content, 'base64');
      },
    };
  }

  async push(items: SyncPushItem[], options?: SyncPushOptions): Promise<void> {
    const token = await this.ensureAuth();
    const oversized = items.filter((i) => i.blob.length > GIST_MAX_FILE_BYTES);
    if (oversized.length > 0) {
      throw new OversizedItemError(oversized.map((i) => i.meta.id));
    }

    const snapshot = await this.pull();
    const manifest = resolvePushManifest(snapshot.manifest, items, options);
    const remoteManifest = options?.manifest ? publishableManifest(manifest) : manifest;
    const activeIds = activeManifestIds(manifest);

    const files: Record<string, { content: string } | null> = {
      [GIST_MANIFEST_FILE]: { content: JSON.stringify(remoteManifest, null, 2) },
    };
    for (const item of items) {
      if (item.meta.deleted) {
        files[syncBlobName(item.meta.id)] = null;
        continue;
      }
      files[syncBlobName(item.meta.id)] = { content: item.blob.toString('base64') };
    }
    for (const meta of manifest) {
      if (meta.deleted) {
        files[syncBlobName(meta.id)] = null;
      }
    }

    const gistIdForCleanup = await this.resolveGistId(token);
    if (gistIdForCleanup) {
      const gistRes = await httpRequest(`https://api.github.com/gists/${gistIdForCleanup}`, {
        headers: this.authHeaders(token),
      });
      if (gistRes.statusCode < 400) {
        const gist = JSON.parse(gistRes.body.toString()) as { files: Record<string, unknown> };
        for (const filename of Object.keys(gist.files)) {
          const itemId = parseSyncBlobId(filename);
          if (itemId && !activeIds.has(itemId)) {
            files[filename] = null;
          }
        }
      }
    }

    const generation = VaultService.getInstance().getGeneration();
    if (generation) {
      files[GIST_META_FILE] = {
        content: JSON.stringify({ generation, version: 1 }, null, 2),
      };
    }

    let gistId = await this.getStoredGistId();
    if (!gistId) {
      const createRes = await httpRequest('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          ...this.authHeaders(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description: GIST_DESCRIPTION,
          public: false,
          files,
        }),
      });
      if (createRes.statusCode >= 400) {
        throw new Error(`GitHub gist create failed: ${createRes.statusCode}`);
      }
      const created = JSON.parse(createRes.body.toString());
      gistId = created.id;
      await this.storeGistId(gistId!);
      return;
    }

    await httpRequest(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        ...this.authHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files }),
    });
  }

  private async linkOnUnlock(
    token: string,
    candidates: GistCandidate[],
    vaultGeneration?: string,
  ): Promise<boolean> {
    let matches = candidates;
    if (vaultGeneration) {
      const byGen = candidates.filter((c) => c.generation === vaultGeneration);
      if (byGen.length > 0) {
        matches = byGen;
      }
    }

    if (matches.length === 1) {
      await this.storeGistId(matches[0].id);
      vscode.window.showInformationMessage(`Linked to existing sync gist (${matches[0].itemCount} items).`);
      return true;
    }

    if (matches.length > 1) {
      const picked = await this.pickGistCandidate(matches);
      if (!picked) {
        return false;
      }
      await this.storeGistId(picked.id);
      return true;
    }

    if (candidates.length > 0) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Pick an existing PgStudio gist', id: 'pick' },
          { label: 'Paste gist ID or URL', id: 'paste' },
        ],
        { title: 'No gist matched your vault — link manually' },
      );
      if (!picked) {
        return false;
      }
      if (picked.id === 'pick') {
        const gist = await this.pickGistCandidate(candidates);
        if (!gist) {
          return false;
        }
        await this.storeGistId(gist.id);
        return true;
      }
    }

    const manual = await vscode.window.showInputBox({
      title: 'Link existing sync gist',
      prompt: 'Paste the gist ID from your first machine (github.com/gist/…)',
      ignoreFocusOut: true,
    });
    if (!manual?.trim()) {
      return false;
    }
    const gistId = this.parseGistId(manual.trim());
    if (!gistId || !(await this.validateGistId(token, gistId))) {
      await vscode.window.showErrorMessage('Gist not found or inaccessible with your GitHub account.');
      return false;
    }
    await this.storeGistId(gistId);
    return true;
  }

  private async pickGistCandidate(candidates: GistCandidate[]): Promise<GistCandidate | undefined> {
    const items = candidates.map((c) => ({
      label: c.description || GIST_DESCRIPTION,
      description: `${c.itemCount} items · updated ${c.updatedAt}${c.generation ? ` · vault ${c.generation.slice(0, 8)}…` : ''}`,
      candidate: c,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Select PgStudio sync gist',
      placeHolder: 'Choose the gist created on your other machine',
    });
    return picked?.candidate;
  }

  private async listPgStudioGists(token: string): Promise<GistCandidate[]> {
    const res = await httpRequest('https://api.github.com/gists?per_page=100', {
      headers: this.authHeaders(token),
    });
    if (res.statusCode >= 400) {
      throw new Error(`GitHub API ${res.statusCode}`);
    }

    const gists = JSON.parse(res.body.toString()) as GithubGistSummary[];
    const candidates: GistCandidate[] = [];

    for (const gist of gists) {
      const hasManifest = GIST_MANIFEST_FILE in gist.files;
      const isPgStudio = gist.description === GIST_DESCRIPTION || hasManifest;
      if (!isPgStudio) {
        continue;
      }

      let generation: string | undefined;
      let itemCount = 0;
      try {
        const detail = await this.fetchGistDetail(token, gist.id);
        generation = detail.generation;
        itemCount = detail.itemCount;
      } catch {
        itemCount = hasManifest ? 0 : 0;
      }

      candidates.push({
        id: gist.id,
        description: gist.description ?? GIST_DESCRIPTION,
        updatedAt: gist.updated_at,
        generation,
        itemCount,
      });
    }

    return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async fetchGistDetail(
    token: string,
    gistId: string,
  ): Promise<{ generation?: string; itemCount: number }> {
    const res = await httpRequest(`https://api.github.com/gists/${gistId}`, {
      headers: this.authHeaders(token),
    });
    if (res.statusCode >= 400) {
      throw new Error(`GitHub API ${res.statusCode}`);
    }
    const gist = JSON.parse(res.body.toString()) as {
      files: Record<string, { content?: string }>;
    };
    let generation: string | undefined;
    const metaRaw = gist.files[GIST_META_FILE]?.content;
    if (metaRaw) {
      try {
        generation = JSON.parse(metaRaw).generation;
      } catch {
        /* ignore */
      }
    }
    const manifestRaw = gist.files[GIST_MANIFEST_FILE]?.content ?? '[]';
    let itemCount = 0;
    try {
      itemCount = (JSON.parse(manifestRaw) as unknown[]).length;
    } catch {
      itemCount = 0;
    }
    return { generation, itemCount };
  }

  private async validateGistId(token: string, gistId: string): Promise<boolean> {
    const res = await httpRequest(`https://api.github.com/gists/${gistId}`, {
      headers: this.authHeaders(token),
    });
    return res.statusCode === 200;
  }

  private parseGistId(input: string): string | undefined {
    const trimmed = input.trim();
    const urlMatch = trimmed.match(/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)/i);
    if (urlMatch) {
      return urlMatch[1];
    }
    if (/^[a-f0-9]{8,}$/i.test(trimmed)) {
      return trimmed;
    }
    return undefined;
  }

  private async getStoredGistId(): Promise<string | undefined> {
    return this.context.secrets.get(GIST_ID_KEY);
  }

  private async storeGistId(gistId: string): Promise<void> {
    await this.context.secrets.store(GIST_ID_KEY, gistId);
    const config = this.context.globalState.get<SyncConfig>(SYNC_CONFIG_KEY, {
      syncConnections: true,
      syncQueries: true,
      syncNotebooks: true,
      syncPasswords: false,
      paused: false,
    });
    if (config.providerId === 'gist') {
      await this.context.globalState.update(SYNC_CONFIG_KEY, { ...config, gistId });
    }
  }

  /** Use stored id, or auto-discover a single matching gist for this vault. */
  private async resolveGistId(token: string): Promise<string | undefined> {
    const stored = await this.getStoredGistId();
    if (stored) {
      return stored;
    }

    const config = this.context.globalState.get<SyncConfig>(SYNC_CONFIG_KEY, {
      syncConnections: true,
      syncQueries: true,
      syncNotebooks: true,
      syncPasswords: false,
      paused: false,
    });
    if (!config.vaultGeneration) {
      return undefined;
    }

    const candidates = await this.listPgStudioGists(token);
    const matches = candidates.filter((c) => c.generation === config.vaultGeneration);
    if (matches.length === 1) {
      await this.storeGistId(matches[0].id);
      return matches[0].id;
    }

    return undefined;
  }
}

export class OversizedItemError extends Error {
  constructor(public readonly itemIds: string[]) {
    super(`Oversized sync items: ${itemIds.join(', ')}`);
    this.name = 'OversizedItemError';
  }
}
