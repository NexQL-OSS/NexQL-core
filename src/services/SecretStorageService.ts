import * as vscode from 'vscode';
import { debugLog } from '../common/logger';

export class SecretStorageService {
  private static instance: SecretStorageService;
  private constructor(private readonly context: vscode.ExtensionContext) { }

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
    const { AiCredentialsService } = await import('../features/aiAssistant/AiCredentialsService');
    return (await AiCredentialsService.getInstance().getApiKey('openai')) || undefined;
  }

  public async getCursorApiKey(): Promise<string | undefined> {
    const { AiCredentialsService } = await import('../features/aiAssistant/AiCredentialsService');
    return await AiCredentialsService.getInstance().getCursorApiKey();
  }

  public async setPassword(connectionId: string, password: string): Promise<void> {
    await this.context.secrets.store(`postgres-password-${connectionId}`, password);
  }

  /** @deprecated Use AiCredentialsService.setApiKey(provider, key) */
  public async setAiApiKey(apiKey: string): Promise<void> {
    const { AiCredentialsService } = await import('../features/aiAssistant/AiCredentialsService');
    await AiCredentialsService.getInstance().setApiKey('openai', apiKey);
  }

  public async setCursorApiKey(apiKey: string): Promise<void> {
    const { AiCredentialsService } = await import('../features/aiAssistant/AiCredentialsService');
    await AiCredentialsService.getInstance().setCursorApiKey(apiKey);
  }

  public async deletePassword(connectionId: string): Promise<void> {
    await this.context.secrets.delete(`postgres-password-${connectionId}`);
  }

  /** @deprecated Use AiCredentialsService.setApiKey(provider, undefined) */
  public async deleteAiApiKey(): Promise<void> {
    await this.context.secrets.delete('postgresExplorer.aiApiKey');
    const { AiCredentialsService } = await import('../features/aiAssistant/AiCredentialsService');
    await AiCredentialsService.getInstance().setApiKey('openai', undefined);
  }

  public async deleteCursorApiKey(): Promise<void> {
    const { AiCredentialsService } = await import('../features/aiAssistant/AiCredentialsService');
    await AiCredentialsService.getInstance().setCursorApiKey(undefined);
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

  const ensureId = (conn: any, idx: number) => {
    if (!conn.id) {
      conn.id = `${Date.now()}-${idx}`;
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
