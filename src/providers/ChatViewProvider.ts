/**
 * Chat View Provider - Main controller for the SQL Chat Assistant
 * 
 * This is the refactored version that uses modular services:
 * - DbObjectService: Handles database object fetching for @ mentions
 * - AiService: Handles AI provider integration
 * - SessionService: Handles chat session storage
 * - webviewHtml: Provides the webview HTML template
 */
import * as vscode from 'vscode';
import { debugLog } from '../common/logger';
import { TelemetryService } from '../services/TelemetryService';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ChatMessage,
  FileAttachment,
  DbMention,
  DbObject,
  DbObjectService,
  DbSearchScope,
  AiService,
  AiProviderHttpError,
  SessionService,
  getWebviewHtml,
  AiCapability,
  ToolCall,
  ThinkingStep,
} from './chat';
import type { ConnectionConfig, NoticeLogEntry } from '../common/types';
import { buildBackupToolsSystemPrompt, buildBackupToolsUserMessage } from './chat/backupToolsAssistantPrompt';
import { ErrorService } from '../services/ErrorService';
import { ChatSurfaceRegistry } from './chat/ChatSurfaceRegistry';
import { AssistantGateway, ChatProviderBridge, AttachInvocationPayload } from '../services/assistant/AssistantGateway';
import type { ContextItem, AssistantIntent } from '../services/assistant/contextItems';
import {
  parseSelectionId,
  readAiScopeSettings,
  rememberLastModelForProvider,
  writeAiScopeSettings,
} from '../features/aiAssistant/aiConfig';
import { AiModelCatalogService } from '../features/aiAssistant/AiModelCatalogService';
import { isProFeatureEnabled, getUpgradeHtml, ProFeature, requirePro } from '../services/featureGates';
import type { SentinelContext } from '../features/sentinel/types';

/** P1.4 — max rows sampled into the AI prompt for "Analyze Data" on large result sets. */
const AI_ANALYZE_MAX_SAMPLE_ROWS = 200;

/** Params for {@link ChatViewProvider.openBackupToolsAssistant} (Backup & Restore panel). */
export interface OpenBackupToolsAssistantParams {
  scenario: 'version_banner' | 'tool_log';
  connectionId: string;
  databaseLabel: string;
  databaseName: string;
  connection?: ConnectionConfig;
  toolLog?: string;
  serverMajor: number;
  pgDumpMajor: number;
  pgRestoreMajor: number;
}

