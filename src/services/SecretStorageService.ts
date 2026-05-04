import * as vscode from 'vscode';

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

  public async getAiApiKey(): Promise<string | undefined> {
    return await this.context.secrets.get('postgresExplorer.aiApiKey');
  }

  public async getCursorApiKey(): Promise<string | undefined> {
    return await this.context.secrets.get('postgresExplorer.cursorApiKey');
  }

  public async setPassword(connectionId: string, password: string): Promise<void> {
    await this.context.secrets.store(`postgres-password-${connectionId}`, password);
  }

  public async setAiApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store('postgresExplorer.aiApiKey', apiKey);
  }

  public async setCursorApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store('postgresExplorer.cursorApiKey', apiKey);
  }

  public async deletePassword(connectionId: string): Promise<void> {
    await this.context.secrets.delete(`postgres-password-${connectionId}`);
  }

  public async deleteAiApiKey(): Promise<void> {
    await this.context.secrets.delete('postgresExplorer.aiApiKey');
  }

  public async deleteCursorApiKey(): Promise<void> {
    await this.context.secrets.delete('postgresExplorer.cursorApiKey');
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
    console.log(`Migrated ${migratedCount} passwords to Secret Storage`);
  }
}
