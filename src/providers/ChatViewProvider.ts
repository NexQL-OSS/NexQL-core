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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ChatMessage,
  FileAttachment,
  DbMention,
  DbObject,
  DbObjectService,
  AiService,
  SessionService,
  getWebviewHtml,
  AiCapability
} from './chat';
import type { ConnectionConfig, NoticeLogEntry } from '../common/types';
import { buildBackupToolsSystemPrompt, buildBackupToolsUserMessage } from './chat/backupToolsAssistantPrompt';
import { ErrorService } from '../services/ErrorService';
import {
  parseSelectionId,
  readAiScopeSettings,
  rememberLastModelForProvider,
  writeAiScopeSettings,
} from '../features/aiAssistant/aiConfig';
import { AiModelCatalogService } from '../features/aiAssistant/AiModelCatalogService';
import { isProFeatureEnabled, getUpgradeHtml, ProFeature, requirePro } from '../services/featureGates';

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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'postgresExplorer.chatView';
  public static readonly panelViewType = 'postgresExplorer.chatViewPanel';

  private _view?: vscode.WebviewView;
  private _panels = new Set<vscode.WebviewPanel>();
  private _activeWebview?: vscode.Webview;
  private _messages: ChatMessage[] = [];
  private _isProcessing = false;

  // Phase C: Track current connection/database context for session metadata
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
  }

  /**
   * Public method to refresh the AI model info display
   * Called when AI settings are changed
   */
  public refreshModelInfo(): void {
    void this._pushModelCatalogToWebview();
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

    panel.onDidDispose(() => {
      this._panels.delete(panel);
      if (this._activeWebview === panel.webview) {
        this._activeWebview = this._view?.webview;
      }
    });

    await this._initializeWebview(panel.webview);
    this._registerWebviewMessageHandler(panel.webview);

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
          this._aiService.cancel();
          this._setTypingIndicator(false);
          this._isProcessing = false;
          vscode.window.showInformationMessage('AI request cancelled.');
          break;
        case 'getHistory':
          this._sendHistoryToWebview();
          break;
        case 'searchDbObjects':
          await this._handleSearchDbObjects(data.query);
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
        case 'getModelCatalog':
          await this._pushModelCatalogToWebview();
          break;
        case 'switchChatModel':
          await this._handleSwitchChatModel(data.selectionId);
          break;
        case 'openInNotebook':
          await this._handleOpenInNotebook(data.code);
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
  public async sendToChat(data: {
    query: string;
    results?: string;
    message: string;
    /** PostgreSQL RAISE NOTICE / server messages — attached as a .txt file */
    notices?: Array<string | NoticeLogEntry>;
  }): Promise<void> {
    const targetWebview = await this._ensureChatWebview();

    // Wait a bit for the view to be ready after focus
    await new Promise(resolve => setTimeout(resolve, 300));

    if (!targetWebview) {
      vscode.window.showWarningMessage('Chat view not available. Please open the SQL Assistant panel first.');
      return;
    }

    debugLog('[ChatViewProvider] Sending file attachments to webview');

    try {
      const tempDir = os.tmpdir();

      // Create query file
      if (data.query) {
        const queryFileName = `query_${Date.now()}.sql`;
        const queryFilePath = path.join(tempDir, queryFileName);
        await fs.promises.writeFile(queryFilePath, data.query, 'utf8');

        targetWebview.postMessage({
          type: 'fileAttached',
          file: {
            name: queryFileName,
            content: data.query,
            type: 'sql',
            path: queryFilePath
          }
        });
      }

      // Optional notices file (numbered, execution order)
      if (data.notices && data.notices.length > 0) {
        const noticeLines = data.notices
          .map((n, i) => {
            if (typeof n === 'string') {
              return `${i + 1}. ${n}`;
            }
            const msg = n.message ?? '';
            const iso = n.receivedAt?.trim();
            if (iso) {
              return `${i + 1}. [${iso}] ${msg}`;
            }
            return `${i + 1}. ${msg}`;
          })
          .join('\n\n');
        const noticeFileName = `notices_${Date.now()}.txt`;
        const noticeFilePath = path.join(tempDir, noticeFileName);
        await fs.promises.writeFile(noticeFilePath, noticeLines, 'utf8');

        targetWebview.postMessage({
          type: 'fileAttached',
          file: {
            name: noticeFileName,
            content: noticeLines,
            type: 'txt',
            path: noticeFilePath,
          },
        });
      }

      // Create results file if we have results - convert to CSV like Analyze Data does
      if (data.results) {
        try {
          const resultsData = JSON.parse(data.results);
          const columns: string[] = resultsData.columns || [];
          const rows: any[] = resultsData.rows || [];

          // Build CSV content
          let csvContent = '';

          // Header row
          if (columns.length > 0) {
            csvContent = columns.map((col: string) => `"${col}"`).join(',') + '\n';
          }

          // Data rows
          for (const row of rows) {
            const csvRow = columns.map((col: string) => {
              const val = row[col];
              if (val === null || val === undefined) return '';
              if (typeof val === 'string') return `"${val.replace(/"/g, '""')}"`;
              if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
              return String(val);
            }).join(',');
            csvContent += csvRow + '\n';
          }

          const resultsFileName = `results_${Date.now()}.csv`;
          const resultsFilePath = path.join(tempDir, resultsFileName);
          await fs.promises.writeFile(resultsFilePath, csvContent, 'utf8');

          targetWebview.postMessage({
            type: 'fileAttached',
            file: {
              name: resultsFileName,
              content: csvContent,
              type: 'csv',
              path: resultsFilePath
            }
          });
        } catch (parseError) {
          // Fallback: attach as JSON if parsing fails
          const resultsFileName = `results_${Date.now()}.json`;
          const resultsFilePath = path.join(tempDir, resultsFileName);
          await fs.promises.writeFile(resultsFilePath, data.results, 'utf8');

          targetWebview.postMessage({
            type: 'fileAttached',
            file: {
              name: resultsFileName,
              content: data.results,
              type: 'json',
              path: resultsFilePath
            }
          });
        }
      }

      const attached: string[] = [];
      if (data.query?.trim()) {
        attached.push('query');
      }
      if (data.results) {
        attached.push('results');
      }
      if (data.notices?.length) {
        attached.push('notices');
      }
      if (data.message?.trim()) {
        targetWebview.postMessage({
          type: 'prefillInput',
          message: data.message,
          autoSend: false,
        });
      }
      const summary = attached.length ? attached.join(' & ') : 'Content';
      const toast =
        data.message?.trim()
          ? attached.length > 0
            ? `${summary} attached to SQL Assistant. Review the prefilled prompt and press Send.`
            : 'Review the prefilled prompt in SQL Assistant and press Send.'
          : `${summary} attached to SQL Assistant. Add your question and send!`;
      vscode.window.showInformationMessage(toast);

    } catch (error) {
      console.error('[ChatViewProvider] Failed to create temp files:', error);
      ErrorService.getInstance().showError('Failed to attach files to chat');
    }
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;
    this._activeWebview = webviewView.webview;

    if (!isProFeatureEnabled(ProFeature.AiAssistant)) {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getUpgradeHtml(ProFeature.AiAssistant);
      return;
    }

    await this._initializeWebview(webviewView.webview);
    this._registerWebviewMessageHandler(webviewView.webview);

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

  private async _composeUserTurnPayload(
    message: string,
    attachments?: FileAttachment[],
    mentions?: DbMention[]
  ): Promise<{ fullMessage: string; aiMessage: string }> {
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
    }

    return { fullMessage, aiMessage };
  }

  private async _runAiRequest(aiMessage: string, capability: AiCapability = 'chat'): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const chatSettings = readAiScopeSettings(config, 'chat');
      const provider = chatSettings.provider;
      const modelInfo = await this._aiService.getModelInfo(provider, config, 'chat');
      debugLog('[ChatView] Using AI provider:', provider, 'Model:', modelInfo);

      void this._pushModelCatalogToWebview();

      vscode.window.setStatusBarMessage(`$(sparkle) AI: ${modelInfo}`, 3000);

      this._aiService.setMessages(this._messages);
      let responseText: string;
      let usageInfo: string | undefined;
      const aiStartTime = Date.now();

      debugLog('[ChatView] Calling AI provider:', provider);
      // Reuse the existing customSystemPrompt channel: ChatViewProvider selects the
      // capability-specific prompt; AiService provider methods stay prompt-agnostic.
      const customSystem =
        this._chatSystemPromptMode === 'backup_tools'
          ? buildBackupToolsSystemPrompt({
              connectionDisplayName: this._currentConnectionName,
              databaseName: this._currentDatabase,
              environment: this._currentEnvironment,
              readOnlyMode: this._currentReadOnlyMode
            })
          : this._aiService.buildSystemPrompt(capability);

      const result = await this._aiService.callProvider(provider, aiMessage, config, customSystem, 'chat');
      responseText = result.text;
      usageInfo = result.usage;

      const aiElapsed = ((Date.now() - aiStartTime) / 1000).toFixed(1);
      if (usageInfo) {
        usageInfo = `${usageInfo} · ${aiElapsed}s`;
      } else {
        usageInfo = `${aiElapsed}s`;
      }

      debugLog('[ChatView] AI response received, length:', responseText.length);

      responseText = this._sanitizeResponse(responseText);

      this._messages.push({ role: 'assistant', content: responseText, usage: usageInfo });

      await this._saveCurrentSession();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._messages.push({
        role: 'assistant',
        content: `❌ Error: ${errorMessage}\n\nPlease check your AI provider settings in the extension configuration.`
      });
    }
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

      const user = this._messages[this._messages.length - 1];
      if (!user || user.role !== 'user') {
        return;
      }

      const plain = this._plainPromptFromUserMessage(user);
      const { aiMessage } = await this._composeUserTurnPayload(plain, user.attachments, user.mentions);

      this._updateChatHistory();

      this._setTypingIndicator(true);
      try {
        await this._runAiRequest(aiMessage);
      } finally {
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

      const plain = this._plainPromptFromUserMessage(turn);
      const { aiMessage } = await this._composeUserTurnPayload(plain, turn.attachments, turn.mentions);

      this._updateChatHistory();

      this._setTypingIndicator(true);
      try {
        await this._runAiRequest(aiMessage);
      } finally {
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
      const { fullMessage, aiMessage } = await this._composeUserTurnPayload(message, attachments, mentions);

      this._messages.push({ role: 'user', content: fullMessage, attachments, mentions });
      this._updateChatHistory();

      this._setTypingIndicator(true);
      try {
        await this._runAiRequest(aiMessage, capability);
      } finally {
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

  private async _handleSearchDbObjects(query: string): Promise<void> {
    try {
      const filtered = await this._dbObjectService.searchObjectsAsync(query);

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
    this._getTargetWebview()?.postMessage({
      type: 'updateMessages',
      messages: this._messages
    });
  }

  private _setTypingIndicator(isTyping: boolean): void {
    this._getTargetWebview()?.postMessage({
      type: 'setTyping',
      isTyping
    });
  }

  private async _pushModelCatalogToWebview(): Promise<void> {
    const webview = this._getTargetWebview();
    if (!webview) {
      return;
    }

    const payload = await AiModelCatalogService.getInstance(this._extensionContext).buildChatCatalog();

    webview.postMessage({
      type: 'updateModelCatalog',
      catalog: payload.catalog,
      activeSelectionId: payload.activeSelectionId,
      activeModelLabel: payload.activeModelLabel,
    });

    webview.postMessage({
      type: 'updateModelInfo',
      modelName: payload.activeModelLabel,
    });
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
    this._currentConnectionName = conn?.name ?? params.databaseLabel;
    this._currentDatabase = params.databaseName;
    this._currentEnvironment = conn?.environment;
    this._currentReadOnlyMode = conn?.readOnlyMode === true;
    this._aiService.setConnectionContext({
      environment: this._currentEnvironment,
      readOnlyMode: this._currentReadOnlyMode,
      connectionName: this._currentConnectionName
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
