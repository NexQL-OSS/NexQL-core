import * as vscode from 'vscode';
import { DIRECT_API_KEY_PROVIDERS, DirectApiKeyProvider } from './types';

const LEGACY_AI_API_KEY = 'postgresExplorer.aiApiKey';
const MIGRATION_FLAG = 'postgresExplorer.aiApiKeysMigrated';

function secretKeyForProvider(provider: DirectApiKeyProvider): string {
  return `postgresExplorer.aiApiKey.${provider}`;
}

export class AiCredentialsService {
  private static instance: AiCredentialsService;

  private constructor(private readonly context: vscode.ExtensionContext) {}

  public static getInstance(context?: vscode.ExtensionContext): AiCredentialsService {
    if (!AiCredentialsService.instance) {
      if (!context) {
        throw new Error('AiCredentialsService not initialized');
      }
      AiCredentialsService.instance = new AiCredentialsService(context);
    }
    return AiCredentialsService.instance;
  }

  public static resetInstanceForTests(): void {
    AiCredentialsService.instance = undefined as unknown as AiCredentialsService;
  }

  public async getApiKey(provider: DirectApiKeyProvider): Promise<string | undefined> {
    return await this.context.secrets.get(secretKeyForProvider(provider));
  }

  public async setApiKey(provider: DirectApiKeyProvider, apiKey: string | undefined): Promise<void> {
    const key = secretKeyForProvider(provider);
    if (apiKey && apiKey.trim()) {
      await this.context.secrets.store(key, apiKey.trim());
    } else {
      await this.context.secrets.delete(key);
    }
  }

  public async getAllApiKeys(): Promise<Partial<Record<DirectApiKeyProvider, string>>> {
    const result: Partial<Record<DirectApiKeyProvider, string>> = {};
    for (const provider of DIRECT_API_KEY_PROVIDERS) {
      const value = await this.getApiKey(provider);
      if (value) {
        result[provider] = value;
      }
    }
    return result;
  }

  public async getAllConfiguredProviders(): Promise<DirectApiKeyProvider[]> {
    const configured: DirectApiKeyProvider[] = [];
    for (const provider of DIRECT_API_KEY_PROVIDERS) {
      const key = await this.getApiKey(provider);
      if (key) {
        configured.push(provider);
      }
    }
    return configured;
  }

  public async saveAllApiKeys(
    apiKeys: Partial<Record<DirectApiKeyProvider, string>>,
  ): Promise<void> {
    for (const provider of DIRECT_API_KEY_PROVIDERS) {
      if (Object.prototype.hasOwnProperty.call(apiKeys, provider)) {
        await this.setApiKey(provider, apiKeys[provider]);
      }
    }
  }

  public async getCursorApiKey(): Promise<string | undefined> {
    return await this.context.secrets.get('postgresExplorer.cursorApiKey');
  }

  public async setCursorApiKey(apiKey: string | undefined): Promise<void> {
    if (apiKey && apiKey.trim()) {
      await this.context.secrets.store('postgresExplorer.cursorApiKey', apiKey.trim());
    } else {
      await this.context.secrets.delete('postgresExplorer.cursorApiKey');
    }
  }

  public invalidateCatalogCache(): void {
    // Catalog service listens via explicit call after save
  }
}

/** Migrate legacy single API key and scoped AI settings (idempotent). */
export async function migrateAiCredentialsAndSettings(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATION_FLAG)) {
    return;
  }

  const credentials = AiCredentialsService.getInstance(context);
  const legacyKey = await context.secrets.get(LEGACY_AI_API_KEY);
  if (legacyKey) {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const legacyProvider = config.get<string>('aiProvider') || 'vscode-lm';
    if (
      legacyProvider === 'openai' ||
      legacyProvider === 'anthropic' ||
      legacyProvider === 'gemini' ||
      legacyProvider === 'custom'
    ) {
      const existing = await credentials.getApiKey(legacyProvider);
      if (!existing) {
        await credentials.setApiKey(legacyProvider, legacyKey);
      }
    }
    await context.secrets.delete(LEGACY_AI_API_KEY);
  }

  const config = vscode.workspace.getConfiguration('postgresExplorer');
  const legacyCursorKey = config.get<string>('cursorApiKey');
  if (legacyCursorKey && legacyCursorKey.trim()) {
    const existingCursor = await credentials.getCursorApiKey();
    if (!existingCursor) {
      await credentials.setCursorApiKey(legacyCursorKey.trim());
    }
    await config.update('cursorApiKey', undefined, vscode.ConfigurationTarget.Global);
  }

  const { migrateAiScopedSettings } = await import('./aiConfig');
  await migrateAiScopedSettings(context);

  await context.globalState.update(MIGRATION_FLAG, true);
}
