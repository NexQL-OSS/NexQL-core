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
} from '../../aiAssistant/aiConfig';
import { AiConfigScope, DirectApiKeyProvider, AiProviderId } from '../../aiAssistant/types';
import {
  getGitHubSession,
  listAnthropicModels,
  listCursorModels,
  listCustomModels,
  listGeminiModels,
  listGitHubModels,
  listOpenAIModels,
  listVsCodeLanguageModels,
  resolveVsCodeLanguageModel,
} from '../../aiAssistant/modelListing';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';

export interface AiSettings {
  configScope?: AiConfigScope;
  provider: string;
  apiKey?: string;
  apiKeys?: Partial<Record<DirectApiKeyProvider, string>>;
  cursorApiKey?: string;
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
    const apiKeys = await credentials.getAllApiKeys();
    const cursorApiKey = (await credentials.getCursorApiKey()) || '';
    const githubSession = await getGitHubSession();
    const scoped = readAiScopeSettings(config, this.configScope);

    this.host.post({
      type: 'ai/settings',
      settings: {
        configScope: this.configScope,
        provider: scoped.provider,
        apiKeys,
        cursorApiKey,
        model: scoped.model,
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
      const scope: AiConfigScope = settings.configScope === 'chat' ? 'chat' : 'notebook';
      this.configScope = scope;

      await this.setScopedProvider(
        scope,
        settings.provider,
        settings.model || '',
        settings.endpoint || '',
      );

      const credentials = AiCredentialsService.getInstance(this.host.extensionContext);
      if (settings.apiKeys) {
        await credentials.saveAllApiKeys(settings.apiKeys);
      }

      const ck = cursorApiKeyFromSettings(settings);
      await credentials.setCursorApiKey(ck || undefined);

      if (settings.model) {
        await rememberLastModelForProvider(
          this.host.extensionContext,
          settings.provider as AiProviderId,
          settings.model,
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
      let testResult = '';

      if (settings.provider === 'vscode-lm') {
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
        testResult = await testCursor(cursorApiKeyFromSettings(settings), settings.model || 'auto');
      } else if (settings.provider === 'openai') {
        const openaiKey = directApiKeyFromSettings(settings, 'openai');
        if (!openaiKey) {
          throw new Error('API Key is required for OpenAI');
        }
        testResult = await testOpenAI(openaiKey, settings.model || 'gpt-4.1');
      } else if (settings.provider === 'anthropic') {
        const anthropicKey = directApiKeyFromSettings(settings, 'anthropic');
        if (!anthropicKey) {
          throw new Error('API Key is required for Anthropic');
        }
        testResult = await testAnthropic(anthropicKey, settings.model || 'claude-sonnet-4-20250514');
      } else if (settings.provider === 'gemini') {
        const geminiKey = directApiKeyFromSettings(settings, 'gemini');
        if (!geminiKey) {
          throw new Error('API Key is required for Gemini');
        }
        testResult = await testGemini(geminiKey, settings.model || 'gemini-2.5-flash');
      } else if (settings.provider === 'custom') {
        if (!settings.endpoint) {
          throw new Error('Endpoint is required for custom provider');
        }
        testResult = 'Custom endpoint configured. Ensure it supports OpenAI-compatible API.';
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
      let models: Array<string | { id: string; displayName?: string }> = [];

      if (settings.provider === 'vscode-lm') {
        models = await listVsCodeLanguageModels();
      } else if (settings.provider === 'github') {
        const session = await this.requestGitHubSession(true);
        if (!session) {
          throw new Error('GitHub sign-in was cancelled or unavailable.');
        }
        models = await listGitHubModels(session.accessToken);
      } else if (settings.provider === 'cursor') {
        models = await listCursorModels(cursorApiKeyFromSettings(settings));
      } else if (settings.provider === 'openai') {
        const openaiKey = directApiKeyFromSettings(settings, 'openai');
        if (!openaiKey) {
          throw new Error('API Key is required to list models');
        }
        models = await listOpenAIModels(openaiKey);
      } else if (settings.provider === 'anthropic') {
        const anthropicKey = directApiKeyFromSettings(settings, 'anthropic');
        if (!anthropicKey) {
          throw new Error('API Key is required to list models for Anthropic');
        }
        models = await listAnthropicModels(anthropicKey);
      } else if (settings.provider === 'gemini') {
        const geminiKey = directApiKeyFromSettings(settings, 'gemini');
        if (!geminiKey) {
          throw new Error('API Key is required to list models');
        }
        models = await listGeminiModels(geminiKey);
      } else if (settings.provider === 'custom') {
        const customKey = directApiKeyFromSettings(settings, 'custom');
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

      this.host.post({ type: 'ai/modelsListed', models });
    } catch (err: unknown) {
      this.host.post({
        type: 'ai/modelsListError',
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
          reject(new Error(`GitHub Models API error: ${res.statusCode} - ${body}`));
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
          reject(new Error(`OpenAI API error: ${res.statusCode} - ${body}`));
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
          reject(new Error(`Anthropic API error: ${res.statusCode} - ${body}`));
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
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
          reject(new Error(`Gemini API error: ${res.statusCode} - ${body}`));
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
