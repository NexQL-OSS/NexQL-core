import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { getChatViewProvider } from '../../../extension';
import { MODERN_WEBVIEW_BASE_CSS } from '../../../common/htmlStyles';
import { readSharedTemplateCss } from '../../../lib/template-loader';
import { AiCredentialsService } from '../AiCredentialsService';
import { AiModelCatalogService } from '../AiModelCatalogService';
import {
  readAiScopeSettings,
  rememberLastModelForProvider,
  writeAiScopeSettings,
} from '../aiConfig';
import { AiConfigScope, DirectApiKeyProvider, AiProviderId } from '../types';
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
} from '../modelListing';

export interface AiSettings {
  configScope?: AiConfigScope;
  provider: string;
  apiKey?: string;
  apiKeys?: Partial<Record<DirectApiKeyProvider, string>>;
  cursorApiKey?: string;
  model?: string;
  endpoint?: string;
  githubAuth?: {
    connected: boolean;
    accountLabel?: string;
  };
}

// GitHub Models access for OAuth sessions does not require a dedicated OAuth scope.
// Requesting `models:read` here can force PAT fallback in some VS Code distributions.
const GITHUB_MODELS_SCOPES: string[] = [];
const GITHUB_MODELS_API_VERSION = '2026-03-10';
const DEFAULT_GITHUB_MODEL = 'openai/gpt-4.1';

