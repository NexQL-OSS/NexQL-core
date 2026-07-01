/**
 * AI Provider service for chat functionality
 */
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { ChatMessage, ToolCall } from './types';
import { ToolSpec, mapToOpenAiTools, mapToAnthropicTools, mapToGeminiTools, mapToVsCodeLmTools } from './tools/ToolSpec';

export interface AiResponse {
  text: string;
  usage?: string;
  toolCalls?: ToolCall[];
}

import { SecretStorageService } from '../../services/SecretStorageService';
import { AiCredentialsService } from '../../features/aiAssistant/AiCredentialsService';
import { readAiScopeSettings, getChatCompletionEndpoint } from '../../features/aiAssistant/aiConfig';
import { resolveVsCodeLanguageModel } from '../../features/aiAssistant/modelListing';
import { AiConfigScope } from '../../features/aiAssistant/types';
import { DirectApiKeyProvider } from '../../features/aiAssistant/types';
import { TelemetryService } from '../../services/TelemetryService';
import { AiCapability, buildSystemPrompt as composeSystemPrompt } from './prompts';
import { debugLog, debugWarn } from '../../common/logger';
import {
  listOpencodeModels,
  resolveOpencodeWorkingDirectory,
  runOpencodePrompt,
} from '../../features/aiAssistant/opencode';
import { AccountService } from '../../features/sync/AccountService';
import { DEFAULT_SYNC_API_ENDPOINT } from '../../features/sync/constants';
import { invalidateAiUsageCache } from '../../services/aiUsage';
import { extensionContext } from '../../extension';

// GitHub Models permission applies to fine-grained tokens/GitHub Apps.
// For VS Code OAuth sessions, request no explicit scope.
const GITHUB_MODELS_SCOPES: string[] = [];
const GITHUB_MODELS_API_BASE = 'https://models.github.ai';
const GITHUB_MODELS_API_VERSION = '2026-03-10';
const DEFAULT_GITHUB_MODEL = 'openai/gpt-4.1';
const DEFAULT_CURSOR_MODEL = 'auto';
const DEFAULT_OPENCODE_MODEL = 'auto';
const DIRECT_API_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'gemini',
  'custom',
  'ollama',
  'lmstudio',
  'github',
  'nexql-free',
]);
const NEXQL_AI_CHAT_ENDPOINT = `${DEFAULT_SYNC_API_ENDPOINT.replace(/\/$/, '')}/ai/chat`;
const DEFAULT_NEXQL_FREE_MODEL = 'smart';

/** Heuristic for VS Code LM when the host does not report token usage (UI hint only). */
const ROUGH_CHARS_PER_TOKEN = 4;

/**
 * Current-generation default model IDs per provider (P1.6). Users override via
 * `postgresExplorer.aiModel`. See CHANGELOG 1.4.0 for the rationale behind each pick.
 */
const DEFAULT_OPENAI_MODEL = 'gpt-4.1';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Token budget (P1.3): default context window shared across system + schema + history. */
const DEFAULT_MAX_CONTEXT_TOKENS = 8000;
/** Hard floor so a misconfigured tiny budget still keeps the system + current turn. */
const MIN_CONTEXT_TOKENS = 512;

/** Transient HTTP failures for direct API providers (OpenAI-compatible, Anthropic, etc.). */
const HTTP_RETRY_MAX_ATTEMPTS = 3;
const HTTP_RETRY_BASE_MS = 400;
const HTTP_RETRY_CAP_MS = 8000;

/** Carries HTTP status for non-200 / parse failures so retries can target 5xx and 429. */
export class AiProviderHttpError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly errorCode?: string,
    readonly errorData?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AiProviderHttpError';
  }
}

export class AiService {
  private _messages: ChatMessage[] = [];
  private _cancellationTokenSource: vscode.CancellationTokenSource | null = null;
  private _abortController: AbortController | null = null;

  setMessages(messages: ChatMessage[]): void {
    this._messages = messages;
  }

  /**
   * Cancel any ongoing AI request
   */
  cancel(): void {
    if (this._cancellationTokenSource) {
      this._cancellationTokenSource.cancel();
      this._cancellationTokenSource.dispose();
      this._cancellationTokenSource = null;
    }
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /**
   * Optional connection context injected into the system prompt.
   * Set by ChatViewProvider when the active connection is identified.
   */
  private _connectionContext: {
    environment?: 'production' | 'staging' | 'development';
    readOnlyMode?: boolean;
    connectionName?: string;
    databaseName?: string;
    useAgentic?: boolean;
  } | undefined;

  setConnectionContext(ctx: AiService['_connectionContext']): void {
    this._connectionContext = ctx;
  }

  async callProvider(
    provider: string,
    userMessage: string,
    config: vscode.WorkspaceConfiguration,
    customSystemPrompt?: string,
    scope: AiConfigScope = 'notebook',
    tools?: ToolSpec[],
    onChunk?: (chunk: { text?: string; toolCalls?: ToolCall[] }) => void
  ): Promise<AiResponse> {
    if (provider === 'vscode-lm') {
      return await this.callVsCodeLm(userMessage, config, customSystemPrompt, scope, tools, onChunk);
    }

    if (provider === 'cursor') {
      return await this.callCursorAgent(userMessage, config, customSystemPrompt, scope, onChunk);
    }

    if (provider === 'opencode') {
      return await this.callOpenCodeAgent(userMessage, config, customSystemPrompt, scope);
    }

    return await this.callDirectApi(provider, userMessage, config, customSystemPrompt, scope, tools, onChunk);
  }

  private _resolveConfiguredModel(
    config: vscode.WorkspaceConfiguration,
    scope: AiConfigScope,
  ): string | undefined {
    const scoped = readAiScopeSettings(config, scope).model;
    if (scoped) {
      return scoped;
    }
    return config.get<string>('aiModel') || undefined;
  }

  /**
   * Build the capability-gated system prompt. Defaults to `chat` so existing callers
   * (and the customSystemPrompt fallback) behave as before. The heavy lifting lives in
   * the {@link composeSystemPrompt} composer under `prompts/`.
   */
  buildSystemPrompt(capability: AiCapability = 'chat'): string {
    return composeSystemPrompt(capability, this._connectionContext);
  }

  async callVsCodeLm(
    userMessage: string,
    config: vscode.WorkspaceConfiguration,
    customSystemPrompt?: string,
    scope: AiConfigScope = 'notebook',
    tools?: ToolSpec[],
    onChunk?: (chunk: { text?: string; toolCalls?: ToolCall[] }) => void
  ): Promise<AiResponse> {
    const telemetry = TelemetryService.getInstance();
    const configuredModel = this._resolveConfiguredModel(config, scope);
    let model: vscode.LanguageModelChat | undefined;

    if (configuredModel) {
      model = await resolveVsCodeLanguageModel(configuredModel);
      if (!model) {
        throw new Error(
          `Configured VS Code language model "${configuredModel}" was not found. ` +
            'Open NexQL AI settings, list models, and save your selection again.',
        );
      }
    } else {
      let models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({});
      }
      model = models[0];
    }

    if (!model) {
      throw new Error('No AI models available via VS Code API. Please ensure GitHub Copilot Chat is installed or switch provider.');
    }

    debugLog('[AiService] Selected model details:', JSON.stringify({
      id: model.id,
      name: model.name,
      family: (model as any).family,
      vendor: (model as any).vendor,
      version: (model as any).version,
      maxInputTokens: (model as any).maxInputTokens,
      maxOutputTokens: (model as any).maxOutputTokens
    }));

    const systemPrompt = customSystemPrompt !== undefined ? customSystemPrompt : this.buildSystemPrompt();

    const messages: any[] = [];
    if (systemPrompt) {
      const lmMessageCtor = vscode.LanguageModelChatMessage as any;
      // Prefer system role when available; older API versions only expose User/Assistant.
      if (typeof lmMessageCtor.System === 'function') {
        messages.push(lmMessageCtor.System(systemPrompt));
      } else {
        messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
      }
    }

    const history = this._budgetedHistory(systemPrompt, userMessage, config);

    for (const msg of history) {
      if (msg.role === 'tool') {
        const textPart = new (vscode as any).LanguageModelTextPart(msg.content);
        const resultPart = new (vscode as any).LanguageModelToolResultPart(
          msg.toolCallId!,
          [textPart]
        );
        messages.push(vscode.LanguageModelChatMessage.User([resultPart]));
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const parts: any[] = [];
        if (msg.content) {
          parts.push(new (vscode as any).LanguageModelTextPart(msg.content));
        }
        for (const tc of msg.toolCalls) {
          parts.push(new (vscode as any).LanguageModelToolCallPart(
            tc.id,
            tc.name,
            tc.arguments
          ));
        }
        messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
      } else {
        const text = this._sanitizeContent(this._getMessageContent(msg));
        const images = msg.attachments?.filter(a => a.type === 'image' && a.dataUrl) || [];
        if (images.length > 0) {
          const parts: any[] = [];
          for (const img of images) {
            const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const bytes = Buffer.from(match[2], 'base64');
              const lmImagePart = (vscode as any).LanguageModelImagePart;
              if (typeof lmImagePart === 'function') {
                parts.push(new lmImagePart(match[1], bytes));
              }
            }
          }
          if (text.trim()) {
            parts.push(new (vscode as any).LanguageModelTextPart(text));
          }
          messages.push(msg.role === 'user'
            ? vscode.LanguageModelChatMessage.User(parts.length > 0 ? parts : text)
            : vscode.LanguageModelChatMessage.Assistant(text)
          );
        } else {
          messages.push(msg.role === 'user'
            ? vscode.LanguageModelChatMessage.User(text)
            : vscode.LanguageModelChatMessage.Assistant(text)
          );
        }
      }
    }

