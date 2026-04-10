import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { getChatViewProvider } from './extension';

export interface AiSettings {
  provider: string;
  apiKey?: string;
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

export class AiSettingsPanel {
  public static currentPanel: AiSettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

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
              const settings = message.settings;
              await this._setProvider(settings.provider, settings.model || '', settings.endpoint || '');

              // Store API key in secret storage
              if (settings.provider === 'github') {
                await this._extensionContext.secrets.delete('postgresExplorer.aiApiKey');
              } else if (settings.apiKey) {
                await this._extensionContext.secrets.store('postgresExplorer.aiApiKey', settings.apiKey);
              } else {
                await this._extensionContext.secrets.delete('postgresExplorer.aiApiKey');
              }

              this._panel.webview.postMessage({
                type: 'saveSuccess'
              });

              // Notify chat view to refresh model info
              const chatViewProvider = getChatViewProvider();
              if (chatViewProvider) {
                chatViewProvider.refreshModelInfo();
              }

              vscode.window.showInformationMessage('AI settings saved successfully!');
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: 'saveError',
                error: err.message
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
                  // Extract base name if format is "name (family)"
                  const baseName = settings.model.replace(/\s*\(.*\)$/, '').trim();

                  // Try to find the specific configured model
                  const allModels = await vscode.lm.selectChatModels({});
                  const matchingModels = allModels.filter(m =>
                    m.id === baseName ||
                    m.name === baseName ||
                    m.family === baseName ||
                    m.id === settings.model ||
                    m.name === settings.model ||
                    m.family === settings.model
                  );

                  if (matchingModels.length > 0) {
                    models = matchingModels;
                    testResult = `VS Code Language Model available: ${models[0].name || models[0].id}`;
                  } else {
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
              } else if (settings.provider === 'openai') {
                // Test OpenAI connection
                if (!settings.apiKey) {
                  throw new Error('API Key is required for OpenAI');
                }
                testResult = await this._testOpenAI(settings.apiKey, settings.model || 'gpt-4');
              } else if (settings.provider === 'anthropic') {
                // Test Anthropic connection
                if (!settings.apiKey) {
                  throw new Error('API Key is required for Anthropic');
                }
                testResult = await this._testAnthropic(settings.apiKey, settings.model || 'claude-3-5-sonnet-20241022');
              } else if (settings.provider === 'gemini') {
                // Test Gemini connection
                if (!settings.apiKey) {
                  throw new Error('API Key is required for Gemini');
                }
                testResult = await this._testGemini(settings.apiKey, settings.model || 'gemini-pro');
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
              await this._sendSettingsLoaded();
            } catch (err: any) {
              console.error('Failed to load settings:', err);
            }
            break;

          case 'listModels':
            try {
              const settings = message.settings;
              let models: string[] = [];

              if (settings.provider === 'vscode-lm') {
                const availableModels = await vscode.lm.selectChatModels();
                models = availableModels.map(m => {
                  // Show model name with family info if available
                  const name = m.name || m.id;
                  const family = m.family;
                  return family && family !== name ? `${name} (${family})` : name;
                });
              } else if (settings.provider === 'github') {
                const session = await this._requestGitHubSession(true);
                models = await this._listGitHubModels(session.accessToken);
              } else if (settings.provider === 'openai') {
                if (!settings.apiKey) {
                  throw new Error('API Key is required to list models');
                }
                models = await this._listOpenAIModels(settings.apiKey);
              } else if (settings.provider === 'anthropic') {
                // Use Anthropic's models API when an API key is provided
                if (!settings.apiKey) {
                  throw new Error('API Key is required to list models for Anthropic');
                }
                models = await this._listAnthropicModels(settings.apiKey);
              } else if (settings.provider === 'gemini') {
                if (!settings.apiKey) {
                  throw new Error('API Key is required to list models');
                }
                models = await this._listGeminiModels(settings.apiKey);
              } else if (settings.provider === 'custom') {
                // Try to list models from custom endpoint using OpenAI-compatible API
                if (settings.endpoint && settings.apiKey) {
                  models = await this._listCustomModels(settings.endpoint, settings.apiKey);
                } else {
                  models = ['custom-model'];
                }
              } else if (settings.provider === 'ollama') {
                const ep = settings.endpoint || 'http://localhost:11434/v1/chat/completions';
                models = await this._listCustomModels(ep, '');
              } else if (settings.provider === 'lmstudio') {
                const ep = settings.endpoint || 'http://localhost:1234/v1/chat/completions';
                models = await this._listCustomModels(ep, '');
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
    const apiKey = await this._extensionContext.secrets.get('postgresExplorer.aiApiKey');
    const githubSession = await this._getGitHubSession();

    await this._panel.webview.postMessage({
      type: 'settingsLoaded',
      settings: {
        provider: config.get('aiProvider', 'vscode-lm'),
        apiKey: apiKey || '',
        model: config.get('aiModel', ''),
        endpoint: config.get('aiEndpoint', ''),
        githubAuth: {
          connected: !!githubSession,
          accountLabel: githubSession?.account.label
        }
      }
    });
  }

  private async _setProvider(provider: string, model: string, endpoint: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    await config.update('aiProvider', provider, vscode.ConfigurationTarget.Global);
    await config.update('aiModel', model, vscode.ConfigurationTarget.Global);
    await config.update('aiEndpoint', endpoint, vscode.ConfigurationTarget.Global);
  }

  private async _connectGitHub(): Promise<void> {
    const session = await this._requestGitHubSession(true);
    await this._setProvider('github', '', '');
    await this._panel.webview.postMessage({
      type: 'githubConnected',
      accountLabel: session.account.label,
      scopes: session.scopes
    });
    await this._sendSettingsLoaded();
    await this._refreshModelInfo();
  }

  private async _disconnectGitHub(): Promise<void> {
    await this._setProvider('vscode-lm', '', '');
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

      const [htmlBuffer, cssBuffer, jsBuffer] = await Promise.all([
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'index.html')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'styles.css')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'scripts.js'))
      ]);

      let html = new TextDecoder().decode(htmlBuffer);
      const css = new TextDecoder().decode(cssBuffer);
      const js = new TextDecoder().decode(jsBuffer);

      // Build CSP string
      const csp = `default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

      // Replace placeholders
      html = html.replace('{{CSP}}', csp);
      html = html.replace('{{INLINE_STYLES}}', () => css);
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
