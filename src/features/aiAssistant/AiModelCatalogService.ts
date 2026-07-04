import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AiCredentialsService } from './AiCredentialsService';
import {
  buildSelectionId,
  providerDisplayName,
  readAiScopeSettings,
  getChatCompletionEndpoint,
} from './aiConfig';
import { listOpencodeModels } from './opencode';
import { LicenseService } from '../../services/LicenseService';
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
  listNexqlFreeModels,
  listOpenAIModels,
  listVsCodeLanguageModels,
} from './modelListing';
import {
  AiCatalogEntry,
  AiConfigScope,
  AiModelCatalogPayload,
  AiProviderId,
  AiScopeSettings,
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

  /** Instant snapshot: NexQL Free models + the configured active model (no network). */
  public buildChatCatalogPreview(): AiModelCatalogPayload {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const active = readAiScopeSettings(config, 'chat');
    const catalog: AiCatalogEntry[] = [];
    this._appendNexqlFreeModels(catalog);
    this._ensureActiveEntryInCatalog(catalog, active);
    return this._buildPayload(catalog, active);
  }

  public async buildChatCatalog(): Promise<AiModelCatalogPayload> {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const scope: AiConfigScope = 'chat';
    const active = readAiScopeSettings(config, scope);
    const catalog: AiCatalogEntry[] = [];
    this._appendNexqlFreeModels(catalog);

    const providerChunks = await Promise.all([
      this._collectVsCodeLmModels(),
      this._collectGitHubModels(),
      this._collectCursorModels(),
      this._collectOpencodeModels(config, active),
      this._collectDirectApiKeyModels(),
      this._collectCustomModels(config),
      this._shouldProbeLocalProvider('ollama', config, active)
        ? this._collectProviderModels('ollama', () =>
            listCustomModels(
              getChatCompletionEndpoint(
                config.get<string>('aiEndpoint') || 'http://localhost:11434/v1/chat/completions',
              ),
              '',
            ),
          )
        : Promise.resolve([]),
      this._shouldProbeLocalProvider('lmstudio', config, active)
        ? this._collectProviderModels('lmstudio', () =>
            listCustomModels(
              getChatCompletionEndpoint(
                config.get<string>('aiEndpoint') || 'http://localhost:1234/v1/chat/completions',
              ),
              '',
            ),
          )
        : Promise.resolve([]),
    ]);

    for (const chunk of providerChunks) {
      catalog.push(...chunk);
    }

    if (catalog.length === 0) {
      catalog.push({
        selectionId: buildSelectionId(active.provider, active.model || 'default'),
        provider: active.provider,
        modelId: active.model || 'default',
        label: `${providerDisplayName(active.provider)} (configure in settings)`,
        groupLabel: providerDisplayName(active.provider),
      });
    }

    return this._buildPayload(catalog, active);
  }

  private _buildPayload(catalog: AiCatalogEntry[], active: AiScopeSettings): AiModelCatalogPayload {
    const activeModelId = active.model || this._defaultModelForProvider(active.provider);
    const activeSelectionId = buildSelectionId(active.provider, activeModelId);
    const match =
      catalog.find((e) => e.selectionId === activeSelectionId) ||
      catalog.find((e) => e.provider === active.provider);
    const activeModelLabel =
      match?.label || this._labelForProviderModel(active.provider, activeModelId);

    return {
      catalog,
      activeSelectionId: match?.selectionId || activeSelectionId,
      activeModelLabel,
    };
  }

  private _appendNexqlFreeModels(catalog: AiCatalogEntry[]): void {
    const groupLabel = providerDisplayName('nexql-free');
    const currentTier = LicenseService.getInstance().getTier();
    for (const entry of listNexqlFreeModels(currentTier)) {
      catalog.push({
        selectionId: buildSelectionId('nexql-free', entry.id),
        provider: 'nexql-free',
        modelId: entry.id,
        label: entry.displayName,
        groupLabel,
      });
    }
  }

  private _ensureActiveEntryInCatalog(catalog: AiCatalogEntry[], active: AiScopeSettings): void {
    const activeModelId = active.model || this._defaultModelForProvider(active.provider);
    const activeSelectionId = buildSelectionId(active.provider, activeModelId);
    if (catalog.some((e) => e.selectionId === activeSelectionId)) {
      return;
    }
    catalog.push({
      selectionId: activeSelectionId,
      provider: active.provider,
      modelId: activeModelId,
      label: this._labelForProviderModel(active.provider, activeModelId),
      groupLabel: providerDisplayName(active.provider),
    });
  }

  private _labelForProviderModel(provider: AiProviderId, modelId: string): string {
    if (provider === 'nexql-free') {
      const entry = listNexqlFreeModels(LicenseService.getInstance().getTier()).find(
        (m) => m.id === modelId,
      );
      if (entry) {
        return entry.displayName;
      }
    }
    return modelId || providerDisplayName(provider);
  }

  private _shouldProbeLocalProvider(
    provider: 'ollama' | 'lmstudio',
    config: vscode.WorkspaceConfiguration,
    active: AiScopeSettings,
  ): boolean {
    if (active.provider === provider) {
      return true;
    }
    const endpoint = config.get<string>('aiEndpoint')?.trim() || '';
    if (!endpoint) {
      return false;
    }
    const defaultPort = provider === 'ollama' ? '11434' : '1234';
    return endpoint.includes(defaultPort);
  }

  private _shouldProbeOpencode(
    config: vscode.WorkspaceConfiguration,
    active: AiScopeSettings,
  ): boolean {
    if (active.provider === 'opencode') {
      return true;
    }
    if (config.get<string>('opencodeCliPath')?.trim()) {
      return true;
    }
    return Boolean(process.env.OPENCODE_BIN?.trim() || process.env.OPENCODE_INSTALL_DIR?.trim());
  }

  private async _collectVsCodeLmModels(): Promise<AiCatalogEntry[]> {
    try {
      const vscodeLmModels = await listVsCodeLanguageModels();
      const groupLabel = providerDisplayName('vscode-lm');
      return vscodeLmModels.map((entry) => ({
        selectionId: buildSelectionId('vscode-lm', entry.id),
        provider: 'vscode-lm' as const,
        modelId: entry.id,
        label: entry.displayName,
        groupLabel,
      }));
    } catch {
      return [
        {
          selectionId: buildSelectionId('vscode-lm', this._defaultModelForProvider('vscode-lm')),
          provider: 'vscode-lm',
          modelId: this._defaultModelForProvider('vscode-lm'),
          label: `${providerDisplayName('vscode-lm')} (unavailable)`,
          groupLabel: providerDisplayName('vscode-lm'),
        },
      ];
    }
  }

  private async _collectGitHubModels(): Promise<AiCatalogEntry[]> {
    const githubSession = await getGitHubSession();
    if (!githubSession) {
      return [];
    }
    return this._collectProviderModels('github', () =>
      listGitHubModels(githubSession.accessToken),
    );
  }

  private async _collectCursorModels(): Promise<AiCatalogEntry[]> {
    try {
      const cursorKey =
        (await this.credentials.getCursorApiKey()) || process.env.CURSOR_API_KEY || '';
      const cursorModels = await listCursorModels(cursorKey);
      const groupLabel = providerDisplayName('cursor');
      if (cursorModels.length === 0) {
        return [
          {
            selectionId: buildSelectionId('cursor', this._defaultModelForProvider('cursor')),
            provider: 'cursor',
            modelId: this._defaultModelForProvider('cursor'),
            label: `${groupLabel} (no models listed)`,
            groupLabel,
          },
        ];
      }
      return cursorModels.map((entry) => ({
        selectionId: buildSelectionId('cursor', entry.id),
        provider: 'cursor' as const,
        modelId: entry.id,
        label: entry.displayName || entry.id,
        groupLabel,
      }));
    } catch {
      return [
        {
          selectionId: buildSelectionId('cursor', this._defaultModelForProvider('cursor')),
          provider: 'cursor',
          modelId: this._defaultModelForProvider('cursor'),
          label: `${providerDisplayName('cursor')} (unavailable)`,
          groupLabel: providerDisplayName('cursor'),
        },
      ];
    }
  }

  private async _collectOpencodeModels(
    config: vscode.WorkspaceConfiguration,
    active: AiScopeSettings,
  ): Promise<AiCatalogEntry[]> {
    if (!this._shouldProbeOpencode(config, active)) {
      return [];
    }
    return this._collectProviderModels('opencode', () => listOpencodeModels(config));
  }

  private async _collectDirectApiKeyModels(): Promise<AiCatalogEntry[]> {
    const providers = ['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral'] as DirectApiKeyProvider[];
    const chunks = await Promise.all(
      providers.map(async (provider) => {
        const apiKey = await this.credentials.getApiKey(provider);
        if (!apiKey) {
          return [];
        }
        return this._collectProviderModels(provider, () =>
          this._listForDirectProvider(provider, apiKey),
        );
      }),
    );
    return chunks.flat();
  }

  private async _collectCustomModels(
    config: vscode.WorkspaceConfiguration,
  ): Promise<AiCatalogEntry[]> {
    const customKey = await this.credentials.getApiKey('custom');
    const endpoint = getChatCompletionEndpoint(config.get<string>('aiEndpoint') || '');
    if (!customKey || !endpoint) {
      return [];
    }
    return this._collectProviderModels('custom', () => listCustomModels(endpoint, customKey));
  }

  private async _collectProviderModels(
    provider: AiProviderId,
    listFn: () => Promise<string[]>,
  ): Promise<AiCatalogEntry[]> {
    const groupLabel = providerDisplayName(provider);
    try {
      const models = await this._getCachedModels(provider, listFn);
      if (models.length === 0) {
        return [
          {
            selectionId: buildSelectionId(provider, this._defaultModelForProvider(provider)),
            provider,
            modelId: this._defaultModelForProvider(provider),
            label: `${groupLabel} (no models listed)`,
            groupLabel,
          },
        ];
      }
      return models.map((modelId) => ({
        selectionId: buildSelectionId(provider, modelId),
        provider,
        modelId,
        label: modelId,
        groupLabel,
      }));
    } catch {
      return [
        {
          selectionId: buildSelectionId(provider, this._defaultModelForProvider(provider)),
          provider,
          modelId: this._defaultModelForProvider(provider),
          label: `${groupLabel} (unavailable)`,
          groupLabel,
        },
      ];
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
      case 'nexql-free':
        return 'smart';
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
