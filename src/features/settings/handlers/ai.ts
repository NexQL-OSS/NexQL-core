import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { getChatViewProvider } from '../../../extension';
import { AiCredentialsService } from '../../aiAssistant/AiCredentialsService';
import { AiModelCatalogService } from '../../aiAssistant/AiModelCatalogService';
import {
  readAiScopeSettings,
  rememberLastModelForProvider,
  writeAiScopeSettings,
  getChatCompletionEndpoint,
} from '../../aiAssistant/aiConfig';
import { AiConfigScope, DIRECT_API_KEY_PROVIDERS, DirectApiKeyProvider, AiProviderId } from '../../aiAssistant/types';
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
  resolveVsCodeLanguageModel,
} from '../../aiAssistant/modelListing';
import { AccountService } from '../../sync/AccountService';
import { LicenseService } from '../../../services/LicenseService';
import { listOpencodeModels, testOpencodeConnection } from '../../aiAssistant/opencode';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';

export interface AiSettings {
  configScope?: AiConfigScope;
  provider?: string;
  scope?: string;
  defaultNotebookProvider?: string;
  defaultNotebookModel?: string;
  defaultChatProvider?: string;
  defaultChatModel?: string;
  apiKey?: string;
  apiKeys?: Partial<Record<DirectApiKeyProvider, string>>;
  cursorApiKey?: string;
  opencodeCliPath?: string;
  opencodeServeUrl?: string;
  opencodeAutoServe?: boolean;
  opencodeShowLog?: boolean;
  opencodeSkipPermissions?: boolean;
  opencodeAutoApprovePermissions?: boolean;
  opencodeServePort?: number;
  model?: string;
  endpoint?: string;
}

// GitHub Models access for OAuth sessions does not require a dedicated OAuth scope.
// Requesting `models:read` here can force PAT fallback in some VS Code distributions.
const GITHUB_MODELS_SCOPES: string[] = [];
const GITHUB_MODELS_API_VERSION = '2026-03-10';
const DEFAULT_GITHUB_MODEL = 'openai/gpt-4.1';
const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const DEFAULT_LMSTUDIO_ENDPOINT = 'http://localhost:1234/v1/chat/completions';
const API_TEST_ERROR_BODY_MAX_LEN = 120;

function formatApiTestError(provider: string, statusCode: number | undefined, body: string): string {
  let detail = (body || '').trim();
  detail = detail
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/\s+/g, ' ');
  if (detail.length > API_TEST_ERROR_BODY_MAX_LEN) {
    detail = detail.slice(0, API_TEST_ERROR_BODY_MAX_LEN) + '…';
  }
  const status = statusCode != null ? String(statusCode) : 'unknown';
  return detail
    ? `${provider} API error: ${status} — ${detail}`
    : `${provider} API error: ${status} — request failed`;
}