function inferBackupToolFromLog(log: string): string | undefined {
  if (/pg_restore:/m.test(log)) {
    return 'pg_restore';
  }
  if (/pg_dumpall:/m.test(log)) {
    return 'pg_dumpall';
  }
  if (/pg_dump:/m.test(log)) {
    return 'pg_dump';
  }
  return undefined;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, ChatProviderBridge {
  public static readonly viewType = 'postgresExplorer.chatView';
  public static readonly panelViewType = 'postgresExplorer.chatViewPanel';

  private _view?: vscode.WebviewView;
  private _panels = new Set<vscode.WebviewPanel>();
  private _activeWebview?: vscode.Webview;
  private _surfaces = new ChatSurfaceRegistry();
  private _messages: ChatMessage[] = [];
  private _isProcessing = false;
  private _cancellationTokenSource: vscode.CancellationTokenSource | null = null;
  /** Accumulates pre-response steps for the in-flight turn; flushed onto the assistant message at end. */
  private _liveThinkingTrace: ThinkingStep[] = [];

  // Phase C: Track current connection/database context for session metadata
  private _currentConnectionId: string | undefined;
  private _currentConnectionName: string | undefined;
  private _currentDatabase: string | undefined;

  // B1: Track production/read-only environment for AI safety guardrails
  private _currentEnvironment: 'production' | 'staging' | 'development' | undefined;
  private _currentReadOnlyMode: boolean = false;

  /** When `backup_tools`, AI uses backup/restore specialist system prompt until new/clear chat or session load. */
  private _chatSystemPromptMode: 'default' | 'backup_tools' = 'default';

  // Services
  private _dbObjectService: DbObjectService;
  private _aiService: AiService;
  private _sessionService: SessionService;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _extensionContext: vscode.ExtensionContext,
  ) {
    this._dbObjectService = new DbObjectService();
    this._aiService = new AiService();
    this._sessionService = new SessionService(_extensionContext);
    AssistantGateway.getInstance().registerChatProvider(this);
  }

  // ==================== ChatProviderBridge (AssistantGateway) ====================

  async resolveOrRevealSurface(): Promise<vscode.Webview | undefined> {
    return this._surfaces.resolveOrReveal('postgresExplorer.chatView.focus');
  }

  async resolveDbObjectSchema(obj: DbObject): Promise<string> {
    return this._dbObjectService.getObjectSchema(obj);
  }

  setInvocationConnectionContext(connectionId?: string, database?: string): void {
    if (connectionId && database) {
      this.setConnectionContext(connectionId, database);
    }
  }

  postAttachInvocation(webview: vscode.Webview, payload: AttachInvocationPayload): void {
    webview.postMessage({ type: 'attachInvocation', ...payload });
  }

  hasVisibleChatSurface(): boolean {
    return this._surfaces.hasVisibleSurface();
  }

  broadcastToChatSurfaces(message: unknown): void {
    this._surfaces.broadcast(message);
  }

  /**
   * Public method to refresh the AI model info display
   * Called when AI settings are changed
   */
  public refreshModelInfo(): void {
    void this._pushModelCatalogToWebview();
  }

  /** Sync SQL Assistant header context from Sentinel (active or last tagged notebook). */
  public syncSentinelContext(context: SentinelContext | null): void {
    if (!context) {
      this._sendContextUpdate();
      return;
    }

    this._currentConnectionId = context.connectionId;
    this._currentConnectionName = context.connectionName;
    this._currentDatabase = context.database;
    this._currentEnvironment = context.environment;
    this._currentReadOnlyMode = context.readOnlyMode;
    this._aiService.setConnectionContext({
      environment: this._currentEnvironment,
      readOnlyMode: this._currentReadOnlyMode,
      connectionName: this._currentConnectionName,
      databaseName: this._currentDatabase,
      useAgentic: false,
    });
    this._sendContextUpdate();
  }

  /** Force set database/connection context (called from tools executor or other context switchers). */
  public setConnectionContext(connectionId: string, databaseName: string): void {
    this._currentConnectionId = connectionId;
    this._currentDatabase = databaseName;
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === connectionId);
    if (conn) {
      this._currentEnvironment = conn.environment;
      this._currentReadOnlyMode = conn.readOnlyMode === true;
      this._currentConnectionName = conn.name || conn.host || 'Unknown';
    }
    this._aiService.setConnectionContext({
      environment: this._currentEnvironment,
      readOnlyMode: this._currentReadOnlyMode,
      connectionName: this._currentConnectionName || this._currentConnectionId || '',
      databaseName: this._currentDatabase,
      useAgentic: false,
    });
    this._sendContextUpdate();
  }

  public async openInEditor(column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.panelViewType,
      'SQL Assistant',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      }
    );

    this._panels.add(panel);
    this._activeWebview = panel.webview;
    this._surfaces.register(panel.webview, 'panel');

    panel.onDidChangeViewState((e) => {
      this._surfaces.setVisible(panel.webview, e.webviewPanel.visible);
      if (e.webviewPanel.visible) {
        this._activeWebview = panel.webview;
      }
    });

    panel.onDidDispose(() => {
      this._panels.delete(panel);
      this._surfaces.unregister(panel.webview);
      if (this._activeWebview === panel.webview) {
        this._activeWebview = this._view?.webview;
      }
    });

    await this._initializeWebview(panel.webview);
    this._registerWebviewMessageHandler(panel.webview);
    this._surfaces.markReady(panel.webview);

    this._sendHistoryToWebview();
    this._updateChatHistory();
    this._sendContextUpdate();
    await this._pushModelCatalogToWebview();
  }

  private _getTargetWebview(): vscode.Webview | undefined {
    return this._activeWebview ?? this._view?.webview;
  }

  private async _ensureChatWebview(): Promise<vscode.Webview | undefined> {
    const target = this._getTargetWebview();
    if (target) {
      return target;
    }

    await this.openInEditor(vscode.ViewColumn.Beside);
    return this._getTargetWebview();
  }

  private async _initializeWebview(webview: vscode.Webview): Promise<void> {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'marked.min.js'));
    const highlightJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'highlight.min.js'));
    const highlightCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'highlight.css'));

    webview.html = await getWebviewHtml(webview, markedUri, highlightJsUri, highlightCssUri, this._extensionUri);
  }

  private _registerWebviewMessageHandler(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (data) => {
      this._activeWebview = webview;
      switch (data.type) {
        case 'sendMessage':
          await this._handleUserMessage(data.message, data.attachments, data.mentions);
          break;
        case 'regenerateAssistant':
          await this._regenerateAssistantReply();
          break;
        case 'resendUserMessage': {
          const idx =
            typeof data.userIndex === 'number' && Number.isInteger(data.userIndex)
              ? data.userIndex
              : -1;
          await this._resendUserMessageAtIndex(idx);
          break;
        }
        case 'clearChat':
          this._messages = [];
          this._sessionService.clearCurrentSession();
          this._chatSystemPromptMode = 'default';
          this._updateChatHistory();
          break;
        case 'newChat':
          await this._saveCurrentSession();
          this._messages = [];
          this._sessionService.clearCurrentSession();
          this._chatSystemPromptMode = 'default';
          this._updateChatHistory();
          this._sendHistoryToWebview();
          break;
        case 'pickFile':
          await this._handleFilePick();
          break;
        case 'loadSession':
          await this._loadSession(data.sessionId);
          break;
        case 'deleteSession':
          debugLog('[ChatView] Received deleteSession request for:', data.sessionId);
          await this._deleteSession(data.sessionId);
          break;
        case 'explainError':
          await this.handleExplainError(data.error, data.query);
          break;
        case 'fixQuery':
          await this.handleFixQuery(data.error, data.query);
          break;
        case 'analyzeData':
          await this.handleAnalyzeData(data.data, data.query, data.rowCount);
          break;
        case 'optimizeQuery':
          await this.handleOptimizeQuery(data.query, data.executionTime);
          break;
        case 'cancelRequest':
          if (this._cancellationTokenSource) {
            this._cancellationTokenSource.cancel();
            this._cancellationTokenSource.dispose();
            this._cancellationTokenSource = null;
          }
          this._aiService.cancel();
          this._setTypingIndicator(false);
          this._isProcessing = false;
          vscode.window.showInformationMessage('AI request cancelled.');
          break;
        case 'getHistory':
          this._sendHistoryToWebview();
          break;
        case 'searchDbObjects':
          await this._handleSearchDbObjects(data.query, data.scope);
          break;
        case 'getDbObjectDetails':
          await this._handleGetDbObjectDetails(data.object);
          break;
        case 'getDbObjects':
          await this._handleGetAllDbObjects();
          break;
        case 'getDbHierarchy':
          await this._handleGetDbHierarchy(data.path);
          break;
        case 'openAiSettings':
          vscode.commands.executeCommand('postgres-explorer.aiSettings');
          break;
        case 'requestAddConnection':
          await vscode.commands.executeCommand('postgres-explorer.addConnection');
          break;
        case 'openIndexPanel':
          await vscode.commands.executeCommand('postgres-explorer.dbindex.openPanel');
          break;
        case 'openConnectionSafety':
          await vscode.commands.executeCommand('postgres-explorer.showConnectionSafety');
          break;
        case 'getModelCatalog':
          await this._pushModelCatalogToWebview();
          break;
        case 'getConnections':
          await this._handleGetConnections();
          break;
        case 'getDatabases':
          await this._handleGetDatabases(data.connectionId);
          break;
        case 'changeContext':
          this.setConnectionContext(data.connectionId, data.database);
          break;
        case 'switchChatModel':
          await this._handleSwitchChatModel(data.selectionId);
          break;
        case 'openInNotebook':
          try {
            TelemetryService.getInstance().trackAiChatFeedback('open_in_notebook');
          } catch {}
          await this._handleOpenInNotebook(data.code);
          break;
        case 'copyCode':
          try {
            TelemetryService.getInstance().trackAiChatFeedback('copy_code');
          } catch {}
          break;
        case 'previewFile':
          await this._handlePreviewFile(data.path, data.name);
          break;
      }
    });
  }

  /**
   * Attach a database object to the chat
   * Called from the @ inline button on tree items
   */
  public async attachDbObject(obj: DbObject): Promise<void> {
    const targetWebview = await this._ensureChatWebview();

    // Wait a bit for the view to be ready
    await new Promise(resolve => setTimeout(resolve, 200));

    if (!targetWebview) {
      vscode.window.showWarningMessage('Chat view not available');
      return;
    }

    try {
      // Fetch schema details
      const details = await this._dbObjectService.getObjectSchema(obj);
      const objWithDetails = { ...obj, details };

      // Send to webview
      targetWebview.postMessage({
        type: 'addMentionFromTree',
        object: objWithDetails
      });

    } catch (error) {
      console.error('[ChatViewProvider] Failed to attach object:', error);
      ErrorService.getInstance().showError('Failed to attach object to chat');
    }
  }

  /**
   * Send a query and results to the chat as attachments
   * Called from the "Chat" CodeLens button or "Send to Chat" result button
   * Does NOT auto-send - waits for user to add their context
   */
  /**
   * Send query/results/notices/EXPLAIN context to the SQL Assistant as a prefilled,
   * editable draft (never auto-sends). Routes through AssistantGateway so context
   * items get the same framing (row cap, per-intent draft text) as every other
   * entry point — see promptFraming.ts.
   */
  public async sendToChat(data: {
    query: string;
    results?: string;
    /** JSON `{columns, rows}` — EXPLAIN recommendations table (explainTab "Ask AI"). */
    explainRecommendations?: string;
    message?: string;
    intent?: AssistantIntent;
    totalRowCount?: number;
    /** PostgreSQL RAISE NOTICE / server messages — attached as a .txt file */
    notices?: Array<string | NoticeLogEntry>;
  }): Promise<void> {
    const items: ContextItem[] = [];

    if (data.query?.trim()) {
      items.push({ kind: 'query', sql: data.query });
    }

    if (data.results) {
      try {
        const parsed = JSON.parse(data.results);
        const rows: Array<Record<string, unknown>> = parsed.rows || [];
        const totalRowCount = data.totalRowCount ?? rows.length;
        items.push({
          kind: 'resultSample',
          sql: data.query || '',
          columns: parsed.columns || [],
          rows,
          totalRowCount,
          truncated: totalRowCount > rows.length,
        });
      } catch (e) {
        debugLog('[ChatViewProvider] sendToChat: failed to parse results JSON', e);
      }
    }

    if (data.explainRecommendations) {
      items.push({
        kind: 'file',
        attachment: { name: 'EXPLAIN recommendations', content: data.explainRecommendations, type: 'json' },
      });
    }

    if (data.notices && data.notices.length > 0) {
      items.push({
        kind: 'notices',
        sql: data.query,
        notices: data.notices.map((n) =>
          typeof n === 'string'
            ? { severity: 'notice', message: n }
            : { severity: 'notice', message: n.message ?? '', detail: n.receivedAt }
        ),
      });
    }

    try {
      await AssistantGateway.getInstance().invoke({
        intent: data.intent ?? 'ask',
        items,
        draftText: data.message,
        send: 'draft',
      });
    } catch (error) {
      console.error('[ChatViewProvider] sendToChat failed:', error);
      ErrorService.getInstance().showError('Failed to attach context to chat');
    }
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;
    this._activeWebview = webviewView.webview;
    this._surfaces.register(webviewView.webview, 'sidebar');
    webviewView.onDidChangeVisibility(() => {
      this._surfaces.setVisible(webviewView.webview, webviewView.visible);
      if (webviewView.visible) {
        this._activeWebview = webviewView.webview;
      }
    });
    webviewView.onDidDispose(() => {
      this._surfaces.unregister(webviewView.webview);
    });

    if (!isProFeatureEnabled(ProFeature.AiAssistant)) {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getUpgradeHtml(ProFeature.AiAssistant);
      return;
    }

    await this._initializeWebview(webviewView.webview);
    this._registerWebviewMessageHandler(webviewView.webview);
    this._surfaces.markReady(webviewView.webview);

    // Send initial history and model info
    setTimeout(() => {
      this._sendHistoryToWebview();
      this._updateChatHistory();
      this._sendContextUpdate();
      void this._pushModelCatalogToWebview();
    }, 100);
  }

  // ==================== Message Handling ====================

  /** Plain prompt text without attachment display suffixes (matches webview copy behavior). */
  private _plainPromptFromUserMessage(user: ChatMessage): string {
    if (user.role !== 'user') {
      return '';
    }
    let c = user.content || '';
    const idxFile = c.indexOf('\n\n📎');
    const idxImg = c.indexOf('\n\n🖼️');
    const candidates = [idxFile, idxImg].filter(i => i >= 0);
    if (candidates.length > 0) {
      c = c.slice(0, Math.min(...candidates)).trim();
    } else {
      c = c.trim();
    }
    return c;
  }

  private _buildUserDisplayMessage(message: string, attachments?: FileAttachment[]): string {
    let fullMessage = message;
    if (attachments && attachments.length > 0) {
      const attachmentLinks = attachments.map(att => {
        if (att.type === 'image') {
          return `\n\n🖼️ **Image:** ${att.name}`;
        }
        if (att.path) {
          return `\n\n📎 [${att.name}](${vscode.Uri.file(att.path).toString()})`;
        }
        return `\n\n📎 **Attached:** ${att.name}`;
      }).join('');
      fullMessage = message + attachmentLinks;
    }
    return fullMessage;
  }

  private _startThinking(): void {
    this._liveThinkingTrace = [];
    this._getTargetWebview()?.postMessage({ type: 'thinkingStart', steps: [] });
  }

  /** Compact `key: value, ...` preview of a tool call's arguments for the thinking step label. */
  private _summarizeToolArgs(args: unknown, maxLen = 60): string {
    if (!args || typeof args !== 'object') {
      return '';
    }
    const entries = Object.entries(args as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${String(v)}`
    );
    const joined = entries.join(', ');
    return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
  }

  /** Compact outcome summary (`N rows` / `error: ...` / truncated text) for a tool result. */
  private _summarizeToolResult(content: string, maxLen = 60): string {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return `${parsed.length} row${parsed.length === 1 ? '' : 's'}`;
      }
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
        return `error: ${parsed.error}`.slice(0, maxLen);
      }
    } catch {
      // not JSON — fall through to plain-text preview
    }
    const flat = content.replace(/\s+/g, ' ').trim();
    return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
  }

  private _pushThinkingStep(step: ThinkingStep): void {
    const idx = this._liveThinkingTrace.findIndex((s) => s.id === step.id);
    if (idx >= 0) {
      this._liveThinkingTrace[idx] = step;
    } else {
      this._liveThinkingTrace.push(step);
    }
    this._getTargetWebview()?.postMessage({
      type: 'thinkingUpdate',
      steps: [...this._liveThinkingTrace],
    });
  }

  private _endThinking(): void {
    this._getTargetWebview()?.postMessage({
      type: 'thinkingEnd',
      steps: [...this._liveThinkingTrace],
    });
  }

  private _attachThinkingTraceToLastAssistant(): void {
    if (this._liveThinkingTrace.length === 0) {
      return;
    }
    for (let i = this._messages.length - 1; i >= 0; i--) {
      if (this._messages[i].role === 'assistant') {
        this._messages[i].thinkingTrace = [...this._liveThinkingTrace];
        break;
      }
    }
    this._liveThinkingTrace = [];
  }

  /**
   * Resolve a usable connection context before composing the AI payload: last-used
   * defaults from workspace state, else the first configured connection. Extracted from
   * `_composeUserTurnPayload` so callers can decide agentic mode BEFORE composing
   * (agentic runs skip RAG — the agent discovers schema through its tools).
   */
  private async _ensureConnectionContext(): Promise<void> {
    if (!this._currentConnectionId || !this._currentDatabase) {
      try {
        const { WorkspaceStateService } = await import('../services/WorkspaceStateService');
        const defaults = WorkspaceStateService.getInstance().getDefaults();
        let connId = defaults.lastConnectionId;
        let dbName = defaults.lastDatabaseName;

        const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
        if ((!connId || !dbName) && connections.length > 0) {
          const firstConn = connections[0];
          connId = firstConn.id;
          dbName = firstConn.database || 'postgres';
          console.log(`[ChatView] Fallback connection context loaded from first configured connection: connectionId="${connId}", database="${dbName}"`);
        }

        if (connId && dbName) {
          this._currentConnectionId = connId;
          this._currentDatabase = dbName;
          
          const conn = connections.find(c => c.id === this._currentConnectionId);
          if (conn) {
            this._currentEnvironment = conn.environment;
            this._currentReadOnlyMode = conn.readOnlyMode === true;
            this._currentConnectionName = conn.name || conn.host || 'Unknown';
          }
          this._aiService.setConnectionContext({
            environment: this._currentEnvironment,
            readOnlyMode: this._currentReadOnlyMode,
            connectionName: this._currentConnectionName || this._currentConnectionId || '',
            databaseName: this._currentDatabase,
            useAgentic: false,
          });
          this._sendContextUpdate();
        }
      } catch (e) {
        console.error('[ChatView] Fallback resolution failed:', e);
      }
    }
  }

  /**
   * Agentic tool loop is available when a connection context exists (Pro-gated).
   * Call at most once per user turn — `requirePro` meters usage.
   */
  private async _resolveUseAgentic(): Promise<boolean> {
    if (this._currentConnectionId && this._currentDatabase && this._chatSystemPromptMode !== 'backup_tools') {
      return await requirePro(ProFeature.AgenticModes);
    }
    return false;
  }

  private async _composeUserTurnPayload(
    message: string,
    attachments?: FileAttachment[],
    mentions?: DbMention[],
    options?: { onThinkingStep?: (step: ThinkingStep) => void; skipRag?: boolean }
  ): Promise<{
    fullMessage: string;
    aiMessage: string;
    ragContext?: {
      objects: Array<{ ref: string; score: number; detail: 'full' | 'columns' | 'skeleton' }>;
      joinHints: string[];
      tokensUsed: number;
    };
  }> {
    console.log(`[ChatView] _composeUserTurnPayload: Received user message. Current context: connectionId="${this._currentConnectionId}", database="${this._currentDatabase}"`);

    let fullMessage = message;
    if (attachments && attachments.length > 0) {
      const attachmentLinks = attachments.map(att => {
        if (att.type === 'image') {
          return `\n\n🖼️ **Image:** ${att.name}`;
        }
        if (att.path) {
          return `\n\n📎 [${att.name}](${vscode.Uri.file(att.path).toString()})`;
        } else {
          return `\n\n📎 **Attached:** ${att.name}`;
        }
      }).join('');
      fullMessage = message + attachmentLinks;
    }

    let aiMessage = message;
    if (attachments && attachments.length > 0) {
      const attachmentContent = attachments.map(att => {
        if (att.type === 'image') {
          return `\n\n[Image attached: ${att.name}]`;
        }
        return `\n\nFile: ${att.name} (${att.type})\n\`\`\`${att.type}\n${att.content}\n\`\`\``;
      }).join('');
      aiMessage = message + attachmentContent;
    }

    if (mentions && mentions.length > 0) {
      debugLog('[ChatView] Processing mentions for schema context...');

      if (mentions[0]) {
        this._currentDatabase = mentions[0].database;
        this._currentConnectionName = mentions[0].breadcrumb?.split('.')[0] || mentions[0].connectionId;
        this._currentConnectionId = mentions[0].connectionId;

        if (mentions[0].connectionId) {
          const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
          const conn = connections.find(c => c.id === mentions[0].connectionId);
          if (conn) {
            this._currentEnvironment = conn.environment;
            this._currentReadOnlyMode = conn.readOnlyMode === true;
          }
        }

        this._aiService.setConnectionContext({
          environment: this._currentEnvironment,
          readOnlyMode: this._currentReadOnlyMode,
          connectionName: this._currentConnectionName,
          databaseName: this._currentDatabase,
          useAgentic: false,
        });

        this._sendContextUpdate();
      }

      // P1.2: single clean delimiter block. The schema-usage rule now lives once in the
      // system prompt, so we no longer re-state instructions around the schema here.
      let schemaContext = '\n\n--- SCHEMA CONTEXT ---\n';

      for (const mention of mentions) {
        debugLog('[ChatView] Fetching schema for:', mention.schema + '.' + mention.name, 'type:', mention.type, 'connectionId:', mention.connectionId);
        const obj: DbObject = {
          name: mention.name,
          type: mention.type,
          schema: mention.schema,
          database: mention.database,
          connectionId: mention.connectionId,
          connectionName: '',
          breadcrumb: mention.breadcrumb
        };

        // P1.2: rank schema columns/indexes against the live user message.
        const schemaInfo = await this._dbObjectService.getObjectSchema(obj, { userMessage: message });
        mention.schemaInfo = schemaInfo;
        schemaContext += `\n### ${mention.type.toUpperCase()}: ${mention.schema}.${mention.name}\n`;
        schemaContext += schemaInfo;
        schemaContext += '\n';

        // P1.5: getObjectSchema now returns a structured `<schema unavailable …>` marker on
        // failure instead of throwing, so surface that to the UI without a raw error string.
        if (schemaInfo.startsWith('<schema unavailable')) {
          this._getTargetWebview()?.postMessage({
            type: 'schemaError',
            object: `${mention.schema}.${mention.name}`,
            error: schemaInfo
          });
        }
      }

      schemaContext += '\n--- END SCHEMA CONTEXT ---\n\n';

      aiMessage = schemaContext + fullMessage;
      debugLog('[ChatView] AI message with schema context length:', aiMessage.length);
      debugLog('[ChatView] ========== FULL AI MESSAGE ==========');
      debugLog(aiMessage);
      debugLog('[ChatView] ========== END FULL AI MESSAGE ==========');
    } else if (!options?.skipRag && this._currentConnectionId && this._currentDatabase) {
      try {
        options?.onThinkingStep?.({
          id: 'rag',
          label: 'Retrieving schema context…',
          status: 'active',
        });
        console.log(`[ChatView] Attempting local index grounding for database="${this._currentDatabase}"...`);
        const { IndexStore } = await import('../features/dbindex/IndexStore');
        const { IndexQueryService } = await import('../features/dbindex/IndexQueryService');
        const store = new IndexStore(this._extensionContext.globalStorageUri);
        const queryService = new IndexQueryService(store);
        const config = vscode.workspace.getConfiguration();
        const result = await queryService.retrieve(
          this._currentConnectionId,
          this._currentDatabase,
          message,
          2500,
          config
        );
        let ragContext: any = undefined;
        if (result) {
          aiMessage = result.packMarkdown + '\n\n' + fullMessage;
          ragContext = {
            objects: result.objects,
            joinHints: result.joinHints,
            tokensUsed: result.tokensUsed
          };
          options?.onThinkingStep?.({
            id: 'rag',
            label: `Retrieved schema context (${result.objects.length} table${result.objects.length !== 1 ? 's' : ''})`,
            status: 'done',
            ragContext,
          });
          console.log(`[ChatView] Grounded user turn payload with local index context. Pack length: ${result.packMarkdown.length} characters.`);
          debugLog('[ChatView] Grounded user turn payload with local index context.');
        } else {
          console.log(`[ChatView] No matching local index found or retrieval returned null.`);
          options?.onThinkingStep?.({
            id: 'rag',
            label: 'No indexed schema matched — answering without it',
            status: 'done',
          });
        }
        return { fullMessage, aiMessage, ragContext };
      } catch (e) {
        console.error('[ChatView] Failed to retrieve local index context:', e);
        debugLog('[ChatView] Failed to retrieve local index context:', e);
        options?.onThinkingStep?.({
          id: 'rag',
          label: 'Schema retrieval failed',
          status: 'error',
        });
        return { fullMessage, aiMessage };
      }
    }

    return { fullMessage, aiMessage };
  }

  private async _runAiRequest(aiMessage: string, capability: AiCapability = 'chat', useAgentic = false): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const chatSettings = readAiScopeSettings(config, 'chat');
      const provider = chatSettings.provider;
      const modelInfo = await this._aiService.getModelInfo(provider, config, 'chat');
      debugLog('[ChatView] Using AI provider:', provider, 'Model:', modelInfo);

      void this._pushModelCatalogToWebview();

      vscode.window.setStatusBarMessage(`$(sparkle) AI: ${modelInfo}`, 3000);

      this._aiService.setConnectionContext({
        environment: this._currentEnvironment,
        readOnlyMode: this._currentReadOnlyMode,
        connectionName: this._currentConnectionName || this._currentConnectionId || '',
        databaseName: this._currentDatabase,
        useAgentic: useAgentic
      });

      const customSystem =
        this._chatSystemPromptMode === 'backup_tools'
          ? buildBackupToolsSystemPrompt({
              connectionDisplayName: this._currentConnectionName,
              databaseName: this._currentDatabase,
              environment: this._currentEnvironment,
              readOnlyMode: this._currentReadOnlyMode
            })
          : this._aiService.buildSystemPrompt(capability);

      this._cancellationTokenSource = new vscode.CancellationTokenSource();
      const cancellationToken = this._cancellationTokenSource.token;

      let responseText: string;
      let usageInfo: string | undefined;
      let toolTurns = 0;
      const aiStartTime = Date.now();

      this._pushThinkingStep({
        id: 'ai',
        label: 'Generating response…',
        status: 'active',
      });

      if (useAgentic) {
        debugLog('[ChatView] Executing agentic tool loop...');
        const { ToolOrchestrator } = await import('./chat/tools/ToolOrchestrator');
        const orchestrator = new ToolOrchestrator(
          this._extensionContext,
          this._aiService,
          this._currentConnectionId!,
          this._currentDatabase!
        );

        const result = await orchestrator.run(
          provider,
          this._messages,
          config,
          customSystem,
          'chat',
          cancellationToken,
          async (messages, turnCount) => {
            this._messages = messages;
            toolTurns = turnCount;

            const lastAssistant = [...messages].reverse().find(
              (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
            );
            if (lastAssistant?.toolCalls) {
              // Surface the model's own interim reasoning text (if any) alongside its
              // tool calls — previously discarded and replaced by a generic label.
              if (lastAssistant.content && lastAssistant.content.trim() && lastAssistant.content !== 'Calling database tools...') {
                this._pushThinkingStep({
                  id: `turn-${turnCount}-text`,
                  label: lastAssistant.content.trim(),
                  status: 'done',
                });
              }
              for (const call of lastAssistant.toolCalls) {
                const argsSummary = this._summarizeToolArgs(call.arguments);
                this._pushThinkingStep({
                  id: `tool-${call.id}`,
                  label: argsSummary ? `${call.name} · ${argsSummary}` : `Calling ${call.name}…`,
                  status: 'active',
                });
              }
            }

            for (const tm of messages) {
              if (tm.role === 'tool' && tm.toolCallId) {
                const resultSummary = this._summarizeToolResult(tm.content ?? '');
                this._pushThinkingStep({
                  id: `tool-${tm.toolCallId}`,
                  label: `${tm.name ?? 'tool'} · ${resultSummary}`,
                  status: resultSummary.startsWith('error:') ? 'error' : 'done',
                });
              }
            }

            if (turnCount > 0) {
              this._pushThinkingStep({
                id: 'agent',
                label: `Database agent · turn ${turnCount}`,
                status: 'active',
              });
            }
          }
        );

        toolTurns = result.toolTurns;
        // Only claim agent activity when the model actually ran tools — a text-only
        // reply through the agentic path is just a normal response.
        if (toolTurns > 0) {
          this._pushThinkingStep({
            id: 'agent',
            label: `Database agent completed (${toolTurns} turn${toolTurns !== 1 ? 's' : ''})`,
            status: 'done',
          });
        }

        this._messages = result.messages;
        responseText = result.text;
        usageInfo = result.usage;
      } else {
        debugLog('[ChatView] Falling back to standard chat (one-shot retrieve grounding)...');
        this._aiService.setMessages(this._messages);

        // Push empty assistant message placeholder
        this._messages.push({ role: 'assistant', content: '' });
        this._getTargetWebview()?.postMessage({
          type: 'startStream'
        });

        let accumulatedResponse = '';
        const result = await this._aiService.callProvider(
          provider,
          aiMessage,
          config,
          customSystem,
          'chat',
          undefined,
          (chunk) => {
            if (cancellationToken?.isCancellationRequested) {
              return;
            }
            if (chunk.text) {
              accumulatedResponse += chunk.text;
              
              // Update in-memory message content
              const lastIdx = this._messages.length - 1;
              if (lastIdx >= 0 && this._messages[lastIdx].role === 'assistant') {
                this._messages[lastIdx].content = accumulatedResponse;
              }

              this._getTargetWebview()?.postMessage({
                type: 'streamChunk',
                text: chunk.text,
                accumulated: accumulatedResponse
              });
            }
          }
        );
        responseText = result.text;
        usageInfo = result.usage;

        responseText = this._sanitizeResponse(responseText);
        const lastIdx = this._messages.length - 1;
        if (lastIdx >= 0 && this._messages[lastIdx].role === 'assistant') {
          this._messages[lastIdx].content = responseText;
          this._messages[lastIdx].usage = usageInfo;
        }
      }

      this._pushThinkingStep({
        id: 'ai',
        label: useAgentic && toolTurns > 0 ? 'Database agent finished' : 'Response generated',
        status: 'done',
      });

      const aiElapsed = ((Date.now() - aiStartTime) / 1000).toFixed(1);
      if (usageInfo) {
        usageInfo = `${usageInfo} · ${aiElapsed}s`;
      } else {
        usageInfo = `${aiElapsed}s`;
      }

      // Update usage label on the last assistant message
      if (this._messages.length > 0) {
        const lastMsg = this._messages[this._messages.length - 1];
        if (lastMsg.role === 'assistant') {
          lastMsg.usage = usageInfo;
        }
      }

      // Must attach before saving — sessions are persisted here, so a trace attached
      // by the caller *after* `_runAiRequest` returns would already have missed this save.
      this._attachThinkingTraceToLastAssistant();
      await this._saveCurrentSession();
    } catch (error) {
      this._pushThinkingStep({
        id: 'ai',
        label: 'Request failed',
        status: 'error',
      });
      if (error instanceof AiProviderHttpError && this._isNexqlFreeLimitError(error)) {
        this._handleNexqlFreeLimitError(error);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this._messages.push({
          role: 'assistant',
          content: `❌ Error: ${errorMessage}\n\nPlease check your AI provider settings in the extension configuration.`
        });
      }
    } finally {
      if (this._cancellationTokenSource) {
        this._cancellationTokenSource.dispose();
        this._cancellationTokenSource = null;
      }
    }
  }

  /** NexQL free-AI proxy responses that need an upgrade / BYOK nudge instead of a raw error. */
  private _isNexqlFreeLimitError(error: AiProviderHttpError): boolean {
    return (
      error.httpStatus === 429 ||
      error.httpStatus === 402 ||
      error.httpStatus === 403 ||
      error.httpStatus === 503 ||
      ['quota_exceeded', 'rate_limited', 'pool_exhausted', 'free_ai_disabled', 'tier_required'].includes(error.errorCode || '')
    );
  }

  /** Human-readable "resets <date>" suffix from a server-provided ISO reset timestamp. */
  private _resetSuffix(error: AiProviderHttpError): string {
    const resetAt = error.errorData?.resetAt;
    if (typeof resetAt !== 'string') {
      return '';
    }
    const when = new Date(resetAt);
    if (Number.isNaN(when.getTime())) {
      return '';
    }
    return ` Resets ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`;
  }

  private _handleNexqlFreeLimitError(error: AiProviderHttpError): void {
    let title: string;
    let content: string;
    // Burst throttle (transient) — distinct from the monthly cap; a short wait fixes it.
    if (error.errorCode === 'rate_limited') {
      title = 'Sending requests too quickly.';
      content =
        '🐢 **Sending requests too quickly.**\n\n' +
        'Please wait a few seconds and try again.';
      this._messages.push({ role: 'assistant', content });
      void vscode.window.showWarningMessage(title);
      return;
    }
    if (error.httpStatus === 429 || error.errorCode === 'quota_exceeded') {
      const suffix = this._resetSuffix(error);
      const limit = typeof error.errorData?.limit === 'number' ? error.errorData.limit : undefined;
      const capNote = limit !== undefined ? ` (${limit.toLocaleString()} tokens/month)` : '';
      title = 'Free AI limit reached for this month.';
      content =
        `⏳ **Free AI limit reached for this month${capNote}.**${suffix}\n\n` +
        'Upgrade for a higher monthly cap, or switch to your own API key in AI Settings.';
    } else if (error.httpStatus === 403 || error.errorCode === 'tier_required') {
      title = 'This model requires a higher NexQL tier.';
      content =
        '🔒 **This model requires a higher NexQL tier.**\n\n' +
        'Upgrade to Sponsor or Teams to unlock Engineer/Architect, or switch to your own API key in AI Settings.';
    } else {
      title = 'Free AI is temporarily unavailable.';
      content =
        '⚠️ **Free AI is temporarily unavailable.**\n\n' +
        'Switch to your own API key in AI Settings, or try again later.';
    }
    this._messages.push({ role: 'assistant', content });

    void vscode.window
      .showWarningMessage(title, 'Upgrade', 'Use my own key')
      .then(async (choice) => {
        if (choice === 'Upgrade') {
          await vscode.env.openExternal(vscode.Uri.parse('https://nexql.astrx.dev/#pricing'));
        } else if (choice === 'Use my own key') {
          await vscode.commands.executeCommand('postgres-explorer.aiSettings');
        }
      });
  }

  /** Replace the last assistant reply without appending a duplicate user turn. */
  private async _regenerateAssistantReply(): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (this._messages.length === 0) {
      return;
    }

    this._isProcessing = true;
    try {
      const last = this._messages[this._messages.length - 1]!;
      if (last.role === 'assistant') {
        this._messages.pop();
      }

      // Pop any preceding tool calls/results from the last agent turn
      while (this._messages.length > 0) {
        const top = this._messages[this._messages.length - 1];
        if (top.role === 'tool' || (top.role === 'assistant' && top.toolCalls)) {
          this._messages.pop();
        } else {
          break;
        }
      }

      this._updateChatHistory();

      const user = this._messages[this._messages.length - 1];
      if (!user || user.role !== 'user') {
        return;
      }

      const plain = this._plainPromptFromUserMessage(user);
      this._startThinking();
      await this._ensureConnectionContext();
      const useAgentic = await this._resolveUseAgentic();
      const { aiMessage } = await this._composeUserTurnPayload(
        plain,
        user.attachments,
        user.mentions,
        { onThinkingStep: (step) => this._pushThinkingStep(step), skipRag: useAgentic }
      );

      this._setTypingIndicator(true);
      try {
        await this._runAiRequest(aiMessage, 'chat', useAgentic);
      } finally {
        this._endThinking();
        this._setTypingIndicator(false);
        this._updateChatHistory();
      }
    } finally {
      this._isProcessing = false;
    }
  }

  /** Truncate at `userIndex` and re-run AI for that user message (drops later turns in-place). */
  private async _resendUserMessageAtIndex(userIndex: number): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (!Number.isFinite(userIndex) || userIndex < 0 || userIndex >= this._messages.length) {
      return;
    }

    const turn = this._messages[userIndex];
    if (!turn || turn.role !== 'user') {
      return;
    }

    this._isProcessing = true;
    try {
      this._messages = this._messages.slice(0, userIndex);
      this._messages.push(turn);
      this._updateChatHistory();

      const plain = this._plainPromptFromUserMessage(turn);
      this._startThinking();
      await this._ensureConnectionContext();
      const useAgentic = await this._resolveUseAgentic();
      const { aiMessage } = await this._composeUserTurnPayload(
        plain,
        turn.attachments,
        turn.mentions,
        { onThinkingStep: (step) => this._pushThinkingStep(step), skipRag: useAgentic }
      );

      this._setTypingIndicator(true);
      try {
        await this._runAiRequest(aiMessage, 'chat', useAgentic);
      } finally {
        this._endThinking();
        this._setTypingIndicator(false);
        this._updateChatHistory();
      }
    } finally {
      this._isProcessing = false;
    }
  }

  private async _handleUserMessage(message: string, attachments?: FileAttachment[], mentions?: DbMention[], capability: AiCapability = 'chat') {
    if (this._isProcessing) {
      return;
    }

    // Freemium: meter each AI message against the daily free quota (paid = unlimited).
    // requirePro consumes one unit and surfaces a "resets …" nudge when exhausted.
    if (!(await requirePro(ProFeature.AiAssistant))) {
      return;
    }

    this._isProcessing = true;

    debugLog('[ChatView] ========== HANDLING USER MESSAGE ==========');
    debugLog('[ChatView] Message:', message);
    debugLog('[ChatView] Attachments:', attachments?.length || 0);
    debugLog('[ChatView] Mentions:', mentions?.length || 0);
    if (mentions && mentions.length > 0) {
      debugLog('[ChatView] Mention details:', JSON.stringify(mentions, null, 2));
    }

    try {
      const fullMessage = this._buildUserDisplayMessage(message, attachments);

      // Show user message immediately — do not block on RAG / context retrieval.
      this._messages.push({ role: 'user', content: fullMessage, attachments, mentions });
      this._updateChatHistory();

      this._startThinking();
      await this._ensureConnectionContext();
      const useAgentic = await this._resolveUseAgentic();
      const { aiMessage } = await this._composeUserTurnPayload(
        message,
        attachments,
        mentions,
        { onThinkingStep: (step) => this._pushThinkingStep(step), skipRag: useAgentic }
      );

      this._setTypingIndicator(true);
      try {
        await this._runAiRequest(aiMessage, capability, useAgentic);
      } finally {
        this._endThinking();
        this._setTypingIndicator(false);
        this._updateChatHistory();
      }
    } finally {
      this._isProcessing = false;
    }
  }

  // Sanitize AI response to remove any HTML-like artifacts
  private _sanitizeResponse(response: string): string {
    // Remove patterns like: sql-keyword">, sql-string">, sql-function">, sql-number">, function">
    // These are CSS class artifacts that sometimes leak into AI responses
    let cleaned = response;

    // Remove CSS class-like patterns followed by ">
    cleaned = cleaned.replace(/\b(sql-keyword|sql-string|sql-function|sql-number|sql-type|sql-comment|sql-operator|sql-special|function)"\s*>/gi, '');

    // Log if we found and cleaned anything
    if (cleaned !== response) {
      debugLog('[ChatView] Sanitized AI response - removed HTML artifacts');
    }

    return cleaned;
  }

  // ==================== Database Objects ====================

  private async _handleGetConnections(): Promise<void> {
    try {
      const connections = await this._dbObjectService.getConnections();
      this._getTargetWebview()?.postMessage({
        type: 'connectionsList',
        connections: connections.map(c => ({ id: c.connectionId, name: c.name }))
      });
      if (connections.length === 0) {
        this._getTargetWebview()?.postMessage({ type: 'noConnectionsAvailable' });
      }
    } catch (e) {
      console.error('[ChatView] Failed to get connections for dropdown:', e);
    }
  }

  private async _handleGetDatabases(connectionId: string): Promise<void> {
    try {
      const databases = await this._dbObjectService.getDatabases(connectionId);
      this._getTargetWebview()?.postMessage({
        type: 'databasesList',
        connectionId,
        databases: databases.map(d => d.name)
      });
    } catch (e) {
      console.error('[ChatView] Failed to get databases for dropdown:', e);
    }
  }

  private async _handleSearchDbObjects(query: string, scope?: DbSearchScope): Promise<void> {
    try {
      const filtered = await this._dbObjectService.searchObjectsAsync(query, scope);

      this._getTargetWebview()?.postMessage({
        type: 'dbObjectsResult',
        objects: filtered
      });
    } catch (error) {
      this._getTargetWebview()?.postMessage({
        type: 'dbObjectsResult',
        objects: [],
        error: 'Failed to fetch database objects'
      });
    }
  }

  private async _handleGetDbObjectDetails(object: DbObject): Promise<DbObject> {
    try {
      const details = await this._dbObjectService.getObjectSchema(object);
      const objWithDetails = { ...object, details };
      this._getTargetWebview()?.postMessage({
        type: 'dbObjectDetails',
        object: objWithDetails
      });
      return objWithDetails;
    } catch (error) {
      return object;
    }
  }

  private async _handleGetAllDbObjects(): Promise<void> {
    try {
      const objects = await this._dbObjectService.getInitialObjects();
      this._getTargetWebview()?.postMessage({
        type: 'dbObjectsResult',
        objects: objects
      });
    } catch (error) {
      this._getTargetWebview()?.postMessage({
        type: 'dbObjectsResult',
        objects: [],
        error: 'No database connections available'
      });
    }
  }

  private async _handleGetDbHierarchy(path: any): Promise<void> {
    try {
      let items: DbObject[] = [];

      if (!path || !path.connectionId) {
        items = await this._dbObjectService.getConnections();
      } else if (!path.database) {
        items = await this._dbObjectService.getDatabases(path.connectionId);
      } else if (!path.schema) {
        items = await this._dbObjectService.getSchemas(path.connectionId, path.database);
      } else {
        items = await this._dbObjectService.getSchemaObjects(path.connectionId, path.database, path.schema);
      }

      this._getTargetWebview()?.postMessage({
        type: 'dbHierarchyData',
        path: path,
        items: items
      });

    } catch (error) {
      console.error('Error fetching hierarchy:', error);
      this._getTargetWebview()?.postMessage({
        type: 'dbHierarchyData',
        path: path,
        items: [],
        error: 'Failed to load database objects'
      });
    }
  }

  // ==================== File Handling ====================

  private async _handleFilePick() {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: {
        'SQL Files': ['sql', 'pgsql'],
        'Data Files': ['csv', 'json', 'txt'],
        'All Files': ['*']
      },
      title: 'Select a file to attach'
    });

    if (fileUri && fileUri[0]) {
      try {
        const fileContent = await vscode.workspace.fs.readFile(fileUri[0]);
        const content = new TextDecoder().decode(fileContent);
        const fileName = fileUri[0].path.split('/').pop() || 'file';

        const maxSize = 50000;
        const truncatedContent = content.length > maxSize
          ? content.substring(0, maxSize) + '\n... (truncated)'
          : content;

        this._getTargetWebview()?.postMessage({
          type: 'fileAttached',
          file: {
            name: fileName,
            content: truncatedContent,
            type: this._getFileType(fileName),
            path: fileUri[0].fsPath
          }
        });
      } catch (error) {
        vscode.window.showErrorMessage('Failed to read file');
      }
    }
  }

  private async _handlePreviewFile(filePath: string, fileName: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open file: ${fileName}`);
    }
  }

  private _getFileType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const typeMap: { [key: string]: string } = {
      'sql': 'sql',
      'pgsql': 'sql',
      'json': 'json',
      'csv': 'csv',
      'txt': 'text'
    };
    return typeMap[ext] || 'text';
  }

  // ==================== Notebook Integration ====================

  private async _handleOpenInNotebook(code: string): Promise<void> {
    try {
      const activeNotebook = vscode.window.activeNotebookEditor;

      if (activeNotebook && activeNotebook.notebook.notebookType === 'postgres-notebook') {
        // Insert new SQL cell at the end
        const edit = new vscode.WorkspaceEdit();
        const cellData = new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          code,
          'sql'
        );
        const notebookEdit = vscode.NotebookEdit.insertCells(
          activeNotebook.notebook.cellCount,
          [cellData]
        );
        edit.set(activeNotebook.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);

        // Send success back to webview
        this._getTargetWebview()?.postMessage({
          type: 'notebookResult',
          success: true
        });
      } else {
        // No active notebook - send error back to webview
        this._getTargetWebview()?.postMessage({
          type: 'notebookResult',
          success: false,
          error: 'Open notebook first'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._getTargetWebview()?.postMessage({
        type: 'notebookResult',
        success: false,
        error: errorMessage
      });
    }
  }

  // ==================== Session Management ====================

  private async _saveCurrentSession(): Promise<void> {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const chatSettings = readAiScopeSettings(config, 'chat');
    const provider = chatSettings.provider;

    // Phase C: Pass metadata to session service
    await this._sessionService.saveSession(
      this._messages,
      (msg) => this._aiService.generateTitle(msg, provider),
      {
        connectionName: this._currentConnectionName,
        database: this._currentDatabase
      }
    );
    this._sendHistoryToWebview();
  }

  private async _loadSession(sessionId: string): Promise<void> {
    const messages = this._sessionService.loadSession(sessionId);
    if (messages) {
      this._messages = messages;
      this._chatSystemPromptMode = 'default';
      this._updateChatHistory();
    }
  }

  private async _deleteSession(sessionId: string): Promise<void> {
    debugLog('[ChatView] _deleteSession called with:', sessionId);
    const wasCurrentSession = await this._sessionService.deleteSession(sessionId);
    debugLog('[ChatView] Session deleted, wasCurrentSession:', wasCurrentSession);

    if (wasCurrentSession) {
      this._messages = [];
      this._chatSystemPromptMode = 'default';
      this._updateChatHistory();
    }

    debugLog('[ChatView] Sending updated history to webview...');
    this._sendHistoryToWebview();
  }

  private _sendHistoryToWebview(): void {
    this._getTargetWebview()?.postMessage({
      type: 'updateHistory',
      sessions: this._sessionService.getSessionSummaries()
    });
  }

  // Phase C: Send context bar update to webview
  private _sendContextUpdate(): void {
    this._getTargetWebview()?.postMessage({
      type: 'contextUpdate',
      connectionName: this._currentConnectionName || null,
      database: this._currentDatabase || null,
      environment: this._currentEnvironment || null,
      readOnlyMode: this._currentReadOnlyMode || false
    });
  }

  // ==================== UI Helpers ====================

  private _updateChatHistory(): void {
    const uiMessages: ChatMessage[] = [];
    let pendingSteps: Array<{ toolCall: ToolCall; result: string }> = [];

    for (let i = 0; i < this._messages.length; i++) {
      const msg = this._messages[i];
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const call of msg.toolCalls) {
          const toolResp = this._messages.slice(i + 1).find(m => m.role === 'tool' && m.toolCallId === call.id);
          pendingSteps.push({
            toolCall: call,
            result: toolResp ? toolResp.content : 'No response content'
          });
        }
      } else if (msg.role === 'tool') {
        continue;
      } else if (msg.role === 'assistant' && !msg.toolCalls) {
        const newMsg = { ...msg };
        if (pendingSteps.length > 0) {
          newMsg.agenticSteps = pendingSteps;
          pendingSteps = [];
        }
        uiMessages.push(newMsg);
      } else {
        // User messages: stamp the raw-array index so "resend" can slice the correct
        // turn — this list has tool-call/tool messages filtered/merged out, so the
        // filtered index the webview sees no longer matches `_messages`.
        uiMessages.push(msg.role === 'user' ? { ...msg, _rawIdx: i } : msg);
      }
    }

    if (pendingSteps.length > 0) {
      const lastMsg = uiMessages[uiMessages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.agenticSteps = pendingSteps;
      } else {
        uiMessages.push({
          role: 'assistant',
          content: 'Running database tools...',
          agenticSteps: pendingSteps
        });
      }
    }

    this._getTargetWebview()?.postMessage({
      type: 'updateMessages',
      messages: uiMessages,
      sessionTitle: this._getActiveSessionTitle(),
    });
  }

  private _getActiveSessionTitle(): string | undefined {
    const currentId = this._sessionService.getCurrentSessionId();
    if (!currentId) {
      return undefined;
    }
    const session = this._sessionService.getChatSessions().find((s) => s.id === currentId);
    return session?.title;
  }

  private _setTypingIndicator(isTyping: boolean): void {
    this._getTargetWebview()?.postMessage({
      type: 'setTyping',
      isTyping
    });
  }

  private _postModelCatalogToWebview(
    webview: vscode.Webview,
    payload: { catalog: unknown[]; activeSelectionId: string; activeModelLabel: string },
    options?: { catalogLoading?: boolean },
  ): void {
    webview.postMessage({
      type: 'updateModelCatalog',
      catalog: payload.catalog,
      activeSelectionId: payload.activeSelectionId,
      activeModelLabel: payload.activeModelLabel,
      catalogLoading: options?.catalogLoading === true,
    });

    webview.postMessage({
      type: 'updateModelInfo',
      modelName: payload.activeModelLabel,
    });
  }

  private async _pushModelCatalogToWebview(): Promise<void> {
    const webview = this._getTargetWebview();
    if (!webview) {
      return;
    }

    const catalogService = AiModelCatalogService.getInstance(this._extensionContext);
    this._postModelCatalogToWebview(webview, catalogService.buildChatCatalogPreview(), {
      catalogLoading: true,
    });

    const payload = await catalogService.buildChatCatalog();
    const currentWebview = this._getTargetWebview();
    if (!currentWebview) {
      return;
    }
    this._postModelCatalogToWebview(currentWebview, payload, { catalogLoading: false });
  }

  private async _handleSwitchChatModel(selectionId: string): Promise<void> {
    if (selectionId === '__configure__') {
      await vscode.commands.executeCommand('postgres-explorer.aiSettings');
      return;
    }

    const parsed = parseSelectionId(selectionId);
    if (!parsed) {
      return;
    }

    await writeAiScopeSettings('chat', {
      provider: parsed.provider,
      model: parsed.modelId,
    });
    await rememberLastModelForProvider(
      this._extensionContext,
      parsed.provider,
      parsed.modelId,
    );
    AiModelCatalogService.getInstance(this._extensionContext).invalidateCache();
    await this._pushModelCatalogToWebview();
  }

  public async handleExplainError(error: string, query: string): Promise<void> {
    const prompt = `I ran this SQL query:\n\`\`\`sql\n${query}\n\`\`\`\n\nI got this error:\n${error}\n\nCan you explain why this error occurred and how to fix it? Provide the corrected SQL query.`;
    await this._handleUserMessage(prompt, undefined, undefined, 'explainError');
  }

  public async handleFixQuery(error: string, query: string): Promise<void> {
    const prompt = `Fix this SQL query which caused an error:\n\nQuery:\n\`\`\`sql\n${query}\n\`\`\`\n\nError:\n${error}\n\nPlease provide only the corrected SQL code and a brief explanation.`;
    await this._handleUserMessage(prompt, undefined, undefined, 'fixQuery');
  }

  public async handleAnalyzeData(dataCsv: string, query: string, totalRows: number): Promise<void> {
    // P1.4: cap the sample fed to the model. For large result sets, send only the first
    // AI_ANALYZE_MAX_SAMPLE_ROWS rows inline and skip writing the full CSV to a temp file.
    const isSampled = totalRows > AI_ANALYZE_MAX_SAMPLE_ROWS;
    const sampledCsv = isSampled ? this._sampleCsv(dataCsv, AI_ANALYZE_MAX_SAMPLE_ROWS) : dataCsv;
    const sampleNote = isSampled
      ? `\n\n(sampled ${AI_ANALYZE_MAX_SAMPLE_ROWS} of ${totalRows} rows)`
      : '';

    if (isSampled) {
      // Over cap: keep the payload small — inline the sampled rows, no temp file.
      const prompt = `I ran this query:\n\`\`\`sql\n${query}\n\`\`\`\n\nIt returned ${totalRows} rows. Here is a sample of the data (CSV):\n\n${sampledCsv}${sampleNote}\n\nPlease analyze this data. Look for patterns, outliers, or interesting insights. Summarize what this data represents.`;
      await this._handleUserMessage(prompt, undefined, undefined, 'analyzeData');
      return;
    }

    try {
      // Within cap: attach the full CSV as a temp file (unchanged behavior).
      const tempDir = os.tmpdir();
      const fileName = `analysis_${Date.now()}.csv`;
      const filePath = path.join(tempDir, fileName);

      await fs.promises.writeFile(filePath, sampledCsv, 'utf8');

      const prompt = `I ran this query:\n\`\`\`sql\n${query}\n\`\`\`\n\nIt returned ${totalRows} rows. I have attached the data as a CSV file.\n\nPlease analyze this data. Look for patterns, outliers, or interesting insights. Summarize what this data represents.`;

      await this._handleUserMessage(prompt, [{
        name: fileName,
        content: sampledCsv,
        type: 'csv',
        path: filePath
      }], undefined, 'analyzeData');
    } catch (error) {
      console.error('Failed to create temp file for analysis:', error);
      ErrorService.getInstance().showError('Failed to prepare data for analysis. Using inline data instead.');
      const prompt = `I ran this query:\n\`\`\`sql\n${query}\n\`\`\`\n\nIt returned ${totalRows} rows. Here is the data:\n\n${sampledCsv}\n\nPlease analyze this data.`;
      await this._handleUserMessage(prompt, undefined, undefined, 'analyzeData');
    }
  }

  /** Keep the CSV header plus the first `maxRows` data rows. */
  private _sampleCsv(csv: string, maxRows: number): string {
    const lines = csv.split('\n');
    if (lines.length <= maxRows + 1) {
      return csv;
    }
    // Header + first maxRows data rows.
    return lines.slice(0, maxRows + 1).join('\n');
  }

  public async handleOptimizeQuery(query: string, executionTime?: number): Promise<void> {
    const timeInfo = executionTime ? `\n\nThe query took ${executionTime.toFixed(3)}ms to execute.` : '';
    const prompt = `Optimize this SQL query:\n\`\`\`sql\n${query}\n\`\`\`${timeInfo}`;
    await this._handleUserMessage(prompt, undefined, undefined, 'optimizeQuery');
  }

  /**
   * Handle "Explain this result" - feeds execution plan and performance metrics to AI
   */
  public async handleExplainResult(
    query: string,
    executionTime: number,
    rowCount: number,
    explainPlan?: any
  ): Promise<void> {
    const QueryAnalyzer = require('../services/QueryAnalyzer').QueryAnalyzer;
    const analyzer = QueryAnalyzer.getInstance();

    let planContext = '';
    let metricsContext = '';

    if (explainPlan) {
      const metrics = analyzer.extractPlanMetrics(explainPlan);
      if (metrics) {
        metricsContext = `
Performance Metrics:
- Total Cost: ${metrics.totalCost.toFixed(2)}
- Planning Time: ${metrics.planningTime.toFixed(2)}ms
- Execution Time: ${metrics.executionTime.toFixed(2)}ms
- Sequential Scans: ${metrics.sequentialScans}
- Index Scans: ${metrics.indexScans}
${metrics.bufferStats ? `- Buffer Hit Ratio: ${metrics.bufferStats.hitRatio?.toFixed(1)}%` : ''}
${metrics.bottlenecks.length > 0 ? `\nBottlenecks Detected:\n${metrics.bottlenecks.map((b: string) => `- ${b}`).join('\n')}` : ''}
${metrics.recommendations.length > 0 ? `\nInitial Recommendations:\n${metrics.recommendations.map((r: string) => `- ${r}`).join('\n')}` : ''}`;

        planContext = `\n\nExecution Plan (JSON):\n\`\`\`json\n${JSON.stringify(explainPlan, null, 2)}\n\`\`\``;
      }
    }

    const prompt = `I just executed this query and got these results:\n\`\`\`sql\n${query}\n\`\`\`

Execution Details:
- Time: ${executionTime.toFixed(3)}ms
- Rows Returned: ${rowCount}
${metricsContext}${planContext}

Can you explain what this query is doing, how efficient it is, and what the execution plan tells us about its performance? What are the key performance factors?`;

    await this._handleUserMessage(prompt, undefined, undefined, 'optimizeQuery');
  }

  /**
   * Handle "Why slow?" - compares against baseline and provides performance analysis
   */
  public async handleWhySlow(
    query: string,
    currentExecutionTime: number,
    baselineAvgTime: number,
    explainPlan?: any,
    tableStats?: Array<{ table: string; rows: number; deadRows: number; lastVacuum?: string }>
  ): Promise<void> {
    const QueryAnalyzer = require('../services/QueryAnalyzer').QueryAnalyzer;
    const analyzer = QueryAnalyzer.getInstance();

    let context = `Query:\n\`\`\`sql\n${query}\n\`\`\`

Performance Comparison:
- Current Execution Time: ${currentExecutionTime.toFixed(3)}ms
- Historical Average: ${baselineAvgTime.toFixed(3)}ms
- Degradation: ${(((currentExecutionTime - baselineAvgTime) / baselineAvgTime) * 100).toFixed(1)}% slower`;

    if (explainPlan) {
      const metrics = analyzer.extractPlanMetrics(explainPlan);
      if (metrics) {
        context += `

Current Execution Plan Metrics:
- Total Cost: ${metrics.totalCost.toFixed(2)}
- Sequential Scans: ${metrics.sequentialScans}
- Index Scans: ${metrics.indexScans}
${metrics.bufferStats ? `- Buffer Hit Ratio: ${metrics.bufferStats.hitRatio?.toFixed(1)}%` : ''}
${metrics.bottlenecks.length > 0 ? `\nBottlenecks:\n${metrics.bottlenecks.map((b: string) => `- ${b}`).join('\n')}` : ''}`;
      }
    }

    if (tableStats && tableStats.length > 0) {
      context += `

Affected Table Statistics:
${tableStats.map((t: any) => `- ${t.table}: ${t.rows} rows, ${t.deadRows} dead rows${t.lastVacuum ? `, last vacuum ${t.lastVacuum}` : ''}`).join('\n')}

This might indicate table bloat or stale statistics affecting query planning.`;
    }

    const prompt = `${context}

Why is this query running slower than its historical baseline? What could have changed (table growth, missing statistics, index bloat, lock contention, etc.)? Please provide specific next steps to diagnose and fix the performance regression.`;

    await this._handleUserMessage(prompt, undefined, undefined, 'optimizeQuery');
  }

  /**
   * Opens SQL Assistant with a **backup-tools** system prompt (pg_dump/pg_restore focus),
   * starts a fresh chat, and sends one auto-generated user turn with panel context.
   */
  public async openBackupToolsAssistant(params: OpenBackupToolsAssistantParams): Promise<void> {
    if (this._isProcessing) {
      vscode.window.showWarningMessage('SQL Assistant is busy. Cancel the current request or wait.');
      return;
    }

    const target = await this._ensureChatWebview();
    if (!target) {
      vscode.window.showWarningMessage('Could not open SQL Assistant.');
      return;
    }

    await vscode.commands.executeCommand('postgresExplorer.chatView.focus');
    await new Promise<void>(resolve => setTimeout(resolve, 280));

    await this._saveCurrentSession();
    this._messages = [];
    this._sessionService.clearCurrentSession();
    this._chatSystemPromptMode = 'backup_tools';

    const conn = params.connection;
    this._currentConnectionId = conn?.id;
    this._currentConnectionName = conn?.name ?? params.databaseLabel;
    this._currentDatabase = params.databaseName;
    this._currentEnvironment = conn?.environment;
    this._currentReadOnlyMode = conn?.readOnlyMode === true;
    this._aiService.setConnectionContext({
      environment: this._currentEnvironment,
      readOnlyMode: this._currentReadOnlyMode,
      connectionName: this._currentConnectionName,
      databaseName: this._currentDatabase,
      useAgentic: false,
    });
    this._sendContextUpdate();

    const inferred = params.toolLog ? inferBackupToolFromLog(params.toolLog) : undefined;
    const userMsg = buildBackupToolsUserMessage({
      scenario: params.scenario,
      connectionId: params.connectionId,
      databaseLabel: params.databaseLabel,
      databaseName: params.databaseName,
      host: conn?.host,
      port: conn?.port,
      username: conn?.username,
      sshEnabled: !!conn?.ssh?.enabled,
      serverMajor: params.serverMajor,
      pgDumpMajor: params.pgDumpMajor,
      pgRestoreMajor: params.pgRestoreMajor,
      toolLog: params.toolLog,
      inferredTool: inferred
    });

    this._isProcessing = true;
    try {
      this._messages.push({ role: 'user', content: userMsg });
      this._updateChatHistory();
      this._sendHistoryToWebview();

      this._setTypingIndicator(true);
      try {
        await this._runAiRequest(userMsg);
      } finally {
        this._setTypingIndicator(false);
        this._updateChatHistory();
      }

      await this._saveCurrentSession();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._messages.push({
        role: 'assistant',
        content: `❌ Error: ${msg}\n\nPlease check your AI provider settings.`
      });
      this._updateChatHistory();
    } finally {
      this._isProcessing = false;
    }
  }

  public async handleGenerateQuery(
    description: string,
    schemaContext?: Array<{ type: string, schema: string, name: string, columns?: string[] }>
  ): Promise<void> {
    let prompt = `Please generate a SQL query for the following request:\n\n"${description}"`;

    if (schemaContext && schemaContext.length > 0) {
      prompt += '\n\nUse the following database objects:\n\n';

      schemaContext.forEach(obj => {
        if (obj.type === 'table' || obj.type === 'view') {
          prompt += `${obj.type.toUpperCase()}: ${obj.schema}.${obj.name}\n`;
          if (obj.columns && obj.columns.length > 0) {
            prompt += `  Columns: ${obj.columns.join(', ')}\n`;
          }
        } else if (obj.type === 'function') {
          prompt += `FUNCTION: ${obj.schema}.${obj.name}\n`;
        }
        prompt += '\n';
      });
    } else {
      prompt += '\n\nNote: No specific schema context provided. Please ask for table/column names if needed.';
    }

    await this._handleUserMessage(prompt, undefined, undefined, 'generateQuery');
  }
}
