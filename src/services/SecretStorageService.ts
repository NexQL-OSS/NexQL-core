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

  public async setPassword(connectionId: string, password: string): Promise<void> {
    await this.context.secrets.store(`postgres-password-${connectionId}`, password);
  }

  public async setAiApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store('postgresExplorer.aiApiKey', apiKey);
  }

  public async deletePassword(connectionId: string): Promise<void> {
    await this.context.secrets.delete(`postgres-password-${connectionId}`);
  }

  public async deleteAiApiKey(): Promise<void> {
    await this.context.secrets.delete('postgresExplorer.aiApiKey');
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
  const connections = context.globalState.get<any[]>('postgresql.connections') || [];
  let migratedCount = 0;

  for (const conn of connections) {
    if (conn.password) {
      try {
        // Store in secret storage
        await SecretStorageService.getInstance(context).setPassword(conn.id, conn.password);

        // Remove from connection object and update globalState
        delete conn.password;
        migratedCount++;
      } catch (error) {
        console.error(`Failed to migrate password for connection ${conn.name}:`, error);
      }
    }
  }

  if (migratedCount > 0) {
    await context.globalState.update('postgresql.connections', connections);
    console.log(`Migrated ${migratedCount} passwords to Secret Storage`);
  }
}