/** Webview `getFormData()` sends Cursor keys as `apiKey`; accept both shapes. */
function cursorApiKeyFromSettings(settings: { cursorApiKey?: string; apiKey?: string }): string {
  const raw = settings.cursorApiKey ?? settings.apiKey ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function directApiKeyFromSettings(settings: AiSettings, provider: DirectApiKeyProvider): string {
  const fromMap = settings.apiKeys?.[provider];
  if (fromMap) {
    return fromMap;
  }
  if (settings.provider === provider && settings.apiKey) {
    return settings.apiKey;
  }
  return '';
}

async function resolveDirectApiKey(
  credentials: AiCredentialsService,
  settings: AiSettings,
  provider: DirectApiKeyProvider,
): Promise<string> {
  const fromWebview = directApiKeyFromSettings(settings, provider);
  if (fromWebview) {
    return fromWebview;
  }
  return (await credentials.getApiKey(provider)) || '';
}

async function resolveCursorApiKey(
  credentials: AiCredentialsService,
  settings: { cursorApiKey?: string; apiKey?: string },
): Promise<string> {
  const fromWebview = cursorApiKeyFromSettings(settings);
  if (fromWebview) {
    return fromWebview;
  }
  return (await credentials.getCursorApiKey()) || '';
}

export class AiSectionHandler implements SettingsSectionHandler {
  readonly section = 'ai';
  private configScope: AiConfigScope = 'notebook';

  constructor(private readonly host: SettingsHubHostContext) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        if (message.configScope === 'chat' || message.configScope === 'notebook') {
          this.configScope = message.configScope;
        }
        await this.sendSettingsLoaded();
        break;
      case 'save':
        await this.save(message.settings as AiSettings);
        break;
      case 'test':
        await this.test(message.settings as AiSettings);
        break;
      case 'listModels':
        await this.listModels(message.settings as AiSettings);
        break;
      case 'connectGitHub':
        await this.connectGitHub();
        break;
      case 'disconnectGitHub':
        await this.disconnectGitHub();
        break;
    }
  }

  private async sendSettingsLoaded(): Promise<void> {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const credentials = AiCredentialsService.getInstance(this.host.extensionContext);
    const configuredProviders = await credentials.getAllConfiguredProviders();
    const apiKeysConfigured: Partial<Record<DirectApiKeyProvider, boolean>> = {};
    for (const provider of DIRECT_API_KEY_PROVIDERS) {
      apiKeysConfigured[provider] = configuredProviders.includes(provider);
    }
    const cursorApiKeyConfigured = Boolean(await credentials.getCursorApiKey());
    const githubSession = await getGitHubSession();
    
    const notebookScope = readAiScopeSettings(config, 'notebook');
    const chatScope = readAiScopeSettings(config, 'chat');
    const lastModels = this.host.extensionContext.globalState.get<Record<string, string>>('postgresExplorer.ai.lastModelsByProvider') || {};

    this.host.post({
      type: 'ai/settings',
      settings: {
        configScope: this.configScope,
        notebookProvider: notebookScope.provider,
        notebookModel: notebookScope.model,
        chatProvider: chatScope.provider,
        chatModel: chatScope.model,
        lastModels,
        apiKeysConfigured,
        cursorApiKeyConfigured,
        opencodeCliPath: config.get('opencodeCliPath', ''),
        opencodeServeUrl: config.get('opencodeServeUrl', ''),
        opencodeAutoServe: config.get('opencodeAutoServe', true),
        opencodeShowLog: config.get('opencodeShowLog', true),
        opencodeSkipPermissions: config.get('opencodeSkipPermissions', true),
        opencodeAutoApprovePermissions: config.get('opencodeAutoApprovePermissions', true),
        opencodeServePort: config.get('opencodeServePort', 0),
        endpoint: config.get('aiEndpoint', ''),
        githubAuth: {
          connected: !!githubSession,
          accountLabel: githubSession?.account?.label,
        },
      },
    });
  }

  private async save(settings: AiSettings): Promise<void> {
    try {
      const credentials = AiCredentialsService.getInstance(this.host.extensionContext);
      if (settings.apiKeys) {
        for (const provider of DIRECT_API_KEY_PROVIDERS) {
          if (!Object.prototype.hasOwnProperty.call(settings.apiKeys, provider)) {
            continue;
          }
          const value = settings.apiKeys[provider];
          if (value && value.trim()) {
            await credentials.setApiKey(provider, value.trim());
          }
        }
      }

      const ck = cursorApiKeyFromSettings(settings);
      if (ck) {
        await credentials.setCursorApiKey(ck);
      }

      const config = vscode.workspace.getConfiguration('postgresExplorer');
      await config.update(
        'opencodeCliPath',
        settings.opencodeCliPath?.trim() || '',
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'opencodeServeUrl',
        settings.opencodeServeUrl?.trim() || '',
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'opencodeAutoServe',
        settings.opencodeAutoServe !== false,
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'opencodeShowLog',
        settings.opencodeShowLog !== false,
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'opencodeSkipPermissions',
        settings.opencodeSkipPermissions !== false,
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'opencodeAutoApprovePermissions',
        settings.opencodeAutoApprovePermissions !== false,
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'opencodeServePort',
        typeof settings.opencodeServePort === 'number' ? settings.opencodeServePort : 0,
        vscode.ConfigurationTarget.Global,
      );

      // Save custom endpoint
      await config.update(
        'aiEndpoint',
        settings.endpoint || '',
        vscode.ConfigurationTarget.Global,
      );

      // Save notebook scope defaults
      if (settings.defaultNotebookProvider) {
        await writeAiScopeSettings('notebook', {
          provider: settings.defaultNotebookProvider as AiProviderId,
          model: settings.defaultNotebookModel || '',
        });
        // Also update legacy/fallback config keys
        await config.update('aiProvider', settings.defaultNotebookProvider, vscode.ConfigurationTarget.Global);
        await config.update('aiModel', settings.defaultNotebookModel || '', vscode.ConfigurationTarget.Global);
        
        await rememberLastModelForProvider(
          this.host.extensionContext,
          settings.defaultNotebookProvider as AiProviderId,
          settings.defaultNotebookModel || '',
        );
      }

      // Save chat scope defaults
      if (settings.defaultChatProvider) {
        await writeAiScopeSettings('chat', {
          provider: settings.defaultChatProvider as AiProviderId,
          model: settings.defaultChatModel || '',
        });
        
        await rememberLastModelForProvider(
          this.host.extensionContext,
          settings.defaultChatProvider as AiProviderId,
          settings.defaultChatModel || '',
        );
      }

      AiModelCatalogService.getInstance(this.host.extensionContext).invalidateCache();

      this.host.post({ type: 'ai/saveSuccess' });
      this.refreshModelInfo();
      vscode.window.showInformationMessage('AI settings saved successfully!');
    } catch (err: unknown) {
      this.host.post({
        type: 'ai/saveError',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async test(settings: AiSettings): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const credentials = AiCredentialsService.getInstance(this.host.extensionContext);
      let testResult = '';

      if (settings.provider === 'nexql-free') {
        const account = AccountService.getInstance(this.host.extensionContext);
        await account.ensureAiSession();
        const email = await account.getAccountEmail();
        testResult = email
          ? `NexQL Free AI ready — signed in as ${email}.`
          : 'NexQL Free AI ready.';
      } else if (settings.provider === 'vscode-lm') {
        if (settings.model) {
          const resolved = await resolveVsCodeLanguageModel(settings.model);
          if (resolved) {
            testResult = `VS Code Language Model available: ${resolved.name || resolved.id}`;
          } else {
            const allModels = await vscode.lm.selectChatModels({});
            testResult = `Configured model "${settings.model}" not found. Available models: ${allModels.map((m) => m.name || m.id).join(', ')}`;
          }
        } else {
          const models = await vscode.lm.selectChatModels({});
          if (models.length > 0) {
            testResult = `VS Code Language Model available. Found ${models.length} model(s): ${models.slice(0, 3).map((m) => m.name || m.id).join(', ')}${models.length > 3 ? '...' : ''}`;
          } else {
            throw new Error('No VS Code Language Models available. Please install GitHub Copilot or other LM extension.');
          }
        }
      } else if (settings.provider === 'github') {
        const session = await this.requestGitHubSession(true);
        if (!session) {
          throw new Error('GitHub sign-in was cancelled or unavailable.');
        }
        testResult = await testGitHubModels(session.accessToken, settings.model || DEFAULT_GITHUB_MODEL);
      } else if (settings.provider === 'cursor') {
        const cursorKey = await resolveCursorApiKey(credentials, settings);
        testResult = await testCursor(cursorKey, settings.model || 'auto');
      } else if (settings.provider === 'opencode') {
        testResult = await testOpencodeConnection(config, settings.model || 'auto');
      } else if (settings.provider === 'openai') {
        const openaiKey = await resolveDirectApiKey(credentials, settings, 'openai');
        if (!openaiKey) {
          throw new Error('API Key is required for OpenAI');
        }
        testResult = await testOpenAI(openaiKey, settings.model || 'gpt-4.1');
      } else if (settings.provider === 'anthropic') {
        const anthropicKey = await resolveDirectApiKey(credentials, settings, 'anthropic');
        if (!anthropicKey) {
          throw new Error('API Key is required for Anthropic');
        }
        testResult = await testAnthropic(anthropicKey, settings.model || 'claude-sonnet-4-20250514');
      } else if (settings.provider === 'gemini') {
        const geminiKey = await resolveDirectApiKey(credentials, settings, 'gemini');
        if (!geminiKey) {
          throw new Error('API Key is required for Gemini');
        }
        testResult = await testGemini(geminiKey, settings.model || 'gemini-2.5-flash');
      } else if (settings.provider === 'deepseek') {
        const deepseekKey = await resolveDirectApiKey(credentials, settings, 'deepseek');
        if (!deepseekKey) {
          throw new Error('API Key is required for DeepSeek');
        }
        testResult = await testOpenAiCompatible(
          'api.deepseek.com',
          deepseekKey,
          settings.model || 'deepseek-chat',
          'DeepSeek',
        );
      } else if (settings.provider === 'moonshot') {
        const moonshotKey = await resolveDirectApiKey(credentials, settings, 'moonshot');
        if (!moonshotKey) {
          throw new Error('API Key is required for Moonshot / Kimi');
        }
        testResult = await testOpenAiCompatible(
          'api.moonshot.cn',
          moonshotKey,
          settings.model || 'moonshot-v1-8k',
          'Moonshot / Kimi',
        );
      } else if (settings.provider === 'mistral') {
        const mistralKey = await resolveDirectApiKey(credentials, settings, 'mistral');
        if (!mistralKey) {
          throw new Error('API Key is required for Mistral AI');
        }
        testResult = await testOpenAiCompatible(
          'api.mistral.ai',
          mistralKey,
          settings.model || 'mistral-large-latest',
          'Mistral AI',
        );
      } else if (settings.provider === 'custom') {
        if (!settings.endpoint) {
          throw new Error('Endpoint is required for custom provider');
        }
        const customKey = (await resolveDirectApiKey(credentials, settings, 'custom')) || '';
        testResult = await testCustomEndpoint(
          settings.endpoint,
          customKey,
          settings.model || 'gpt-3.5-turbo',
        );
      } else if (settings.provider === 'ollama') {
        testResult = await testLocalEndpoint(settings.endpoint || DEFAULT_OLLAMA_ENDPOINT, 'Ollama');
      } else if (settings.provider === 'lmstudio') {
        testResult = await testLocalEndpoint(settings.endpoint || DEFAULT_LMSTUDIO_ENDPOINT, 'LM Studio');
      }

      this.host.post({ type: 'ai/testSuccess', result: testResult });
    } catch (err: unknown) {
      this.host.post({
        type: 'ai/testError',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async listModels(settings: AiSettings): Promise<void> {
    try {
      const credentials = AiCredentialsService.getInstance(this.host.extensionContext);
      let models: Array<string | { id: string; displayName?: string }> = [];

      if (settings.provider === 'nexql-free') {
        const currentTier = LicenseService.getInstance().getTier();
        models = listNexqlFreeModels(currentTier).map((m) => ({ id: m.id, displayName: m.displayName }));
      } else if (settings.provider === 'vscode-lm') {
        models = await listVsCodeLanguageModels();
      } else if (settings.provider === 'github') {
        const session = await this.requestGitHubSession(true);
        if (!session) {
          throw new Error('GitHub sign-in was cancelled or unavailable.');
        }
        models = await listGitHubModels(session.accessToken);
      } else if (settings.provider === 'cursor') {
        const cursorKey = await resolveCursorApiKey(credentials, settings);
        models = await listCursorModels(cursorKey);
      } else if (settings.provider === 'opencode') {
        models = await listOpencodeModels(vscode.workspace.getConfiguration('postgresExplorer'));
      } else if (settings.provider === 'openai') {
        const openaiKey = await resolveDirectApiKey(credentials, settings, 'openai');
        if (!openaiKey) {
          throw new Error('API Key is required to list models');
        }
        models = await listOpenAIModels(openaiKey);
      } else if (settings.provider === 'anthropic') {
        const anthropicKey = await resolveDirectApiKey(credentials, settings, 'anthropic');
        if (!anthropicKey) {
          throw new Error('API Key is required to list models for Anthropic');
        }
        models = await listAnthropicModels(anthropicKey);
      } else if (settings.provider === 'gemini') {
        const geminiKey = await resolveDirectApiKey(credentials, settings, 'gemini');
        if (!geminiKey) {
          throw new Error('API Key is required to list models');
        }
        models = await listGeminiModels(geminiKey);
      } else if (settings.provider === 'deepseek') {
        const deepseekKey = await resolveDirectApiKey(credentials, settings, 'deepseek');
        if (!deepseekKey) {
          throw new Error('API Key is required to list DeepSeek models');
        }
        models = await listDeepSeekModels(deepseekKey);
      } else if (settings.provider === 'moonshot') {
        const moonshotKey = await resolveDirectApiKey(credentials, settings, 'moonshot');
        if (!moonshotKey) {
          throw new Error('API Key is required to list Moonshot models');
        }
        models = await listMoonshotModels(moonshotKey);
      } else if (settings.provider === 'mistral') {
        const mistralKey = await resolveDirectApiKey(credentials, settings, 'mistral');
        if (!mistralKey) {
          throw new Error('API Key is required to list Mistral models');
        }
        models = await listMistralModels(mistralKey);
      } else if (settings.provider === 'custom') {
        const customKey = await resolveDirectApiKey(credentials, settings, 'custom');
        if (settings.endpoint && customKey) {
          models = await listCustomModels(settings.endpoint, customKey);
        } else {
          models = ['custom-model'];
        }
      } else if (settings.provider === 'ollama') {
        models = await listCustomModels(settings.endpoint || DEFAULT_OLLAMA_ENDPOINT, '');
      } else if (settings.provider === 'lmstudio') {
        models = await listCustomModels(settings.endpoint || DEFAULT_LMSTUDIO_ENDPOINT, '');
      }

      this.host.post({
        type: 'ai/modelsListed',
        provider: settings.provider,
        scope: settings.scope,
        models,
      });
    } catch (err: unknown) {
      this.host.post({
        type: 'ai/modelsListError',
        provider: settings.provider,
        scope: settings.scope,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async connectGitHub(): Promise<void> {
    try {
      const session = await this.requestGitHubSession(true);
      if (!session) {
        throw new Error('GitHub sign-in was cancelled or unavailable.');
      }
      await this.setScopedProvider(this.configScope, 'github', '', '');
      this.host.post({
        type: 'ai/githubConnected',
        accountLabel: session.account.label,
        scopes: session.scopes,
      });
      await this.sendSettingsLoaded();
      this.refreshModelInfo();
    } catch (err: unknown) {
      this.host.post({
        type: 'ai/githubConnectError',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async disconnectGitHub(): Promise<void> {
    try {
      await this.setScopedProvider(this.configScope, 'vscode-lm', '', '');
      this.host.post({ type: 'ai/githubDisconnected' });
      await this.sendSettingsLoaded();
      this.refreshModelInfo();
    } catch (err: unknown) {
      this.host.post({
        type: 'ai/githubDisconnectError',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async setScopedProvider(
    scope: AiConfigScope,
    provider: string,
    model: string,
    endpoint: string,
  ): Promise<void> {
    await writeAiScopeSettings(scope, {
      provider: provider as AiProviderId,
      model,
    });
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    await config.update('aiEndpoint', endpoint, vscode.ConfigurationTarget.Global);
    if (scope === 'notebook') {
      await config.update('aiProvider', provider, vscode.ConfigurationTarget.Global);
      await config.update('aiModel', model, vscode.ConfigurationTarget.Global);
    }
  }

  private async requestGitHubSession(
    interactive: boolean,
  ): Promise<vscode.AuthenticationSession | undefined> {
    return await vscode.authentication.getSession(
      'github',
      GITHUB_MODELS_SCOPES,
      interactive
        ? ({ createIfNone: true, forceNewSession: false, clearSessionPreference: false } as never)
        : { silent: true, clearSessionPreference: false },
    );
  }

  private refreshModelInfo(): void {
    const chatViewProvider = getChatViewProvider();
    if (chatViewProvider) {
      chatViewProvider.refreshModelInfo();
    }
  }
}

// ── Provider test helpers (ported from AiSettingsPanel) ─────────────────────

function testGitHubModels(token: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 16,
      temperature: 0.2,
    });

    const options = {
      hostname: 'models.github.ai',
      path: '/inference/chat/completions',
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(`GitHub Models connection successful! Model: ${model}`);
        } else {
          reject(new Error(formatApiTestError('GitHub Models', res.statusCode, body)));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

async function loadCursorSdk(): Promise<any> {
  try {
    return await import('@cursor/sdk');
  } catch {
    throw new Error('Cursor SDK is not installed. Install @cursor/sdk to use the Cursor provider.');
  }
}

async function testCursor(apiKey: string, model: string): Promise<string> {
  const { Cursor } = await loadCursorSdk();
  const resolvedApiKey = apiKey || process.env.CURSOR_API_KEY || '';
  if (!resolvedApiKey) {
    throw new Error('Cursor API key is required. Set CURSOR_API_KEY or save it in AI Settings.');
  }

  const user = await Cursor.me({ apiKey: resolvedApiKey });
  const models = await Cursor.models.list({ apiKey: resolvedApiKey });
  const matching = (models || []).find(
    (entry: any) => entry.id === model || entry.displayName === model,
  );
  if (model && model !== 'auto' && !matching) {
    throw new Error(
      `Configured Cursor model "${model}" not found. Available models: ${(models || []).map((entry: any) => entry.id).join(', ')}`,
    );
  }

  return `Cursor connection successful${user.userEmail ? ` for ${user.userEmail}` : ''}${model && model !== 'auto' ? `! Model: ${model}` : '!'}`;
}

/**
 * Generic test for any OpenAI-compatible provider (DeepSeek, Moonshot, Mistral, etc.).
 * Sends a minimal chat completion request and reports success or failure.
 */
function testOpenAiCompatible(
  hostname: string,
  apiKey: string,
  model: string,
  providerLabel: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
    });

    const options = {
      hostname,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(`${providerLabel} connection successful! Model: ${model}`);
        } else {
          reject(new Error(formatApiTestError(providerLabel, res.statusCode, body)));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

function testOpenAI(apiKey: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': data.length,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(`OpenAI connection successful! Model: ${model}`);
        } else {
          reject(new Error(formatApiTestError('OpenAI', res.statusCode, body)));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

function testAnthropic(apiKey: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': data.length,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(`Anthropic connection successful! Model: ${model}`);
        } else {
          reject(new Error(formatApiTestError('Anthropic', res.statusCode, body)));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

function testGemini(apiKey: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      contents: [{ parts: [{ text: 'Hello' }] }],
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': data.length,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(`Gemini connection successful! Model: ${model}`);
        } else {
          reject(new Error(formatApiTestError('Gemini', res.statusCode, body)));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

function testLocalEndpoint(endpoint: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(endpoint);
      const modelsPath = url.pathname.replace(/\/chat\/completions$/, '') + '/models';
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: modelsPath,
          method: 'GET',
        },
        (res) => {
          if (res.statusCode === 200) {
            resolve(`${name} is running and reachable at ${url.hostname}:${url.port || 80}`);
          } else {
            reject(new Error(`${name} responded with status ${res.statusCode}. Is it running?`));
          }
          res.resume();
        },
      );
      req.on('error', () =>
        reject(new Error(`Cannot reach ${name} at ${endpoint}. Make sure it is running.`)),
      );
      req.end();
    } catch (e: unknown) {
      reject(new Error(`Invalid endpoint URL: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

function testCustomEndpoint(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const chatEndpoint = getChatCompletionEndpoint(endpoint);
      const url = new URL(chatEndpoint);
      const data = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10,
      });

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(`Custom endpoint connection successful! Model: ${model}`);
          } else {
            reject(new Error(formatApiTestError('Custom endpoint', res.statusCode, body)));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.write(data);
      req.end();
    } catch (e: unknown) {
      reject(new Error(`Invalid endpoint URL: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