/** Webview `getFormData()` sends Cursor keys as `apiKey`; accept both shapes. */
function cursorApiKeyFromSettings(settings: { cursorApiKey?: string; apiKey?: string }): string {
  const raw = settings.cursorApiKey ?? settings.apiKey ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function directApiKeyFromSettings(
  settings: AiSettings,
  provider: DirectApiKeyProvider,
): string {
  const fromMap = settings.apiKeys?.[provider];
  if (fromMap) {
    return fromMap;
  }
  if (settings.provider === provider && settings.apiKey) {
    return settings.apiKey;
  }
  return '';
}

export class AiSettingsPanel {
  public static currentPanel: AiSettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _configScope: AiConfigScope = 'notebook';

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly _extensionContext: vscode.ExtensionContext
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._initialize();

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'connectGitHub':
            await this._connectGitHub();
            break;

          case 'disconnectGitHub':
            await this._disconnectGitHub();
            break;

          case 'saveSettings':
            try {
              const settings = message.settings as AiSettings;
              const scope: AiConfigScope =
                settings.configScope === 'chat' ? 'chat' : 'notebook';
              this._configScope = scope;

              await this._setScopedProvider(
                scope,
                settings.provider,
                settings.model || '',
                settings.endpoint || '',
              );

              const credentials = AiCredentialsService.getInstance(this._extensionContext);
              if (settings.apiKeys) {
                await credentials.saveAllApiKeys(settings.apiKeys);
              }

              const ck = cursorApiKeyFromSettings(settings);
              await credentials.setCursorApiKey(ck || undefined);

              if (settings.model) {
                await rememberLastModelForProvider(
                  this._extensionContext,
                  settings.provider as AiProviderId,
                  settings.model,
                );
              }

              AiModelCatalogService.getInstance(this._extensionContext).invalidateCache();

              this._panel.webview.postMessage({
                type: 'saveSuccess',
              });

              const chatViewProvider = getChatViewProvider();
              if (chatViewProvider) {
                chatViewProvider.refreshModelInfo();
              }

              vscode.window.showInformationMessage('AI settings saved successfully!');
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: 'saveError',
                error: err.message,
              });
            }
            break;

          case 'testConnection':
            try {
              const settings = message.settings;
              let testResult = '';

              if (settings.provider === 'vscode-lm') {
                // Test VS Code LM
                let models: vscode.LanguageModelChat[];

                if (settings.model) {
                  const resolved = await resolveVsCodeLanguageModel(settings.model);
                  if (resolved) {
                    models = [resolved];
                    testResult = `VS Code Language Model available: ${resolved.name || resolved.id}`;
                  } else {
                    const allModels = await vscode.lm.selectChatModels({});
                    testResult = `Configured model "${settings.model}" not found. Available models: ${allModels.map(m => m.name || m.id).join(', ')}`;
                  }
                } else {
                  // No specific model configured, check for any available models
                  models = await vscode.lm.selectChatModels({});
                  if (models.length > 0) {
                    testResult = `VS Code Language Model available. Found ${models.length} model(s): ${models.slice(0, 3).map(m => m.name || m.id).join(', ')}${models.length > 3 ? '...' : ''}`;
                  } else {
                    throw new Error('No VS Code Language Models available. Please install GitHub Copilot or other LM extension.');
                  }
                }
              } else if (settings.provider === 'github') {
                const session = await this._requestGitHubSession(true);
                testResult = await this._testGitHubModels(session.accessToken, settings.model || DEFAULT_GITHUB_MODEL);
              } else if (settings.provider === 'cursor') {
                testResult = await this._testCursor(cursorApiKeyFromSettings(settings), settings.model || 'auto');
              } else if (settings.provider === 'openai') {
                const openaiKey = directApiKeyFromSettings(settings, 'openai');
                if (!openaiKey) {
                  throw new Error('API Key is required for OpenAI');
                }
                testResult = await this._testOpenAI(openaiKey, settings.model || 'gpt-4.1');
              } else if (settings.provider === 'anthropic') {
                const anthropicKey = directApiKeyFromSettings(settings, 'anthropic');
                if (!anthropicKey) {
                  throw new Error('API Key is required for Anthropic');
                }
                testResult = await this._testAnthropic(
                  anthropicKey,
                  settings.model || 'claude-sonnet-4-20250514',
                );
              } else if (settings.provider === 'gemini') {
                const geminiKey = directApiKeyFromSettings(settings, 'gemini');
                if (!geminiKey) {
                  throw new Error('API Key is required for Gemini');
                }
                testResult = await this._testGemini(geminiKey, settings.model || 'gemini-2.5-flash');
              } else if (settings.provider === 'custom') {
                // Test custom endpoint
                if (!settings.endpoint) {
                  throw new Error('Endpoint is required for custom provider');
                }
                testResult = 'Custom endpoint configured. Ensure it supports OpenAI-compatible API.';
              } else if (settings.provider === 'ollama') {
                const ep = settings.endpoint || 'http://localhost:11434/v1/chat/completions';
                testResult = await this._testLocalEndpoint(ep, 'Ollama');
              } else if (settings.provider === 'lmstudio') {
                const ep = settings.endpoint || 'http://localhost:1234/v1/chat/completions';
                testResult = await this._testLocalEndpoint(ep, 'LM Studio');
              }

              this._panel.webview.postMessage({
                type: 'testSuccess',
                result: testResult
              });
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: 'testError',
                error: err.message
              });
            }
            break;

          case 'loadSettings':
            try {
              if (message.configScope === 'chat' || message.configScope === 'notebook') {
                this._configScope = message.configScope;
              }
              await this._sendSettingsLoaded();
            } catch (err: any) {
              console.error('Failed to load settings:', err);
            }
            break;

          case 'listModels':
            try {
              const settings = message.settings;
              let models: Array<string | { id: string; displayName?: string }> = [];

              if (settings.provider === 'vscode-lm') {
                models = await listVsCodeLanguageModels();
              } else if (settings.provider === 'github') {
                const session = await this._requestGitHubSession(true);
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
                const ep = settings.endpoint || 'http://localhost:11434/v1/chat/completions';
                models = await listCustomModels(ep, '');
              } else if (settings.provider === 'lmstudio') {
                const ep = settings.endpoint || 'http://localhost:1234/v1/chat/completions';
                models = await listCustomModels(ep, '');
              }

              this._panel.webview.postMessage({
                type: 'modelsListed',
                models: models
              });
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: 'modelsListError',
                error: err.message
              });
            }
            break;
        }
      },
      null,
      this._disposables
    );
  }

  private async _listOpenAIModels(apiKey: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        path: '/v1/models',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      };

      const req = https.request(options, (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              // Filter for chat models only (gpt-*)
              const chatModels = data.data
                .filter((m: any) => m.id.startsWith('gpt-'))
                .map((m: any) => m.id)
                .sort()
                .reverse(); // Show newer models first
              resolve(chatModels);
            } catch (e) {
              reject(new Error('Failed to parse models response'));
            }
          } else {
            reject(new Error(`Failed to list models: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err: any) => reject(err));
      req.end();
    });
  }

  private async _listAnthropicModels(apiKey: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/models',
        method: 'GET',
        headers: {
          'X-Api-Key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      };

      const req = https.request(options, (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);

              // Accept several response shapes (models, data, or array)
              let list: any[] = [];
              if (Array.isArray(data)) {
                list = data;
              } else if (Array.isArray(data.models)) {
                list = data.models;
              } else if (Array.isArray(data.data)) {
                list = data.data;
              } else {
                for (const k of Object.keys(data)) {
                  if (Array.isArray((data as any)[k])) {
                    list = (data as any)[k];
                    break;
                  }
                }
              }

              const models = list
                .map((m: any) => m.id || m.name || m.model || (typeof m === 'string' ? m : undefined))
                .filter(Boolean)
                .sort();

              resolve(models as string[]);
            } catch (e) {
              reject(new Error('Failed to parse Anthropic models response'));
            }
          } else {
            reject(new Error(`Failed to list Anthropic models: ${res.statusCode} - ${body}`));
          }
        });
      });

      req.on('error', (err: any) => reject(err));
      req.end();
    });
  }

  private async _listGeminiModels(apiKey: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models?key=${apiKey}`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              // Filter for generateContent capable models
              const models = data.models
                .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
                .map((m: any) => m.name.replace('models/', ''))
                .sort();
              resolve(models);
            } catch (e) {
              reject(new Error('Failed to parse models response'));
            }
          } else {
            reject(new Error(`Failed to list models: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err: any) => reject(err));
      req.end();
    });
  }

  private async _listCustomModels(endpoint: string, apiKey: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(endpoint);
        // Try OpenAI-compatible /v1/models endpoint
        const modelsPath = url.pathname.replace(/\/chat\/completions$/, '') + '/models';

        const options = {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: modelsPath,
          method: 'GET',
          headers: apiKey ? {
            'Authorization': `Bearer ${apiKey}`
          } : {}
        };

        const protocol = url.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res: any) => {
          let body = '';
          res.on('data', (chunk: any) => body += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const data = JSON.parse(body);
                const models = data.data?.map((m: any) => m.id) || [];
                resolve(models);
              } catch (e) {
                resolve(['custom-model']); // Fallback
              }
            } else {
              resolve(['custom-model']); // Fallback
            }
          });
        });

        req.on('error', () => resolve(['custom-model'])); // Fallback on error
        req.end();
      } catch (e) {
        resolve(['custom-model']); // Fallback
      }
    });
  }

  private async _requestGitHubSession(interactive: boolean): Promise<vscode.AuthenticationSession> {
    return await vscode.authentication.getSession('github', GITHUB_MODELS_SCOPES, interactive ? {
      createIfNone: true,
      forceNewSession: false,
      clearSessionPreference: false
    } as any : {
      silent: true,
      clearSessionPreference: false
    });
  }

  private async _getGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession('github', GITHUB_MODELS_SCOPES, {
        silent: true,
        clearSessionPreference: false
      });
    } catch {
      return undefined;
    }
  }

  private async _listGitHubModels(token: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'models.github.ai',
        path: '/catalog/models',
        method: 'GET',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION
        }
      };

      const req = https.request(options, (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              const models = Array.isArray(data)
                ? data
                    .filter((model: any) => (model.supported_output_modalities?.includes('text') ?? true))
                    .map((model: any) => model.id)
                    .filter(Boolean)
                    .sort()
                : [];
              resolve(models);
            } catch {
              reject(new Error('Failed to parse GitHub Models catalog response'));
            }
          } else {
            reject(new Error(`Failed to list GitHub Models: ${res.statusCode} - ${body}`));
          }
        });
      });

      req.on('error', (err: any) => reject(err));
      req.end();
    });
  }

  private async _testGitHubModels(token: string, model: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 16,
        temperature: 0.2
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
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
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

  private async _sendSettingsLoaded(): Promise<void> {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const credentials = AiCredentialsService.getInstance(this._extensionContext);
    const apiKeys = await credentials.getAllApiKeys();
    const cursorApiKey = (await credentials.getCursorApiKey()) || '';
    const githubSession = await getGitHubSession();
    const scoped = readAiScopeSettings(config, this._configScope);

    await this._panel.webview.postMessage({
      type: 'settingsLoaded',
      settings: {
        configScope: this._configScope,
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

  private async _setScopedProvider(
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

  private async _connectGitHub(): Promise<void> {
    const session = await this._requestGitHubSession(true);
    await this._setScopedProvider(this._configScope, 'github', '', '');
    await this._panel.webview.postMessage({
      type: 'githubConnected',
      accountLabel: session.account.label,
      scopes: session.scopes
    });
    await this._sendSettingsLoaded();
    await this._refreshModelInfo();
  }

  private async _disconnectGitHub(): Promise<void> {
    await this._setScopedProvider(this._configScope, 'vscode-lm', '', '');
    await this._panel.webview.postMessage({
      type: 'githubDisconnected'
    });
    await this._sendSettingsLoaded();
    await this._refreshModelInfo();
  }

  private async _refreshModelInfo(): Promise<void> {
    const chatViewProvider = getChatViewProvider();
    if (chatViewProvider) {
      chatViewProvider.refreshModelInfo();
    }
  }

  private async _testLocalEndpoint(endpoint: string, name: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(endpoint);
        const modelsPath = url.pathname.replace(/\/chat\/completions$/, '') + '/models';
        const protocol = url.protocol === 'https:' ? https : http;
        const req = protocol.request({
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: modelsPath,
          method: 'GET'
        }, (res: any) => {
          if (res.statusCode === 200) {
            resolve(`${name} is running and reachable at ${url.hostname}:${url.port || 80}`);
          } else {
            reject(new Error(`${name} responded with status ${res.statusCode}. Is it running?`));
          }
          res.resume();
        });
        req.on('error', () => reject(new Error(`Cannot reach ${name} at ${endpoint}. Make sure it is running.`)));
        req.end();
      } catch (e: any) {
        reject(new Error(`Invalid endpoint URL: ${e.message}`));
      }
    });
  }

  private async _loadCursorSdk(): Promise<any> {
    try {
      return await import('@cursor/sdk');
    } catch {
      throw new Error('Cursor SDK is not installed. Install @cursor/sdk to use the Cursor provider.');
    }
  }

  private _resolveCursorApiKey(apiKey: string): string {
    return apiKey || process.env.CURSOR_API_KEY || '';
  }

  private async _listCursorModels(apiKey: string): Promise<Array<{ id: string; displayName?: string }>> {
    const { Cursor } = await this._loadCursorSdk();
    const resolvedApiKey = this._resolveCursorApiKey(apiKey);
    const models = await Cursor.models.list({ apiKey: resolvedApiKey });

    return (models || [])
      .map((model: any) => ({
        id: model.id,
        displayName: model.displayName || model.id,
      }))
      .filter((model: { id: string }) => !!model.id)
      .sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id));
  }

  private async _testCursor(apiKey: string, model: string): Promise<string> {
    const { Cursor } = await this._loadCursorSdk();
    const resolvedApiKey = this._resolveCursorApiKey(apiKey);
    if (!resolvedApiKey) {
      throw new Error('Cursor API key is required. Set CURSOR_API_KEY or save it in AI Settings.');
    }

    const user = await Cursor.me({ apiKey: resolvedApiKey });
    const models = await Cursor.models.list({ apiKey: resolvedApiKey });
    const matching = (models || []).find((entry: any) => entry.id === model || entry.displayName === model);
    if (model && model !== 'auto' && !matching) {
      throw new Error(`Configured Cursor model "${model}" not found. Available models: ${(models || []).map((entry: any) => entry.id).join(', ')}`);
    }

    return `Cursor connection successful${user.userEmail ? ` for ${user.userEmail}` : ''}${model && model !== 'auto' ? `! Model: ${model}` : '!'}`;
  }

  private async _testOpenAI(apiKey: string, model: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      });

      const options = {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': data.length
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
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

  private async _testAnthropic(apiKey: string, model: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': data.length
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
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

  private async _testGemini(apiKey: string, model: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        contents: [{ parts: [{ text: 'Hello' }] }]
      });

      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
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

  public static show(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    const column = vscode.ViewColumn.One;

    if (AiSettingsPanel.currentPanel) {
      AiSettingsPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiSettings',
      'AI Settings',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    AiSettingsPanel.currentPanel = new AiSettingsPanel(panel, extensionUri, context);
  }


  private async _initialize() {
    this._panel.webview.html = await this._getHtmlContent();
  }

  private async _getHtmlContent(): Promise<string> {
    const nonce = this._getNonce();
    const logoUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'postgres-vsc-icon.png')
    );
    const cspSource = this._panel.webview.cspSource;

    try {
      // Load template files
      const templatesDir = vscode.Uri.joinPath(this._extensionUri, 'templates', 'ai-settings');

      const [htmlBuffer, cssBuffer, jsBuffer, sharedCss] = await Promise.all([
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'index.html')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'styles.css')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'scripts.js')),
        readSharedTemplateCss(this._extensionUri)
      ]);

      let html = new TextDecoder().decode(htmlBuffer);
      const css = new TextDecoder().decode(cssBuffer);
      const inlineStyles = `${MODERN_WEBVIEW_BASE_CSS}\n${sharedCss}\n${css}`;
      const js = new TextDecoder().decode(jsBuffer);

      // Build CSP string
      const csp = `default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

      // Replace placeholders
      html = html.replace('{{CSP}}', csp);
      html = html.replace('{{INLINE_STYLES}}', () => inlineStyles);
      html = html.replace('{{INLINE_SCRIPTS}}', () => js);
      html = html.replace(/\{\{NONCE\}\}/g, nonce);
      html = html.replace('{{LOGO_URI}}', logoUri.toString());

      return html;
    } catch (error) {
      console.error('Failed to load AI settings templates:', error);
      return `<!DOCTYPE html>
            <html>
            <body>
                <h1>Error loading AI Settings</h1>
                <p>Could not load template files. Please check that the extension is installed correctly.</p>
                <p>Error: ${error instanceof Error ? error.message : String(error)}</p>
            </body>
            </html>`;
    }
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private dispose() {
    AiSettingsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