    if (userMessage && userMessage.trim()) {
      messages.push(vscode.LanguageModelChatMessage.User(userMessage));
    }

    const compactHistory = history.map((msg, idx) => ({
      idx,
      role: msg.role,
      contentLength: this._getMessageContent(msg).length,
      attachmentCount: msg.attachments?.length || 0,
      mentionCount: msg.mentions?.length || 0
    }));

    debugLog('[AiService] Prepared request payload summary:', JSON.stringify({
      totalMessages: messages.length,
      historyMessages: history.length,
      userMessageLength: userMessage.length,
      systemPromptLength: systemPrompt.length,
      history: compactHistory
    }));

    // Debug: Log all messages being sent to model
    debugLog('[AiService] ========== MESSAGES SENT TO MODEL ==========');
    debugLog('[AiService] System prompt length:', systemPrompt.length);
    debugLog('[AiService] Conversation history messages:', this._messages.length);

    // Create and store cancellation token source for this request
    this._cancellationTokenSource = new vscode.CancellationTokenSource();

    try {
      debugLog('[AiService] sendRequest initial attempt started');
      const requestOptions: vscode.LanguageModelChatRequestOptions = {};
      if (tools && tools.length > 0) {
        requestOptions.tools = mapToVsCodeLmTools(tools);
      }
      const chatRequest = await model.sendRequest(messages, requestOptions, this._cancellationTokenSource.token);
      const rawChatRequest = chatRequest as any;
      debugLog('[AiService] sendRequest initial attempt resolved:', JSON.stringify({
        hasStream: !!rawChatRequest?.stream,
        hasText: !!rawChatRequest?.text,
        hasResult: !!rawChatRequest?.result,
        resultKeys: rawChatRequest?.result ? Object.keys(rawChatRequest.result) : []
      }));

      let effectiveRequest: any = chatRequest;
      const extracted = await this._extractVsCodeLmResponse(chatRequest as any, onChunk);
      let responseText = extracted.text;
      let toolCalls = extracted.toolCalls;
      debugLog('[AiService] Initial extraction result length:', responseText.length, 'toolCalls:', toolCalls?.length);

      // Some models may return an empty text stream on the first attempt for verbose histories.
      // Retry once with a minimal context to avoid persisting blank assistant replies.
      let effectiveMessagesForFallback = messages;
      if (!responseText.trim() && !toolCalls) {
        debugWarn('[AiService] Empty response from VS Code LM; retrying with minimal prompt context.');
        const retryMessages: any[] = [];
        if (systemPrompt) {
          const lmMessageCtor = vscode.LanguageModelChatMessage as any;
          if (typeof lmMessageCtor.System === 'function') {
            retryMessages.push(lmMessageCtor.System(systemPrompt));
          } else {
            retryMessages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
          }
        }
        if (userMessage && userMessage.trim()) {
          retryMessages.push(vscode.LanguageModelChatMessage.User(userMessage));
        }

        debugLog('[AiService] Retry payload summary:', JSON.stringify({
          totalMessages: retryMessages.length,
          userMessageLength: userMessage.length,
          systemPromptLength: systemPrompt.length
        }));

        debugLog('[AiService] sendRequest retry attempt started');
        const retryRequest = await model.sendRequest(retryMessages, requestOptions, this._cancellationTokenSource.token);
        effectiveRequest = retryRequest;
        const rawRetryRequest = retryRequest as any;
        debugLog('[AiService] sendRequest retry attempt resolved:', JSON.stringify({
          hasStream: !!rawRetryRequest?.stream,
          hasText: !!rawRetryRequest?.text,
          hasResult: !!rawRetryRequest?.result,
          resultKeys: rawRetryRequest?.result ? Object.keys(rawRetryRequest.result) : []
        }));

        const retryExtracted = await this._extractVsCodeLmResponse(retryRequest as any, onChunk);
        responseText = retryExtracted.text;
        toolCalls = retryExtracted.toolCalls;
        debugLog('[AiService] Retry extraction result length:', responseText.length);
        effectiveMessagesForFallback = retryMessages;
      }

      // If the configured model yields no chunks at all, try another available model once.
      if (!responseText.trim() && !toolCalls) {
        const fallbackModel = await this._findAlternateModel(model.id);
        if (fallbackModel) {
          debugWarn('[AiService] Selected model produced empty output. Trying alternate model:', fallbackModel.name || fallbackModel.id);
          const fallbackRequest = await fallbackModel.sendRequest(effectiveMessagesForFallback, requestOptions, this._cancellationTokenSource.token);
          effectiveRequest = fallbackRequest;
          const fallbackExtracted = await this._extractVsCodeLmResponse(fallbackRequest as any, onChunk);
          responseText = fallbackExtracted.text;
          toolCalls = fallbackExtracted.toolCalls;
          debugLog('[AiService] Alternate model extraction result length:', responseText.length);
        }
      }

      if (!responseText.trim() && !toolCalls) {
        throw new Error('AI model returned an empty response. Please retry or select a different model.');
      }

      const promptChars = AiService._approxCharsFromLmMessages(effectiveMessagesForFallback);
      let usageStr = await AiService._extractVsCodeLmUsageAfterStream(effectiveRequest);
      if (!usageStr) {
        usageStr = AiService._roughTokenEstimateLabel(promptChars, responseText.length);
      }

      telemetry.trackEvent('ai_request', { provider: 'vscode-lm', success: true });
      return { text: responseText, usage: usageStr, toolCalls };
    } finally {
      // Clean up cancellation token source
      if (this._cancellationTokenSource) {
        this._cancellationTokenSource.dispose();
        this._cancellationTokenSource = null;
      }
    }
  }

  private async _loadCursorSdk(): Promise<any> {
    try {
      return await import('@cursor/sdk');
    } catch {
      throw new Error('Cursor SDK is not installed. Install @cursor/sdk to use the Cursor provider.');
    }
  }

  private async _getCursorApiKey(config: vscode.WorkspaceConfiguration): Promise<string> {
    const secretApiKey = await SecretStorageService.getInstance().getCursorApiKey();
    return secretApiKey || process.env.CURSOR_API_KEY || config.get<string>('cursorApiKey') || '';
  }

  private async _listCursorModels(apiKey: string): Promise<Array<{ id: string; displayName?: string }>> {
    const { Cursor } = await this._loadCursorSdk();
    const resolvedApiKey = apiKey || process.env.CURSOR_API_KEY || '';
    const models = await Cursor.models.list({ apiKey: resolvedApiKey });

    return (models || [])
      .map((model: any) => ({
        id: model.id,
        displayName: model.displayName || model.id,
      }))
      .filter((model: { id: string }) => !!model.id);
  }

  private async _resolveCursorModel(
    config: vscode.WorkspaceConfiguration,
    apiKey: string,
    scope: AiConfigScope = 'notebook',
  ): Promise<string> {
    const configuredModel = this._resolveConfiguredModel(config, scope);
    if (configuredModel) {
      try {
        const models = await this._listCursorModels(apiKey);
        const match = models.find((model) => model.id === configuredModel || model.displayName === configuredModel);
        if (match) {
          return match.id;
        }
      } catch {
        return configuredModel;
      }
      return configuredModel;
    }

    try {
      const models = await this._listCursorModels(apiKey);
      return models[0]?.id || DEFAULT_CURSOR_MODEL;
    } catch {
      return DEFAULT_CURSOR_MODEL;
    }
  }

  private _buildCursorPrompt(userMessage: string, systemPrompt: string, config: vscode.WorkspaceConfiguration): string {
    const history = this._budgetedHistory(systemPrompt, userMessage, config).map((msg, index) => {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      const content = this._sanitizeContent(this._getMessageContent(msg)).trim();
      return `${index + 1}. ${role}: ${content}`;
    }).join('\n');

    const sections = [
      systemPrompt ? `System instructions:\n${systemPrompt}` : '',
      history ? `Conversation history:\n${history}` : '',
      `Current user request:\n${userMessage}`
    ].filter(Boolean);

    return sections.join('\n\n');
  }

  private async _resolveOpencodeModel(
    config: vscode.WorkspaceConfiguration,
    scope: AiConfigScope = 'notebook',
  ): Promise<string | undefined> {
    const configuredModel = this._resolveConfiguredModel(config, scope);
    if (configuredModel && configuredModel !== 'auto') {
      return configuredModel;
    }

    try {
      const models = await listOpencodeModels(config);
      return models[0];
    } catch {
      return undefined;
    }
  }

  private async callOpenCodeAgent(
    userMessage: string,
    config: vscode.WorkspaceConfiguration,
    customSystemPrompt?: string,
    scope: AiConfigScope = 'notebook',
  ): Promise<{ text: string; usage?: string }> {
    const telemetry = TelemetryService.getInstance();
    if (!userMessage || !userMessage.trim()) {
      const lastUser = [...this._messages].reverse().find(m => m.role === 'user');
      if (lastUser && lastUser.content) {
        userMessage = lastUser.content;
      }
    }

    if (!userMessage || !userMessage.trim()) {
      throw new Error('User message is required for AI requests.');
    }

    const model = await this._resolveOpencodeModel(config, scope);
    const systemPrompt = customSystemPrompt !== undefined ? customSystemPrompt : this.buildSystemPrompt();
    const prompt = this._buildCursorPrompt(userMessage, systemPrompt, config);
    const workDir = resolveOpencodeWorkingDirectory(config);

    this._cancellationTokenSource = new vscode.CancellationTokenSource();

    try {
      const result = await runOpencodePrompt(config, {
        prompt,
        model,
        cwd: workDir,
        serveUrl: config.get<string>('opencodeServeUrl')?.trim() || undefined,
        cancellationToken: this._cancellationTokenSource.token,
      });

      const responseText = result.text;
      if (!responseText.trim()) {
        throw new Error('AI model returned an empty response. Please retry or select a different model.');
      }

      telemetry.trackEvent('ai_request', { provider: 'opencode', success: true });
      return { text: responseText, usage: result.usage };
    } catch (error) {
      telemetry.trackEvent('ai_request', { provider: 'opencode', success: false });
      throw error;
    } finally {
      if (this._cancellationTokenSource) {
        this._cancellationTokenSource.dispose();
        this._cancellationTokenSource = null;
      }
    }
  }

  private async callCursorAgent(
    userMessage: string,
    config: vscode.WorkspaceConfiguration,
    customSystemPrompt?: string,
    scope: AiConfigScope = 'notebook',
    onChunk?: (chunk: { text?: string; toolCalls?: ToolCall[] }) => void
  ): Promise<{ text: string; usage?: string }> {
    const telemetry = TelemetryService.getInstance();
    if (!userMessage || !userMessage.trim()) {
      const lastUser = [...this._messages].reverse().find(m => m.role === 'user');
      if (lastUser && lastUser.content) {
        userMessage = lastUser.content;
      }
    }

    if (!userMessage || !userMessage.trim()) {
      throw new Error('User message is required for AI requests.');
    }

    const apiKey = await this._getCursorApiKey(config);
    if (!apiKey) {
      throw new Error('Cursor API key is required. Set CURSOR_API_KEY or save it in AI Settings.');
    }

    const { Agent } = await this._loadCursorSdk();
    const model = await this._resolveCursorModel(config, apiKey, scope);
    const systemPrompt = customSystemPrompt !== undefined ? customSystemPrompt : this.buildSystemPrompt();
    const prompt = this._buildCursorPrompt(userMessage, systemPrompt, config);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    this._cancellationTokenSource = new vscode.CancellationTokenSource();
    let agent: any;

    try {
      agent = await Agent.create({
        apiKey,
        model: { id: model },
        local: { cwd: workspaceRoot }
      });

      const sendOptions: any = {};
      const run = await agent.send({ text: prompt }, sendOptions);
      const cancellationListener = (this._cancellationTokenSource.token as any).onCancellationRequested?.(() => {
        void run.cancel();
      }) ?? { dispose: () => undefined };

      if (onChunk) {
        const token = this._cancellationTokenSource.token;
        (async () => {
          try {
            let lastText = '';
            for await (const msg of run.stream()) {
              if (token.isCancellationRequested) {
                break;
              }
              if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
                let accumulatedText = '';
                for (const block of msg.message.content) {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    accumulatedText += block.text;
                  }
                }
                if (accumulatedText) {
                  if (accumulatedText.startsWith(lastText)) {
                    const delta = accumulatedText.slice(lastText.length);
                    if (delta) {
                      onChunk({ text: delta });
                    }
                    lastText = accumulatedText;
                  } else {
                    onChunk({ text: accumulatedText });
                    lastText = accumulatedText;
                  }
                }
              }
            }
          } catch (e) {
            console.error('[AiService DEBUG] Error streaming from Cursor SDK:', e);
          }
        })();
      }

      try {
        const result = await run.wait();
        cancellationListener.dispose();

        if (result.status === 'cancelled') {
          throw new Error('AI request cancelled.');
        }

        const responseText = result.result || '';
        if (!responseText.trim()) {
          throw new Error('AI model returned an empty response. Please retry or select a different model.');
        }

        const usage = result.durationMs ? `Cursor · ${result.durationMs}ms` : undefined;
        telemetry.trackEvent('ai_request', { provider: 'cursor', success: true });
        return { text: responseText, usage };
      } catch (error) {
        cancellationListener.dispose();
        throw error;
      }
    } catch (error) {
      telemetry.trackEvent('ai_request', { provider: 'cursor', success: false });
      throw error;
    } finally {
      if (this._cancellationTokenSource) {
        this._cancellationTokenSource.dispose();
        this._cancellationTokenSource = null;
      }
      try {
        agent?.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /** Best-effort token / usage string from a consumed VS Code LM response (shape varies by host). */
  private static async _extractVsCodeLmUsageAfterStream(chatRequest: any): Promise<string | undefined> {
    const direct = AiService._usageFromLmResponseObject(chatRequest);
    if (direct) {
      return direct;
    }
    const r = chatRequest?.result;
    if (r && typeof r.then === 'function') {
      try {
        const resolved = await r;
        return AiService._usageFromLmResponseObject(resolved);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private static _usageFromLmResponseObject(obj: any): string | undefined {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }
    const u = obj.usage;
    if (!u || typeof u !== 'object') {
      return undefined;
    }
    if (typeof u.totalTokens === 'number') {
      return `${u.totalTokens} tokens`;
    }
    if (typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number') {
      return `${u.inputTokens} in + ${u.outputTokens} out`;
    }
    if (typeof u.promptTokens === 'number' && typeof u.completionTokens === 'number') {
      return `${u.promptTokens} in + ${u.completionTokens} out`;
    }
    return undefined;
  }

  private static _approxCharsFromLmMessages(lmMessages: any[]): number {
    let n = 0;
    for (const msg of lmMessages) {
      const c = (msg as any)?.content;
      if (typeof c === 'string') {
        n += c.length;
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (typeof part === 'string') {
            n += part.length;
          } else if (part && typeof (part as any).text === 'string') {
            n += (part as any).text.length;
          } else if (part && typeof (part as any).value === 'string') {
            n += (part as any).value.length;
          }
        }
      }
    }
    return n;
  }

  /** Rough token hint when the LM host does not report usage (not billing-grade). */
  private static _roughTokenEstimateLabel(promptChars: number, completionChars: number): string {
    const inTok = Math.max(1, Math.round(promptChars / ROUGH_CHARS_PER_TOKEN));
    const outTok = Math.max(1, Math.round(completionChars / ROUGH_CHARS_PER_TOKEN));
    const total = inTok + outTok;
    return `~${total} tokens (est. · ${inTok} in + ${outTok} out)`;
  }

  // ==================== P1.3 — Token budgeter ====================

  /** Rough char→token estimate reusing the shared {@link ROUGH_CHARS_PER_TOKEN} heuristic. */
  static estimateTokens(text: string | undefined | null): number {
    if (!text) {
      return 0;
    }
    return Math.ceil(text.length / ROUGH_CHARS_PER_TOKEN);
  }

  private static _historyContent(msg: ChatMessage): string {
    let content = msg.content || '';
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        if (att.type !== 'image' && att.content) {
          content += `\n${att.content}`;
        }
      }
    }
    return content;
  }

  /**
   * Pure, DB-/IO-free message assembler that fits a request inside a token budget.
   *
   * Priority (highest first): system → current user message → schema → attachments → history.
   * Trimming order (lowest priority first): drop oldest history, then truncate the schema tail
   * (schema is pre-ranked least-relevant-last by {@link DbObjectService}). The system prompt and
   * the current user message are never dropped.
   */
  static assembleMessages(
    parts: {
      system: string;
      schema?: string;
      currentUser: string;
      attachments?: string[];
      history: ChatMessage[];
    },
    budgetTokens: number,
  ): {
    system: string;
    schema: string;
    currentUser: string;
    attachments: string[];
    history: ChatMessage[];
    trimmed: boolean;
    estimatedTokens: number;
  } {
    const budget = Math.max(
      Number.isFinite(budgetTokens) ? budgetTokens : DEFAULT_MAX_CONTEXT_TOKENS,
      MIN_CONTEXT_TOKENS,
    );

    const system = parts.system || '';
    const currentUser = parts.currentUser || '';
    const attachments = [...(parts.attachments || [])];
    let schema = parts.schema || '';
    let history = [...parts.history];
    let trimmed = false;

    const mandatory = AiService.estimateTokens(system) + AiService.estimateTokens(currentUser);
    const attachmentTokens = attachments.reduce((sum, a) => sum + AiService.estimateTokens(a), 0);

    const fixedExclHistory = () =>
      mandatory + AiService.estimateTokens(schema) + attachmentTokens;

    let historyTokens = history.reduce(
      (sum, m) => sum + AiService.estimateTokens(AiService._historyContent(m)),
      0,
    );

    // 1) Drop oldest history first until everything fits (or history is exhausted).
    while (history.length > 0 && fixedExclHistory() + historyTokens > budget) {
      const removed = history.shift();
      historyTokens -= AiService.estimateTokens(AiService._historyContent(removed as ChatMessage));
      trimmed = true;
    }

    // 2) Still over budget with no history left → truncate the schema tail (least relevant).
    if (schema && fixedExclHistory() > budget) {
      const overflowTokens = fixedExclHistory() - budget;
      const keepChars = Math.max(0, schema.length - overflowTokens * ROUGH_CHARS_PER_TOKEN);
      if (keepChars < schema.length) {
        const truncatedNote = '\n…(schema truncated to fit context budget)';
        schema = keepChars > 0
          ? schema.slice(0, keepChars).trimEnd() + truncatedNote
          : truncatedNote.trimStart();
        trimmed = true;
      }
    }

    const estimatedTokens = fixedExclHistory() + historyTokens;
    return { system, schema, currentUser, attachments, history, trimmed, estimatedTokens };
  }

  /** Resolve the configured context budget (config-relative key `ai.maxContextTokens`). */
  private _maxContextTokens(config: vscode.WorkspaceConfiguration): number {
    const configured = config.get<number>('ai.maxContextTokens');
    if (typeof configured === 'number' && configured > 0) {
      return Math.max(configured, MIN_CONTEXT_TOKENS);
    }
    return DEFAULT_MAX_CONTEXT_TOKENS;
  }

  /**
   * Budget-aware replacement for the former hardcoded `this._messages.slice(-10)`.
   * Returns the history suffix that fits the remaining context window after the system
   * prompt + current user message are reserved.
   */
  private _budgetedHistory(
    systemPrompt: string,
    currentUser: string,
    config: vscode.WorkspaceConfiguration,
  ): ChatMessage[] {
    const budget = this._maxContextTokens(config);
    const assembled = AiService.assembleMessages(
      { system: systemPrompt, currentUser, history: this._messages },
      budget,
    );
    if (assembled.trimmed) {
      this._logTrim(
        `[AiService] Context budget (${budget} tokens) exceeded — trimmed history ` +
          `from ${this._messages.length} to ${assembled.history.length} message(s).`,
      );
    }
    return assembled.history;
  }

  /** Debug-channel log that is safe before activation / in unit tests (lazy, guarded). */
  private _logTrim(message: string): void {
    try {
      const ext = require('../../extension');
      if (ext && ext.outputChannel && typeof ext.outputChannel.appendLine === 'function') {
        ext.outputChannel.appendLine(message);
      }
    } catch {
      // outputChannel unavailable outside the extension host — safe to ignore.
    }
  }

  private async _findAlternateModel(currentModelId: string): Promise<vscode.LanguageModelChat | undefined> {
    const allModels = await this._selectChatModelsWithTimeout({});
    if (allModels.length === 0) {
      return undefined;
    }

    const candidates = allModels.filter(m => m.id !== currentModelId);
    if (candidates.length === 0) {
      return undefined;
    }

    // Prefer known stable families first if available.
    const preferredFamilyOrder = ['gpt-4o', 'gpt-4.1', 'o3', 'claude'];
    for (const family of preferredFamilyOrder) {
      const match = candidates.find(m => (m.family || '').toLowerCase().includes(family));
      if (match) {
        return match;
      }
    }

    return candidates[0];
  }

  private async _extractVsCodeLmResponse(
    chatRequest: any,
    onChunk?: (chunk: { text?: string; toolCalls?: ToolCall[] }) => void
  ): Promise<{ text: string, toolCalls?: ToolCall[] }> {
    let text = '';
    const toolCalls: ToolCall[] = [];
    const streamPartDebug: string[] = [];
    let streamChunkCount = 0;
    let textChunkCount = 0;

    // Stream is the canonical response channel in current VS Code APIs.
    if (chatRequest?.stream && Symbol.asyncIterator in Object(chatRequest.stream)) {
      for await (const part of chatRequest.stream) {
        streamChunkCount += 1;
        const ctorName = part?.constructor?.name || typeof part;
        if (streamPartDebug.length < 8) {
          streamPartDebug.push(ctorName);
        }

        let chunkText = '';
        if (part instanceof (vscode as any).LanguageModelTextPart) {
          chunkText = typeof part.value === 'string' ? part.value : '';
        } else if (part instanceof (vscode as any).LanguageModelToolCallPart || (part && 'callId' in part && 'name' in part)) {
          const tc: ToolCall = {
            id: part.callId,
            name: part.name,
            arguments: part.input
          };
          toolCalls.push(tc);
          if (onChunk) {
            onChunk({ toolCalls: [tc] });
          }
        } else if (typeof part === 'string') {
          chunkText = part;
        } else if (typeof part.text === 'string') {
          chunkText = part.text;
        } else if (typeof part.value === 'string') {
          chunkText = part.value;
        }

        if (chunkText) {
          text += chunkText;
          if (onChunk) {
            onChunk({ text: chunkText });
          }
        }
      }
    }

    debugLog('[AiService] Stream extraction stats:', JSON.stringify({
      streamChunkCount,
      streamChunkTypes: streamPartDebug,
      extractedLength: text.length,
      toolCallsCount: toolCalls.length
    }));

    if (text.trim() || toolCalls.length > 0) {
      return { text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    }

    // Fallback for environments where text is the only available channel.
    if (chatRequest?.text && Symbol.asyncIterator in Object(chatRequest.text)) {
      for await (const fragment of chatRequest.text) {
        textChunkCount += 1;
        const fragmentStr = this._normalizeLmTextFragment(fragment);
        text += fragmentStr;
        if (onChunk && fragmentStr) {
          onChunk({ text: fragmentStr });
        }
      }
    }

    debugLog('[AiService] Text extraction stats:', JSON.stringify({
      textChunkCount,
      extractedLength: text.length
    }));

    if (text.trim()) {
      return { text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    }

    // Last-resort compatibility fallback.
    const resultContent = chatRequest?.result?.content;
    if (typeof resultContent === 'string') {
      debugLog('[AiService] Using result.content string fallback with length:', resultContent.length);
      return { text: resultContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    }
    if (Array.isArray(resultContent)) {
      debugLog('[AiService] Using result.content array fallback with parts:', resultContent.length);
      const fallbackText = resultContent
        .map((item: any) => {
          if (typeof item === 'string') return item;
          if (typeof item?.text === 'string') return item.text;
          if (typeof item?.value === 'string') return item.value;
          return '';
        })
        .join('');
      return { text: fallbackText, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    }

    if (!text.trim() && streamPartDebug.length > 0) {
      debugWarn('[AiService] LM stream yielded non-text parts only:', streamPartDebug.join(' | '));
    }

    return { text: '', toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  private _normalizeLmTextFragment(fragment: any): string {
    if (fragment === null || fragment === undefined) {
      return '';
    }
    if (typeof fragment === 'string') {
      return fragment;
    }
    if (typeof fragment?.value === 'string') {
      return fragment.value;
    }
    if (typeof fragment?.text === 'string') {
      return fragment.text;
    }
    return '';
  }

  private _extractTextFromStreamPart(part: any, debugParts?: string[]): string {
    if (!part) {
      return '';
    }

    const addDebugPart = (value: string): void => {
      if (!debugParts) {
        return;
      }
      if (debugParts.length < 8) {
        debugParts.push(value);
      }
    };

    const ctorName = part?.constructor?.name || typeof part;
    addDebugPart(ctorName);

    if (part instanceof (vscode as any).LanguageModelTextPart) {
      return typeof part.value === 'string' ? part.value : '';
    }

    if (part instanceof (vscode as any).LanguageModelToolCallPart) {
      addDebugPart(`tool:${part.name || 'unknown'}`);
      return '';
    }

    if (typeof part === 'string') {
      return part;
    }
    if (typeof part.text === 'string') {
      return part.text;
    }
    if (typeof part.value === 'string') {
      return part.value;
    }

    const nestedText = part?.part?.text;
    if (typeof nestedText === 'string') {
      return nestedText;
    }

    const nestedValue = part?.part?.value;
    if (typeof nestedValue === 'string') {
      return nestedValue;
    }

    const candidates = [part?.content, part?.chunk, part?.delta];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        return candidate;
      }
      if (typeof candidate?.text === 'string') {
        return candidate.text;
      }
      if (typeof candidate?.value === 'string') {
        return candidate.value;
      }
    }

    return '';
  }

  // Sanitize content to remove any HTML/CSS artifacts before sending to AI
  private _sanitizeContent(content: string): string {
    let cleaned = content;
    // Remove CSS class-like patterns that may have leaked into history
    cleaned = cleaned.replace(/\b(sql-keyword|sql-string|sql-function|sql-number|sql-type|sql-comment|sql-operator|sql-special|function)"\s*>/gi, '');
    return cleaned;
  }

  private _getMessageContent(msg: ChatMessage): string {
    let content = msg.content;
    if (msg.attachments && msg.attachments.length > 0) {
      const attachmentTexts = msg.attachments
        .filter(att => att.type !== 'image')
        .map(att => `\n\nFile: ${att.name} (${att.type})\n\`\`\`${att.type}\n${att.content}\n\`\`\``)
        .join('');
      content += attachmentTexts;
    }
    return content;
  }

  /**
   * Build a multipart content array for providers that support vision (images).
   * Returns null if there are no image attachments (caller should use plain string).
   */
  private _buildMultipartContent(msg: ChatMessage, textOverride?: string): any[] | null {
    const images = msg.attachments?.filter(att => att.type === 'image' && att.dataUrl) || [];
    if (images.length === 0) return null;

    const text = textOverride ?? this._getMessageContent(msg);
    const parts: any[] = [];

    if (text.trim()) {
      parts.push({ type: 'text', text });
    }

    for (const img of images) {
      // dataUrl format: "data:<mimeType>;base64,<data>"
      const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          type: 'image_url',
          image_url: { url: img.dataUrl! }
        });
      }
    }

    return parts.length > 0 ? parts : null;
  }

  /**
   * Build Anthropic-style multipart content with image blocks.
   */
  private _buildAnthropicContent(msg: ChatMessage, textOverride?: string): any[] | string {
    const images = msg.attachments?.filter(att => att.type === 'image' && att.dataUrl) || [];
    const text = textOverride ?? this._getMessageContent(msg);

    if (images.length === 0) return text;

    const parts: any[] = [];
    for (const img of images) {
      const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] }
        });
      }
    }
    if (text.trim()) {
      parts.push({ type: 'text', text });
    }
    return parts;
  }

  /**
   * Build Gemini-style parts array with inline image data.
   */
  private _buildGeminiParts(msg: ChatMessage, textOverride?: string): any[] {
    const images = msg.attachments?.filter(att => att.type === 'image' && att.dataUrl) || [];
    const text = textOverride ?? this._getMessageContent(msg);
    const parts: any[] = [];

    if (text.trim()) {
      parts.push({ text });
    }
    for (const img of images) {
      const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
    }
    return parts;
  }

  async callDirectApi(
    provider: string,
    userMessage: string,
    config: vscode.WorkspaceConfiguration,
    customSystemPrompt?: string,
    scope: AiConfigScope = 'notebook',
    tools?: ToolSpec[],
    onChunk?: (chunk: { text?: string; toolCalls?: ToolCall[] }) => void
  ): Promise<AiResponse> {
    const telemetry = TelemetryService.getInstance();
    if (!DIRECT_API_PROVIDERS.has(provider)) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    // userMessage is optional in tool loops (can be empty if loop history is used)
    const apiKey = await this._getDirectApiKey(config, provider);
    const githubSession = provider === 'github' ? await this._getGitHubSession() : undefined;
    
    // API key is required for most providers, but optional for custom endpoints
    if (!apiKey && provider !== 'custom' && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'github' && provider !== 'nexql-free') {
      throw new Error(`API Key is required for ${provider} provider. Please configure postgresExplorer.aiApiKey.`);
    }

    const nexqlFreeToken = provider === 'nexql-free' ? await this._getNexqlFreeToken() : undefined;

    let endpoint = '';
    let model = this._resolveConfiguredModel(config, scope);
    let headers: any = {
      'Content-Type': 'application/json'
    };
    
    // Only add Authorization header if API key is provided
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    
    let body: any = {};

    const systemPrompt = customSystemPrompt !== undefined ? customSystemPrompt : this.buildSystemPrompt();

    // P1.3: budget-aware history shared across all direct-API provider payloads.
    const budgetedHistory = this._budgetedHistory(systemPrompt, userMessage, config);

    // Sanitize conversation history to remove any HTML artifacts
    const conversationHistory = budgetedHistory.map(msg => ({
      role: msg.role,
      content: this._sanitizeContent(this._getMessageContent(msg))
    }));

    if (provider === 'openai' || provider === 'custom' || provider === 'ollama' || provider === 'lmstudio' || provider === 'github' || provider === 'nexql-free') {
      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      for (const msg of budgetedHistory) {
        if (msg.role === 'tool') {
          messages.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            name: msg.name,
            content: msg.content
          });
        } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
              }
            }))
          });
        } else {
          messages.push({
            role: msg.role,
            content: this._buildMultipartContent(msg) ?? this._sanitizeContent(this._getMessageContent(msg))
          });
        }
      }
      if (userMessage && userMessage.trim()) {
        const currentMsg: ChatMessage = { role: 'user', content: userMessage, attachments: this._messages[this._messages.length - 1]?.attachments };
        const currentMultipart = this._buildMultipartContent(currentMsg, userMessage);
        messages.push({ role: 'user', content: currentMultipart ?? userMessage });
      }

      body = {
        messages: messages,
        temperature: 0.7
      };

      if (provider === 'openai') {
        endpoint = 'https://api.openai.com/v1/chat/completions';
        model = model || DEFAULT_OPENAI_MODEL;
        body.model = model;
      } else if (provider === 'custom') {
        endpoint = getChatCompletionEndpoint(config.get<string>('aiEndpoint') || '');
        if (!endpoint) {
          throw new Error('Endpoint is required for custom provider');
        }
        model = model || 'gpt-3.5-turbo';
        body.model = model;
      } else if (provider === 'ollama') {
        endpoint = getChatCompletionEndpoint(config.get<string>('aiEndpoint') || 'http://localhost:11434/v1/chat/completions');
        model = model || '';
        body.model = model;
      } else if (provider === 'lmstudio') {
        endpoint = getChatCompletionEndpoint(config.get<string>('aiEndpoint') || 'http://localhost:1234/v1/chat/completions');
        model = model || '';
        body.model = model;
      } else if (provider === 'github') {
        if (!githubSession) {
          throw new Error('Sign in to GitHub in AI Settings to use GitHub Models.');
        }
        endpoint = `${GITHUB_MODELS_API_BASE}/inference/chat/completions`;
        model = model || DEFAULT_GITHUB_MODEL;
        body.model = model;
        headers = {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${githubSession.accessToken}`,
          'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
          'Content-Type': 'application/json'
        };
      } else if (provider === 'nexql-free') {
        if (!nexqlFreeToken) {
          throw new Error('Sign in to NexQL to use the free AI model.');
        }
        endpoint = NEXQL_AI_CHAT_ENDPOINT;
        model = model || DEFAULT_NEXQL_FREE_MODEL;
        body.model = model;
        headers = {
          'Authorization': `Bearer ${nexqlFreeToken}`,
          'Content-Type': 'application/json'
        };
      }

      if (tools && tools.length > 0) {
        body.tools = mapToOpenAiTools(tools);
      }
    } else if (provider === 'anthropic') {
      endpoint = 'https://api.anthropic.com/v1/messages';
      model = model || DEFAULT_ANTHROPIC_MODEL;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      delete headers['Authorization'];

      const anthropicMessages: any[] = [];
      for (const msg of budgetedHistory) {
        if (msg.role === 'tool') {
          const lastMsg = anthropicMessages[anthropicMessages.length - 1];
          if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.some((c: any) => c.type === 'tool_result')) {
            lastMsg.content.push({
              type: 'tool_result',
              tool_use_id: msg.toolCallId,
              content: msg.content
            });
          } else {
            anthropicMessages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: msg.toolCallId,
                  content: msg.content
                }
              ]
            });
          }
        } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
          const contentParts: any[] = [];
          if (msg.content) {
            contentParts.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            contentParts.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
            });
          }
          anthropicMessages.push({
            role: 'assistant',
            content: contentParts
          });
        } else {
          anthropicMessages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: this._buildAnthropicContent(msg)
          });
        }
      }
      if (userMessage && userMessage.trim()) {
        const lastMsg = this._messages[this._messages.length - 1];
        const currentAnthropicContent = lastMsg?.attachments?.some(a => a.type === 'image')
          ? this._buildAnthropicContent(lastMsg, userMessage)
          : userMessage;
        anthropicMessages.push({ role: 'user', content: currentAnthropicContent });
      }

      body = {
        model: model,
        system: systemPrompt,
        messages: anthropicMessages,
        max_tokens: 4096
      };

      if (tools && tools.length > 0) {
        body.tools = mapToAnthropicTools(tools);
      }
    } else if (provider === 'gemini') {
      model = model || DEFAULT_GEMINI_MODEL;
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      headers['X-goog-api-key'] = apiKey;
      delete headers['Authorization'];

      const geminiContents: any[] = [];
      for (const msg of budgetedHistory) {
        if (msg.role === 'tool') {
          let parsedResponse: any;
          try {
            parsedResponse = JSON.parse(msg.content);
          } catch {
            parsedResponse = { result: msg.content };
          }
          if (typeof parsedResponse !== 'object' || parsedResponse === null || Array.isArray(parsedResponse)) {
            parsedResponse = { result: parsedResponse };
          }

          geminiContents.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: msg.name,
                  response: parsedResponse
                }
              }
            ]
          });
        } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
          const parts: any[] = [];
          if (msg.content) {
            parts.push({ text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
              }
            });
          }
          geminiContents.push({
            role: 'model',
            parts
          });
        } else {
          geminiContents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: this._buildGeminiParts(msg)
          });
        }
      }
      if (userMessage && userMessage.trim()) {
        const lastMsg = this._messages[this._messages.length - 1];
        const currentGeminiParts = lastMsg?.attachments?.some(a => a.type === 'image')
          ? this._buildGeminiParts(lastMsg, userMessage)
          : [{ text: userMessage }];
        geminiContents.push({ role: 'user', parts: currentGeminiParts });
      }

      body = {
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: geminiContents
      };

      if (tools && tools.length > 0) {
        body.tools = [{ functionDeclarations: mapToGeminiTools(tools) }];
      }
    }

    if (onChunk && provider !== 'gemini') {
      body.stream = true;
    }

    try {
      const response = await this._makeHttpRequestWithRetry(endpoint, headers, body, provider, onChunk);
      telemetry.trackEvent('ai_request', { provider, success: true });
      if (provider === 'nexql-free') {
        // Monthly count just changed server-side — force the usage displays to refetch.
        invalidateAiUsageCache();
      }
      return response;
    } catch (error) {
      // A stale NexQL session token is the one case worth a single silent re-auth retry.
      if (
        provider === 'nexql-free' &&
        error instanceof AiProviderHttpError &&
        error.httpStatus === 401
      ) {
        try {
          const refreshedToken = await AccountService.getInstance(extensionContext).ensureAiSession({
            invalidateAccess: true,
          });
          headers['Authorization'] = `Bearer ${refreshedToken}`;
          const response = await this._makeHttpRequestWithRetry(endpoint, headers, body, provider, onChunk);
          telemetry.trackEvent('ai_request', { provider, success: true });
          invalidateAiUsageCache();
          return response;
        } catch (retryError) {
          telemetry.trackEvent('ai_request', { provider, success: false });
          throw retryError;
        }
      }
      telemetry.trackEvent('ai_request', { provider, success: false });
      throw error;
    }
  }

  private async _makeHttpRequestWithRetry(
    endpoint: string,
    headers: any,
    body: any,
    provider: string,
    onChunk?: (chunk: { text?: string; toolCalls?: ToolCall[] }) => void
  ): Promise<{ text: string; usage?: string }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < HTTP_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this._makeHttpRequest(endpoint, headers, body, provider, onChunk);
      } catch (err) {
        lastErr = err;
        if (
          attempt === HTTP_RETRY_MAX_ATTEMPTS - 1 ||
          !this._isTransientProviderHttpError(err) ||
          this._shouldSkipRetryForLocalConnectionRefused(endpoint, err)
        ) {
          throw err;
        }
        const delay = Math.min(
          HTTP_RETRY_BASE_MS * 2 ** attempt,
          HTTP_RETRY_CAP_MS,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  /**
   * Ollama/LM Studio on localhost: ECONNREFUSED means the daemon is not running.
   * Retrying does not help and only adds latency.
   */
  private _shouldSkipRetryForLocalConnectionRefused(
    endpoint: string,
    err: unknown,
  ): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/ECONNREFUSED/i.test(msg)) {
      return false;
    }
    try {
      const host = new URL(endpoint).hostname.toLowerCase();
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '[::1]'
      );
    } catch {
      return false;
    }
  }

  private _isTransientProviderHttpError(err: unknown): boolean {
    if (err instanceof AiProviderHttpError && err.httpStatus !== undefined) {
      const s = err.httpStatus;
      if (s === 429) {
        return true;
      }
      if (s >= 500 && s < 600) {
        return true;
      }
      return false;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/status (429|502|503|504)\b/.test(msg)) {
      return true;
    }
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|ENOTFOUND/i.test(
      msg,
    );
  }

  private async _getDirectApiKey(
    config: vscode.WorkspaceConfiguration,
    provider: string,
  ): Promise<string> {
    try {
      if (
        provider === 'openai' ||
        provider === 'anthropic' ||
        provider === 'gemini' ||
        provider === 'custom'
      ) {
        const scopedKey = await AiCredentialsService.getInstance().getApiKey(
          provider as DirectApiKeyProvider,
        );
        if (scopedKey) {
          return scopedKey;
        }
      }
      const secretApiKey = await SecretStorageService.getInstance().getAiApiKey();
      return secretApiKey || config.get<string>('aiApiKey') || '';
    } catch {
      return config.get<string>('aiApiKey') || '';
    }
  }

  /** Resolves (and lazily mints, via device-lite sign-in) the NexQL bearer used by the free AI proxy. */
  private async _getNexqlFreeToken(): Promise<string | undefined> {
    try {
      return await AccountService.getInstance(extensionContext).ensureAiSession();
    } catch (err) {
      debugWarn('[AiService] NexQL free sign-in failed:', err);
      return undefined;
    }
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

  private _makeHttpRequest(
    endpoint: string,
    headers: any,
    body: any,
    provider: string,
    onChunk?: (chunk: { text?: string; toolCalls?: ToolCall[] }) => void
  ): Promise<{ text: string, usage?: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const requestData = JSON.stringify(body);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(requestData)
        }
      };

      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request(options, (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode !== 200) {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            let detail = `API request failed with status ${statusCode}`;
            let errorCode: string | undefined;
            let errorData: Record<string, unknown> | undefined;
            try {
              const errBody = JSON.parse(data) as { error?: { message?: string } | string } & Record<string, unknown>;
              errorData = errBody;
              if (errBody.error && typeof errBody.error === 'object' && errBody.error.message) {
                detail = String(errBody.error.message);
              } else if (typeof errBody.error === 'string') {
                errorCode = errBody.error;
                detail = errBody.error;
              }
            } catch {
              const snippet = data.replace(/\s+/g, ' ').trim().slice(0, 200);
              if (snippet) {
                detail = `${detail} — ${snippet}`;
              }
            }
            reject(new AiProviderHttpError(detail, statusCode, errorCode, errorData));
          });
          return;
        }

        let data = '';
        let buffer = '';
        res.on('data', (chunk: Buffer | string) => {
          const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (onChunk) {
            buffer += chunkStr;
            let lineEnd = buffer.indexOf('\n');
            while (lineEnd !== -1) {
              const line = buffer.slice(0, lineEnd).trim();
              buffer = buffer.slice(lineEnd + 1);
              lineEnd = buffer.indexOf('\n');

              if (line.startsWith('data:')) {
                const dataVal = line.slice(5).trim();
                if (dataVal === '[DONE]') {
                  continue;
                }
                try {
                  const parsed = JSON.parse(dataVal);
                  let text = '';
                  if (provider === 'anthropic') {
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                      text = parsed.delta.text;
                    }
                  } else {
                    // OpenAI-compatible
                    text = parsed.choices?.[0]?.delta?.content || '';
                  }
                  if (text) {
                    data += text;
                    onChunk({ text });
                  }
                } catch (e) {
                  // ignore JSON parse errors for partial or meta lines
                }
              }
            }
          } else {
            data += chunkStr;
          }
        });

        res.on('end', () => {
          let content = '';
          let usage = '';

          if (onChunk) {
            content = data;
            usage = AiService._roughTokenEstimateLabel(
              AiService.estimateTokens(JSON.stringify(body.messages || '')),
              content.length
            );
          } else {
            let response: Record<string, unknown>;
            try {
              // Some proxies (e.g. nexql-free on an older deploy) stream SSE even
              // when a non-streaming request was made — fall back to concatenating
              // the delta text instead of choking on "data: {...}" as raw JSON.
              const trimmed = data.trimStart();
              if (trimmed.startsWith('data:')) {
                let text = '';
                for (const rawLine of data.split('\n')) {
                  const line = rawLine.trim();
                  if (!line.startsWith('data:')) {
                    continue;
                  }
                  const dataVal = line.slice(5).trim();
                  if (dataVal === '[DONE]' || !dataVal) {
                    continue;
                  }
                  try {
                    const parsed = JSON.parse(dataVal);
                    text += parsed.choices?.[0]?.delta?.content || '';
                  } catch {
                    // ignore partial/meta lines
                  }
                }
                response = { choices: [{ message: { content: text } }] };
              } else {
                response = JSON.parse(data) as Record<string, unknown>;
              }
            } catch (e) {
              reject(
                new AiProviderHttpError(
                  `Failed to parse API response: ${e instanceof Error ? e.message : String(e)}`,
                  statusCode,
                ),
              );
              return;
            }

            if (provider === 'anthropic') {
              const contentArr = response.content as Array<{ text?: string }> | undefined;
              content = contentArr?.[0]?.text || '';
              const usageObj = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
              if (usageObj) {
                usage = `${usageObj.input_tokens} input, ${usageObj.output_tokens} output`;
              }
            } else if (provider === 'gemini') {
              const candidates = response.candidates as Array<{
                content?: { parts?: Array<{ text?: string }> };
              }> | undefined;
              content = candidates?.[0]?.content?.parts?.[0]?.text || '';
              const usageObj = response.usageMetadata as { totalTokenCount?: number } | undefined;
              if (usageObj) {
                usage = `${usageObj.totalTokenCount} tokens`;
              }
            } else {
              const choices = response.choices as Array<{ message?: { content?: string } }> | undefined;
              content = choices?.[0]?.message?.content || '';
              const usageObj = response.usage as {
                total_tokens?: number;
                prompt_tokens?: number;
                completion_tokens?: number;
              } | undefined;
              if (usageObj) {
                usage = `${usageObj.total_tokens} tokens (P:${usageObj.prompt_tokens}, C:${usageObj.completion_tokens})`;
              }
            }

            if (!content && provider === 'custom') {
              content = JSON.stringify(response);
            }
          }

          if (usage && body?.model) {
            usage = `${body.model} · ${usage}`;
          }

          resolve({ text: content, usage });
        });
      });

      req.on('error', reject);
      req.write(requestData);
      req.end();
    });
  }

  async generateTitle(firstMessage: string, provider: string): Promise<string> {
    try {
      if (provider === 'vscode-lm') {
        const models = await vscode.lm.selectChatModels({});
        if (models.length > 0) {
          const prompt = `Generate a very short title (max 5 words) for a chat about: "${firstMessage.substring(0, 100)}". Return only the title, nothing else.`;
          const messages = [vscode.LanguageModelChatMessage.User(prompt)];
          const response = await models[0].sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
          let title = '';
          for await (const fragment of response.text) {
            title += fragment;
          }
          return title.trim().substring(0, 50);
        }
      }

      // Fallback to simple extraction
      const title = firstMessage.substring(0, 40).replace(/\n/g, ' ').trim();
      return title.length === 40 ? title + '...' : title;
    } catch {
      const simple = firstMessage.substring(0, 40).replace(/\n/g, ' ').trim();
      return simple.length === 40 ? simple + '...' : simple;
    }
  }

  async getModelInfo(
    provider: string,
    config: vscode.WorkspaceConfiguration,
    scope: AiConfigScope = 'notebook',
  ): Promise<string> {
    try {
      const configuredModel = this._resolveConfiguredModel(config, scope);

      if (provider === 'vscode-lm') {
        if (configuredModel) {
          const resolved = await resolveVsCodeLanguageModel(configuredModel);
          if (resolved) {
            return resolved.name || resolved.id;
          }
          return configuredModel;
        }
        const models = await this._selectChatModelsWithTimeout({ family: 'gpt-4o' });
        if (models.length > 0) {
          return models[0].name || models[0].id;
        }
        const anyModels = await this._selectChatModelsWithTimeout({});
        return anyModels.length > 0 ? (anyModels[0].name || anyModels[0].id) : 'VS Code LM (No Models)';
      } else if (provider === 'cursor') {
        const apiKey = await this._getCursorApiKey(config);
        if (configuredModel) {
          try {
            const models = await this._listCursorModels(apiKey);
            const matchingModel = models.find((model) => model.id === configuredModel || model.displayName === configuredModel);
            if (matchingModel) {
              return matchingModel.displayName || matchingModel.id;
            }
          } catch {
            return configuredModel;
          }
          return configuredModel;
        }

        try {
          const models = await this._listCursorModels(apiKey);
          return models[0]?.displayName || models[0]?.id || 'Cursor (No Models)';
        } catch {
          return 'Cursor';
        }
      } else if (provider === 'opencode') {
        if (configuredModel && configuredModel !== 'auto') {
          return configuredModel;
        }
        try {
          const models = await listOpencodeModels(config);
          return models[0] || 'OpenCode (No Models)';
        } catch {
          return 'OpenCode';
        }
      } else {
        return configuredModel || this._getDefaultModel(provider);
      }
    } catch {
      return 'Unknown';
    }
  }

  private _getDefaultModel(provider: string): string {
    switch (provider) {
      case 'nexql-free': return DEFAULT_NEXQL_FREE_MODEL;
      case 'github': return DEFAULT_GITHUB_MODEL;
      case 'cursor': return DEFAULT_CURSOR_MODEL;
      case 'opencode': return DEFAULT_OPENCODE_MODEL;
      case 'openai': return DEFAULT_OPENAI_MODEL;
      case 'anthropic': return DEFAULT_ANTHROPIC_MODEL;
      case 'gemini': return DEFAULT_GEMINI_MODEL;
      case 'custom': return 'custom-model';
      case 'ollama': return 'ollama';
      case 'lmstudio': return 'lm-studio';
      default: return 'Unknown';
    }
  }

  private async _selectChatModelsWithTimeout(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat[]> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        debugWarn('[AiService] vscode.lm.selectChatModels timed out after 2000ms');
        resolve([]);
      }, 2000);

      vscode.lm.selectChatModels(selector).then((models) => {
        clearTimeout(timeout);
        resolve(models);
      }, (error) => {
        clearTimeout(timeout);
        console.error('[AiService] vscode.lm.selectChatModels failed:', error);
        resolve([]);
      });
    });
  }
}
