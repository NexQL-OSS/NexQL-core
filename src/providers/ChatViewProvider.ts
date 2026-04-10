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
  getWebviewHtml
} from './chat';
import { ErrorService } from '../services/ErrorService';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'postgresExplorer.chatView';

  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _isProcessing = false;

  // Phase C: Track current connection/database context for session metadata
  private _currentConnectionName: string | undefined;
  private _currentDatabase: string | undefined;

  // Services
  private _dbObjectService: DbObjectService;
  private _aiService: AiService;
  private _sessionService: SessionService;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    context: vscode.ExtensionContext
  ) {
    this._dbObjectService = new DbObjectService();
    this._aiService = new AiService();
    this._sessionService = new SessionService(context);
  }

  /**
   * Public method to refresh the AI model info display
   * Called when AI settings are changed
   */
  public refreshModelInfo(): void {
    this._updateModelInfo();
  }

  /**
   * Attach a database object to the chat
   * Called from the @ inline button on tree items
   */
  public async attachDbObject(obj: DbObject): Promise<void> {
    // Focus the chat view
    if (this._view) {
      this._view.show(true);
    }

    // Wait a bit for the view to be ready
    await new Promise(resolve => setTimeout(resolve, 200));

    if (!this._view) {
      vscode.window.showWarningMessage('Chat view not available');
      return;
    }

    try {
      // Fetch schema details
      const details = await this._dbObjectService.getObjectSchema(obj);
      const objWithDetails = { ...obj, details };

      // Send to webview
      this._view.webview.postMessage({
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
  public async sendToChat(data: { query: string; results?: string; message: string }): Promise<void> {
    // Wait a bit for the view to be ready after focus
    await new Promise(resolve => setTimeout(resolve, 300));

    if (!this._view) {
      vscode.window.showWarningMessage('Chat view not available. Please open the SQL Assistant panel first.');
      return;
    }

    console.log('[ChatViewProvider] Sending file attachments to webview');

    try {
      const tempDir = os.tmpdir();

      // Create query file
      if (data.query) {
        const queryFileName = `query_${Date.now()}.sql`;
        const queryFilePath = path.join(tempDir, queryFileName);
        await fs.promises.writeFile(queryFilePath, data.query, 'utf8');

        this._view.webview.postMessage({
          type: 'fileAttached',
          file: {
            name: queryFileName,
            content: data.query,
            type: 'sql',
            path: queryFilePath
          }
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

          this._view.webview.postMessage({
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

          this._view.webview.postMessage({
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

      // Show toast in chat to let user know files are attached
      vscode.window.showInformationMessage('Query and results attached to chat. Add your question and send!');

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

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Send URI for marked.js and highlight.js
    const markedUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'marked.min.js'));
    const highlightJsUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'highlight.min.js'));
    const highlightCssUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'highlight.css'));

    webviewView.webview.html = await getWebviewHtml(webviewView.webview, markedUri, highlightJsUri, highlightCssUri, this._extensionUri);

    // Send initial history and model info
    setTimeout(() => {
      this._sendHistoryToWebview();
      this._updateModelInfo();
    }, 100);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this._handleUserMessage(data.message, data.attachments, data.mentions);
          break;
        case 'clearChat':
          this._messages = [];
          this._sessionService.clearCurrentSession();
          this._updateChatHistory();
          break;
        case 'newChat':
          await this._saveCurrentSession();
          this._messages = [];
          this._sessionService.clearCurrentSession();
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
          console.log('[ChatView] Received deleteSession request for:', data.sessionId);
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
        case 'openInNotebook':
          await this._handleOpenInNotebook(data.code);
          break;
        case 'previewFile':
          await this._handlePreviewFile(data.path, data.name);
          break;
      }
    });
  }

  // ==================== Message Handling ====================

  private async _handleUserMessage(message: string, attachments?: FileAttachment[], mentions?: DbMention[]) {
    if (this._isProcessing) {
      return;
    }

    this._isProcessing = true;

    console.log('[ChatView] ========== HANDLING USER MESSAGE ==========');
    console.log('[ChatView] Message:', message);
    console.log('[ChatView] Attachments:', attachments?.length || 0);
    console.log('[ChatView] Mentions:', mentions?.length || 0);
    if (mentions && mentions.length > 0) {
      console.log('[ChatView] Mention details:', JSON.stringify(mentions, null, 2));
    }

    // Build message with attachments
    // For display (history), we only show links/names to keep UI clean
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

    // For AI (current turn), we need the full content
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

    // Process @ mentions - add schema context for AI
    // aiMessage already has attachments, now add schema context
    if (mentions && mentions.length > 0) {
      console.log('[ChatView] Processing mentions for schema context...');
      
      // Phase C: Capture connection context from first mention
      if (mentions[0]) {
        this._currentDatabase = mentions[0].database;
        // Note: connectionName might not be populated in DbMention, so we use connectionId as fallback
        this._currentConnectionName = mentions[0].breadcrumb?.split('.')[0] || mentions[0].connectionId;
        this._sendContextUpdate();
      }
      
      let schemaContext = '\n\n=== DATABASE SCHEMA CONTEXT (Use this information to answer the question) ===\n';

      for (const mention of mentions) {
        console.log('[ChatView] Fetching schema for:', mention.schema + '.' + mention.name, 'type:', mention.type, 'connectionId:', mention.connectionId);
        const obj: DbObject = {
          name: mention.name,
          type: mention.type,
          schema: mention.schema,
          database: mention.database,
          connectionId: mention.connectionId,
          connectionName: '',
          breadcrumb: mention.breadcrumb
        };

        try {
          const schemaInfo = await this._dbObjectService.getObjectSchema(obj);
          mention.schemaInfo = schemaInfo;
          schemaContext += `\n### ${mention.type.toUpperCase()}: ${mention.schema}.${mention.name}\n`;
          schemaContext += schemaInfo;
          schemaContext += '\n';
          console.log('[ChatView] Added schema context for:', mention.schema + '.' + mention.name);
          console.log('[ChatView] Schema info received:', schemaInfo.substring(0, 500) + '...');
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          console.error('[ChatView] Failed to get schema for mention:', mention.name, e);

          // Notify user about the error
          this._view?.webview.postMessage({
            type: 'schemaError',
            object: `${mention.schema}.${mention.name}`,
            error: errorMsg
          });

          // Still add a note in context so AI knows there was an issue
          schemaContext += `\n### ${mention.type.toUpperCase()}: ${mention.schema}.${mention.name}\n`;
          schemaContext += `[Schema could not be retrieved: ${errorMsg}]\n`;
        }
      }

      schemaContext += '\n=== END DATABASE SCHEMA CONTEXT ===\n\n';

      // Prepend schema context to the message so AI sees it first
      aiMessage = schemaContext + fullMessage;
      console.log('[ChatView] AI message with schema context length:', aiMessage.length);
      console.log('[ChatView] ========== FULL AI MESSAGE ==========');
      console.log(aiMessage);
      console.log('[ChatView] ========== END FULL AI MESSAGE ==========');
    }

    // Add user message to history
    this._messages.push({ role: 'user', content: fullMessage, attachments, mentions });
    this._updateChatHistory();

    // Show typing indicator
    this._setTypingIndicator(true);

    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const provider = config.get<string>('aiProvider') || 'vscode-lm';
      const modelInfo = await this._aiService.getModelInfo(provider, config);
      console.log('[ChatView] Using AI provider:', provider, 'Model:', modelInfo);

      // Update model info in UI
      this._updateModelInfo();

      // Show model info to user
      vscode.window.setStatusBarMessage(`$(sparkle) AI: ${modelInfo}`, 3000);

      this._aiService.setMessages(this._messages);
      let responseText: string;
      let usageInfo: string | undefined;
      const aiStartTime = Date.now();

      if (provider === 'vscode-lm') {
        console.log('[ChatView] Calling VS Code LM API...');
        const result = await this._aiService.callVsCodeLm(aiMessage, config);
        responseText = result.text;
        usageInfo = result.usage;
      } else {
        console.log('[ChatView] Calling direct API:', provider);
        const result = await this._aiService.callDirectApi(provider, aiMessage, config);
        responseText = result.text;
        usageInfo = result.usage;
      }

      const aiElapsed = ((Date.now() - aiStartTime) / 1000).toFixed(1);
      if (usageInfo) {
        usageInfo = `${usageInfo} · ${aiElapsed}s`;
      } else {
        usageInfo = `${aiElapsed}s`;
      }

      console.log('[ChatView] AI response received, length:', responseText.length);

      // Sanitize response - remove any HTML-like patterns that shouldn't be there
      // This prevents the model from learning bad patterns from previous responses
      responseText = this._sanitizeResponse(responseText);

      this._messages.push({ role: 'assistant', content: responseText, usage: usageInfo });

      await this._saveCurrentSession();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._messages.push({
        role: 'assistant',
        content: `❌ Error: ${errorMessage}\n\nPlease check your AI provider settings in the extension configuration.`
      });
    } finally {
      this._setTypingIndicator(false);
      this._updateChatHistory();
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
      console.log('[ChatView] Sanitized AI response - removed HTML artifacts');
    }

    return cleaned;
  }

  // ==================== Database Objects ====================

  private async _handleSearchDbObjects(query: string): Promise<void> {
    try {
      const filtered = await this._dbObjectService.searchObjectsAsync(query);

      this._view?.webview.postMessage({
        type: 'dbObjectsResult',
        objects: filtered
      });
    } catch (error) {
      this._view?.webview.postMessage({
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
      this._view?.webview.postMessage({
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
      this._view?.webview.postMessage({
        type: 'dbObjectsResult',
        objects: objects
      });
    } catch (error) {
      this._view?.webview.postMessage({
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

      this._view?.webview.postMessage({
        type: 'dbHierarchyData',
        path: path,
        items: items
      });

    } catch (error) {
      console.error('Error fetching hierarchy:', error);
      this._view?.webview.postMessage({
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

        this._view?.webview.postMessage({
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
        this._view?.webview.postMessage({
          type: 'notebookResult',
          success: true
        });
      } else {
        // No active notebook - send error back to webview
        this._view?.webview.postMessage({
          type: 'notebookResult',
          success: false,
          error: 'Open notebook first'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._view?.webview.postMessage({
        type: 'notebookResult',
        success: false,
        error: errorMessage
      });
    }
  }

  // ==================== Session Management ====================

  private async _saveCurrentSession(): Promise<void> {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const provider = config.get<string>('aiProvider') || 'vscode-lm';

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
      this._updateChatHistory();
    }
  }

  private async _deleteSession(sessionId: string): Promise<void> {
    console.log('[ChatView] _deleteSession called with:', sessionId);
    const wasCurrentSession = await this._sessionService.deleteSession(sessionId);
    console.log('[ChatView] Session deleted, wasCurrentSession:', wasCurrentSession);

    if (wasCurrentSession) {
      this._messages = [];
      this._updateChatHistory();
    }

    console.log('[ChatView] Sending updated history to webview...');
    this._sendHistoryToWebview();
  }

  private _sendHistoryToWebview(): void {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'updateHistory',
        sessions: this._sessionService.getSessionSummaries()
      });
    }
  }

  // Phase C: Send context bar update to webview
  private _sendContextUpdate(): void {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'contextUpdate',
        connectionName: this._currentConnectionName || null,
        database: this._currentDatabase || null
      });
    }
  }

  // ==================== UI Helpers ====================

  private _updateChatHistory(): void {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'updateMessages',
        messages: this._messages
      });
    }
  }

  private _setTypingIndicator(isTyping: boolean): void {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'setTyping',
        isTyping
      });
    }
  }

  private async _updateModelInfo(): Promise<void> {
    if (this._view) {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const provider = config.get<string>('aiProvider') || 'vscode-lm';
      const modelInfo = await this._aiService.getModelInfo(provider, config);

      this._view.webview.postMessage({
        type: 'updateModelInfo',
        modelName: modelInfo
      });
    }
  }

  public async handleExplainError(error: string, query: string): Promise<void> {
    const prompt = `I ran this SQL query:\n\`\`\`sql\n${query}\n\`\`\`\n\nI got this error:\n${error}\n\nCan you explain why this error occurred and how to fix it? Provide the corrected SQL query.`;
    await this._handleUserMessage(prompt);
  }

  public async handleFixQuery(error: string, query: string): Promise<void> {
    const prompt = `Fix this SQL query which caused an error:\n\nQuery:\n\`\`\`sql\n${query}\n\`\`\`\n\nError:\n${error}\n\nPlease provide only the corrected SQL code and a brief explanation.`;
    await this._handleUserMessage(prompt);
  }

  public async handleAnalyzeData(dataCsv: string, query: string, totalRows: number): Promise<void> {
    try {
      // Create temp file for the data
      const tempDir = os.tmpdir();
      const fileName = `analysis_${Date.now()}.csv`;
      const filePath = path.join(tempDir, fileName);

      await fs.promises.writeFile(filePath, dataCsv, 'utf8');

      const prompt = `I ran this query:\n\`\`\`sql\n${query}\n\`\`\`\n\nIt returned ${totalRows} rows. I have attached the data as a CSV file.\n\nPlease analyze this data. Look for patterns, outliers, or interesting insights. Summarize what this data represents.`;

      // Send with attachment
      await this._handleUserMessage(prompt, [{
        name: fileName,
        content: dataCsv,
        type: 'csv',
        path: filePath
      }]);
    } catch (error) {
      console.error('Failed to create temp file for analysis:', error);
      ErrorService.getInstance().showError('Failed to prepare data for analysis. Using inline data instead.');
      // Fallback to old behavior if file writing fails
      const prompt = `I ran this query:\n\`\`\`sql\n${query}\n\`\`\`\n\nIt returned ${totalRows} rows. Here is the data:\n\n${dataCsv}\n\nPlease analyze this data.`;
      await this._handleUserMessage(prompt);
    }
  }

  public async handleOptimizeQuery(query: string, executionTime?: number): Promise<void> {
    const timeInfo = executionTime ? `The query took ${executionTime.toFixed(3)}ms to execute.` : '';
    const prompt = `I want to optimize this SQL query:\n\`\`\`sql\n${query}\n\`\`\`\n\n${timeInfo}\n\nPlease help me optimize this.\n\n1. First, provide the SQL command to run \`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)\` (or best equivalent) for this query so I can get the execution plan.\n2. Then, provide any immediate optimization suggestions you can spot just by looking at the query structure (e.g., missing indexes, N+1 issues, unnecessary joins).\n\nWait for me to run the EXPLAIN command and paste the results before doing a deep dive.`;
    await this._handleUserMessage(prompt);
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

    await this._handleUserMessage(prompt);
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

    await this._handleUserMessage(prompt);
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

    await this._handleUserMessage(prompt);
  }
}
