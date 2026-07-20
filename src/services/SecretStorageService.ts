import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { debugLog } from '../common/logger';
import { AiCredentialsProviderLike } from '../common/aiCredentials';

/**
 * Derive a stable connection ID from connection properties.
 * Using a hash instead of Date.now() ensures migration is idempotent:
 * if settings.json loses IDs (e.g. via Settings Sync overwrite) and
 * migration re-runs, the same ID is produced so SecretStorage keys still match.
 */
function stableLegacyId(conn: { host?: string; port?: number; username?: string; user?: string; database?: string; dbname?: string }): string {
  const fp = `${conn.host ?? ''}:${conn.port ?? 5432}:${conn.username ?? conn.user ?? ''}:${conn.database ?? conn.dbname ?? ''}`;
  return `legacy-${crypto.createHash('sha256').update(fp).digest('hex').slice(0, 16)}`;
}

export class SecretStorageService {
  private static instance: SecretStorageService;
  private aiCredentialsProvider: AiCredentialsProviderLike | undefined;
  private constructor(private readonly context: vscode.ExtensionContext) { }

  /** Registered by the AI assistant feature at activation; absent in builds without it. */
  public setAiCredentialsProvider(provider: AiCredentialsProviderLike): void {
    this.aiCredentialsProvider = provider;
  }

  public static getInstance(context?: vscode.ExtensionContext): SecretStorageService {
    if (!SecretStorageService.instance) {
      if (!context) {
        throw new Error('SecretStorageService not initialized');
      }
      SecretStorageService.instance = new SecretStorageService(context);
    }
    return SecretStorageService.instance;
  }

  public async getPassword(connectionId: string): Promise<string | undefined> {
    return await this.context.secrets.get(`postgres-password-${connectionId}`);
  }

  /** @deprecated Use AiCredentialsService.getApiKey(provider) */
  public async getAiApiKey(): Promise<string | undefined> {
    const legacy = await this.context.secrets.get('postgresExplorer.aiApiKey');
    if (legacy) {
      return legacy;
    }
    return (await this.aiCredentialsProvider?.getApiKey('openai')) || undefined;
  }

  public async getCursorApiKey(): Promise<string | undefined> {
    return await this.aiCredentialsProvider?.getCursorApiKey();
  }

  /** Provider-specific AI API key via the registered credentials provider (undefined without the AI feature). */
  public async getAiProviderApiKey(provider: string): Promise<string | undefined> {
    return (await this.aiCredentialsProvider?.getApiKey(provider)) || undefined;
  }

  public async setPassword(connectionId: string, password: string): Promise<void> {
    await this.context.secrets.store(`postgres-password-${connectionId}`, password);
  }

  /** @deprecated Use AiCredentialsService.setApiKey(provider, key) */
  public async setAiApiKey(apiKey: string): Promise<void> {
    await this.aiCredentialsProvider?.setApiKey('openai', apiKey);
  }

  public async setCursorApiKey(apiKey: string): Promise<void> {
    await this.aiCredentialsProvider?.setCursorApiKey(apiKey);
  }

  public async deletePassword(connectionId: string): Promise<void> {
    await this.context.secrets.delete(`postgres-password-${connectionId}`);
  }

  /** @deprecated Use AiCredentialsService.setApiKey(provider, undefined) */
  public async deleteAiApiKey(): Promise<void> {
    await this.context.secrets.delete('postgresExplorer.aiApiKey');
    await this.aiCredentialsProvider?.setApiKey('openai', undefined);
  }

  public async deleteCursorApiKey(): Promise<void> {
    await this.aiCredentialsProvider?.setCursorApiKey(undefined);
  }

  /** License entitlement cache (JSON). Held in SecretStorage so the key never lands in settings. */
  public async getLicenseCache(): Promise<string | undefined> {
    return await this.context.secrets.get('postgresExplorer.licenseCache');
  }

  public async setLicenseCache(value: string): Promise<void> {
    await this.context.secrets.store('postgresExplorer.licenseCache', value);
  }

  public async deleteLicenseCache(): Promise<void> {
    await this.context.secrets.delete('postgresExplorer.licenseCache');
  }

  /** GitHub PAT with `gist` scope — used only for “Publish notebook to Gist”. */
  public async getGithubGistToken(): Promise<string | undefined> {
    return await this.context.secrets.get('postgresExplorer.githubGistToken');
  }

  public async setGithubGistToken(token: string): Promise<void> {
    await this.context.secrets.store('postgresExplorer.githubGistToken', token);
  }

  public async deleteGithubGistToken(): Promise<void> {
    await this.context.secrets.delete('postgresExplorer.githubGistToken');
  }
}

/**
 * Migration helper to move passwords from globalState to SecretStorage
 * This keeps the logic isolated but accessible to extension.ts
 */
export async function migrateExistingPasswords(context: vscode.ExtensionContext): Promise<void> {
  // Support both the modern settings-based connections and older globalState
  const settings = vscode.workspace.getConfiguration();
  const settingsKey = 'postgresExplorer.connections';
  const legacyKey = 'postgresql.connections';

  const settingsConnections = settings.get<any[]>(settingsKey) || [];
  const legacyConnections = context.globalState.get<any[]>(legacyKey) || [];

  let migratedCount = 0;
  let settingsDirty = false;
  let legacyDirty = false;

  const ensureId = (conn: any, _idx: number) => {
    if (!conn.id) {
      conn.id = stableLegacyId(conn);
    }
  };

  const tryMigrate = async (conn: any, idx: number, source: 'settings' | 'legacy') => {
    if (!conn || !conn.password) return;
    try {
      ensureId(conn, idx);
      await SecretStorageService.getInstance(context).setPassword(conn.id, conn.password);
      delete conn.password;
      migratedCount++;
      if (source === 'settings') settingsDirty = true; else legacyDirty = true;
    } catch (error) {
      console.error(`Failed to migrate password for connection ${conn.name || conn.id}:`, error);
    }
  };

  // Migrate from settings-based connections
  for (let i = 0; i < settingsConnections.length; i++) {
    await tryMigrate(settingsConnections[i], i, 'settings');
  }

  // Migrate from legacy globalState connections
  for (let i = 0; i < legacyConnections.length; i++) {
    await tryMigrate(legacyConnections[i], i, 'legacy');
  }

  // Persist any cleaned-up sources
  if (settingsDirty) {
    await settings.update(settingsKey, settingsConnections, vscode.ConfigurationTarget.Global);
  }

  if (legacyDirty) {
    await context.globalState.update(legacyKey, legacyConnections);
  }

  if (migratedCount > 0) {
    debugLog(`Migrated ${migratedCount} passwords to Secret Storage`);
  }
}
