import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AiCredentialsService } from './AiCredentialsService';
import {
  buildSelectionId,
  providerDisplayName,
  readAiScopeSettings,
} from './aiConfig';
import { listOpencodeModels } from './opencode';
import {
  getGitHubSession,
  listAnthropicModels,
  listCursorModels,
  listCustomModels,
  listDeepSeekModels,
  listGeminiModels,
  listGitHubModels,
  listMistralModels,
  listMoonshotModels,
  listOpenAIModels,
  listVsCodeLanguageModels,
} from './modelListing';
import {
  AiCatalogEntry,
  AiConfigScope,
  AiModelCatalogPayload,
  AiProviderId,
  DirectApiKeyProvider,
} from './types';

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  models: string[];
}

export class AiModelCatalogService {
  private static instance: AiModelCatalogService;
  private readonly cache = new Map<string, CacheEntry>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly credentials: AiCredentialsService,
  ) {}

  public static getInstance(context?: vscode.ExtensionContext): AiModelCatalogService {
    if (!AiModelCatalogService.instance) {
      if (!context) {
        throw new Error('AiModelCatalogService not initialized');
      }
      AiModelCatalogService.instance = new AiModelCatalogService(
        context,
        AiCredentialsService.getInstance(context),
      );
    }
    return AiModelCatalogService.instance;
  }

  public static resetInstanceForTests(): void {
    AiModelCatalogService.instance = undefined as unknown as AiModelCatalogService;
  }

  public invalidateCache(): void {
    this.cache.clear();
  }

  public async buildChatCatalog(): Promise<AiModelCatalogPayload> {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const scope: AiConfigScope = 'chat';
    const active = readAiScopeSettings(config, scope);
    const catalog: AiCatalogEntry[] = [];

    try {
      const vscodeLmModels = await listVsCodeLanguageModels();
      const groupLabel = providerDisplayName('vscode-lm');
      for (const entry of vscodeLmModels) {
        catalog.push({
          selectionId: buildSelectionId('vscode-lm', entry.id),
          provider: 'vscode-lm',
          modelId: entry.id,
          label: entry.displayName,
          groupLabel,
        });
      }
    } catch {
      catalog.push({
        selectionId: buildSelectionId('vscode-lm', this._defaultModelForProvider('vscode-lm')),
        provider: 'vscode-lm',
        modelId: this._defaultModelForProvider('vscode-lm'),
        label: `${providerDisplayName('vscode-lm')} (unavailable)`,
        groupLabel: providerDisplayName('vscode-lm'),
      });
    }

    const githubSession = await getGitHubSession();
    if (githubSession) {
      await this._appendProviderModels(catalog, 'github', async () =>
        listGitHubModels(githubSession.accessToken),
      );
    }

    const cursorKey =
      (await this.credentials.getCursorApiKey()) || process.env.CURSOR_API_KEY || '';
    if (cursorKey) {
      await this._appendProviderModels(catalog, 'cursor', async () => {
        const rows = await listCursorModels(cursorKey);
        return rows.map((r) => r.displayName || r.id);
      });
    }

    await this._appendProviderModels(catalog, 'opencode', async () => listOpencodeModels(config));

    for (const provider of ['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral'] as DirectApiKeyProvider[]) {
      const apiKey = await this.credentials.getApiKey(provider);
      if (apiKey) {
        await this._appendProviderModels(catalog, provider, () => this._listForDirectProvider(provider, apiKey));
      }
    }

    const customKey = await this.credentials.getApiKey('custom');
    const endpoint = config.get<string>('aiEndpoint') || '';
    if (customKey && endpoint) {
      await this._appendProviderModels(catalog, 'custom', () =>
        listCustomModels(endpoint, customKey),
      );
    }

    const ollamaEndpoint =
      config.get<string>('aiEndpoint') || 'http://localhost:11434/v1/chat/completions';
    await this._appendProviderModels(catalog, 'ollama', () => listCustomModels(ollamaEndpoint, ''));

    const lmEndpoint =
      config.get<string>('aiEndpoint') || 'http://localhost:1234/v1/chat/completions';
    await this._appendProviderModels(catalog, 'lmstudio', () => listCustomModels(lmEndpoint, ''));

    if (catalog.length === 0) {
      catalog.push({
        selectionId: buildSelectionId(active.provider, active.model || 'default'),
        provider: active.provider,
        modelId: active.model || 'default',
        label: `${providerDisplayName(active.provider)} (configure in settings)`,
        groupLabel: providerDisplayName(active.provider),
      });
    }

    const activeModelId = active.model || this._defaultModelForProvider(active.provider);
    const activeSelectionId = buildSelectionId(active.provider, activeModelId);
    const match =
      catalog.find((e) => e.selectionId === activeSelectionId) ||
      catalog.find((e) => e.provider === active.provider);
    const activeModelLabel = match?.label || `${providerDisplayName(active.provider)}: ${activeModelId}`;

    return { catalog, activeSelectionId: match?.selectionId || activeSelectionId, activeModelLabel };
  }

  private async _appendProviderModels(
    catalog: AiCatalogEntry[],
    provider: AiProviderId,
    listFn: () => Promise<string[]>,
  ): Promise<void> {
    const groupLabel = providerDisplayName(provider);
    try {
      const models = await this._getCachedModels(provider, listFn);
      if (models.length === 0) {
        catalog.push({
          selectionId: buildSelectionId(provider, this._defaultModelForProvider(provider)),
          provider,
          modelId: this._defaultModelForProvider(provider),
          label: `${groupLabel} (no models listed)`,
          groupLabel,
        });
        return;
      }
      for (const modelId of models) {
        catalog.push({
          selectionId: buildSelectionId(provider, modelId),
          provider,
          modelId,
          label: modelId,
          groupLabel,
        });
      }
    } catch {
      catalog.push({
        selectionId: buildSelectionId(provider, this._defaultModelForProvider(provider)),
        provider,
        modelId: this._defaultModelForProvider(provider),
        label: `${groupLabel} (unavailable)`,
        groupLabel,
      });
    }
  }

  private async _getCachedModels(
    provider: AiProviderId,
    listFn: () => Promise<string[]>,
  ): Promise<string[]> {
    const cacheKey = crypto.createHash('sha256').update(provider).digest('hex');
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.models;
    }
    const models = await listFn();
    this.cache.set(cacheKey, { models, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS });
    return models;
  }

  private async _listForDirectProvider(
    provider: DirectApiKeyProvider,
    apiKey: string,
  ): Promise<string[]> {
    switch (provider) {
      case 'openai':
        return listOpenAIModels(apiKey);
      case 'anthropic':
        return listAnthropicModels(apiKey);
      case 'gemini':
        return listGeminiModels(apiKey);
      case 'deepseek':
        return listDeepSeekModels(apiKey);
      case 'moonshot':
        return listMoonshotModels(apiKey);
      case 'mistral':
        return listMistralModels(apiKey);
      case 'custom':
        return [];
      default:
        return [];
    }
  }

  private _defaultModelForProvider(provider: AiProviderId): string {
    switch (provider) {
      case 'openai':
        return 'gpt-4.1';
      case 'anthropic':
        return 'claude-sonnet-4-20250514';
      case 'gemini':
        return 'gemini-2.5-flash';
      case 'deepseek':
        return 'deepseek-chat';
      case 'moonshot':
        return 'moonshot-v1-8k';
      case 'mistral':
        return 'mistral-large-latest';
      case 'github':
        return 'openai/gpt-4.1';
      case 'cursor':
        return 'auto';
      case 'opencode':
        return 'auto';
      case 'custom':
        return 'custom-model';
      case 'ollama':
        return 'ollama';
      case 'lmstudio':
        return 'lm-studio';
      default:
        return 'default';
    }
  }
}
