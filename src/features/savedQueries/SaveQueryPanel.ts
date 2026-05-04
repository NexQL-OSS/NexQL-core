import * as vscode from 'vscode';
import { SqlParser } from '../../providers/kernel/SqlParser';
import { SavedQueriesService, SavedQuery } from './SavedQueriesService';
import { QueryAnalyzer } from '../../services/QueryAnalyzer';
import { AiService } from '../../providers/chat/AiService';

export class SaveQueryPanel {
  public static currentPanel: SaveQueryPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _queryText: string;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _aiService: AiService;
  private _connectionMetadata: any = {};
  private _editMode: boolean = false;
  private _editingQuery: SavedQuery | undefined;

  public static show(
    extensionUri: vscode.Uri,
    queryText: string,
    connectionMetadata?: any,
    context?: vscode.ExtensionContext
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it.
    if (SaveQueryPanel.currentPanel) {
      SaveQueryPanel.currentPanel._panel.reveal(column);
      SaveQueryPanel.currentPanel._updateQuery(queryText);
      if (connectionMetadata) {
        SaveQueryPanel.currentPanel._connectionMetadata = connectionMetadata;
      }
      SaveQueryPanel.currentPanel._editMode = false;
      SaveQueryPanel.currentPanel._editingQuery = undefined;
      return;
    }

    // Otherwise, create a new panel.
    const panel = vscode.window.createWebviewPanel(
      'saveQuery',
      'Save Query',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
      }
    );

    SaveQueryPanel.currentPanel = new SaveQueryPanel(panel, extensionUri, queryText, connectionMetadata);
  }

  public static showForEdit(
    extensionUri: vscode.Uri,
    query: SavedQuery,
    connectionMetadata?: any
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it.
    if (SaveQueryPanel.currentPanel) {
      SaveQueryPanel.currentPanel._panel.reveal(column);
      SaveQueryPanel.currentPanel._editMode = true;
      SaveQueryPanel.currentPanel._editingQuery = query;
      if (connectionMetadata) {
        SaveQueryPanel.currentPanel._connectionMetadata = connectionMetadata;
      }
      SaveQueryPanel.currentPanel._updateForEdit(query);
      return;
    }

    // Otherwise, create a new panel.
    const panel = vscode.window.createWebviewPanel(
      'saveQuery',
      'Edit Query',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
      }
    );

    SaveQueryPanel.currentPanel = new SaveQueryPanel(panel, extensionUri, query.query, connectionMetadata, true, query);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    queryText: string,
    connectionMetadata?: any,
    editMode: boolean = false,
    editingQuery?: SavedQuery
  ) {
    if (connectionMetadata) {
      this._connectionMetadata = connectionMetadata;
    }
    this._editMode = editMode;
    this._editingQuery = editingQuery;
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._queryText = queryText;
    this._aiService = new AiService();

    // Set the webview's initial html content
    this._update();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'save':
            this._handleSaveQuery(message);
            return;
          case 'cancel':
            this._panel.dispose();
            return;
          case 'generateAI':
            this._handleAIGeneration(message.field);
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    SaveQueryPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _updateQuery(queryText: string) {
    // Update the webview with the new query
    this._panel.webview.postMessage({
      command: 'updateQuery',
      query: queryText
    });
  }

  private async _handleAIGeneration(field: 'title' | 'description' | 'tags' | 'all') {
    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const provider = config.get<string>('aiProvider') || 'vscode-lm';
      
      // Check if AI is available
      try {
        await this._aiService.getModelInfo(provider, config);
      } catch (error) {
        this._panel.webview.postMessage({
          command: 'aiError',
          message: 'AI is not configured or available. Please configure your AI provider in settings or fill the fields manually.'
        });
        return;
      }

      // Show progress
      this._panel.webview.postMessage({ command: 'aiGenerating', field });

      // Build prompt based on field
      let prompt = '';
      if (field === 'all' || field === 'title') {
        prompt = `Analyze this SQL query and generate a SHORT, DESCRIPTIVE title (max 6 words):\n\n${this._queryText}\n\nRespond with ONLY the title, nothing else.`;
      } else if (field === 'description') {
        prompt = `Analyze this SQL query and generate a brief description (1-2 sentences) explaining what it does:\n\n${this._queryText}\n\nRespond with ONLY the description, nothing else.`;
      } else if (field === 'tags') {
        prompt = `Analyze this SQL query and generate 3-5 relevant tags (single words or short phrases) separated by commas:\n\n${this._queryText}\n\nRespond with ONLY the comma-separated tags, nothing else. Examples: users, analytics, performance, joins, aggregation`;
      }

      // Call AI
      const result = await this._aiService.callProvider(provider, prompt, config, '');

      // Clean up the response
      let generated = result.text.trim();
      // Remove any markdown code blocks or quotes
      generated = generated.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '');
      generated = generated.replace(/^["']|["']$/g, '');
      generated = generated.trim();

      // For 'all', we need to generate each field separately
      if (field === 'all') {
        // Generate title
        const titlePrompt = `Analyze this SQL query and generate a SHORT, DESCRIPTIVE title (max 6 words):\n\n${this._queryText}\n\nRespond with ONLY the title, nothing else.`;
        const titleResult = await this._aiService.callProvider(provider, titlePrompt, config, '');
        const title = titleResult.text.trim().replace(/^["']|["']$/g, '').trim();

        // Generate description
        const descPrompt = `Analyze this SQL query and generate a brief description (1-2 sentences) explaining what it does:\n\n${this._queryText}\n\nRespond with ONLY the description, nothing else.`;
        const descResult = await this._aiService.callProvider(provider, descPrompt, config, '');
        const description = descResult.text.trim().replace(/^["']|["']$/g, '').trim();

        // Generate tags
        const tagsPrompt = `Analyze this SQL query and generate 3-5 relevant tags (single words or short phrases) separated by commas:\n\n${this._queryText}\n\nRespond with ONLY the comma-separated tags, nothing else.`;
        const tagsResult = await this._aiService.callProvider(provider, tagsPrompt, config, '');
        const tags = tagsResult.text.trim().replace(/^["']|["']$/g, '').trim();

        this._panel.webview.postMessage({
          command: 'aiGenerated',
          field: 'all',
          values: { title, description, tags }
        });
      } else {
        // Send generated value to webview
        this._panel.webview.postMessage({
          command: 'aiGenerated',
          field,
          value: generated
        });
      }

      vscode.window.showInformationMessage('✨ AI suggestions generated!');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._panel.webview.postMessage({
        command: 'aiError',
        message: `Failed to generate AI suggestions: ${errorMessage}. Please fill the fields manually.`
      });
    }
  }

  private async _handleSaveQuery(message: any) {
    const { title, description, tags, query } = message;

    if (!title || !title.trim()) {
      vscode.window.showErrorMessage('Please enter a query title');
      return;
    }

    // Use connection metadata from panel if available, otherwise capture from active notebook
    let connectionId: string | undefined;
    let databaseName: string | undefined;
    let schemaName: string | undefined;

    if (this._connectionMetadata?.connectionId) {
      connectionId = this._connectionMetadata.connectionId;
      databaseName = this._connectionMetadata.databaseName;
      schemaName = this._connectionMetadata.schemaName;
    } else {
      // Fallback to active notebook metadata
      const activeEditor = vscode.window.activeNotebookEditor;
      if (activeEditor) {
        const metadata = activeEditor.notebook.metadata as any;
        connectionId = metadata?.connectionId;
        databaseName = metadata?.databaseName;
        schemaName = metadata?.schema;
      }
    }

    const service = SavedQueriesService.getInstance();

    if (this._editMode && this._editingQuery) {
      // Edit mode: update existing query
      const updatedQuery: SavedQuery = {
        ...this._editingQuery,
        title: title.trim(),
        description: description?.trim() || '',
        query: query,
        tags: tags ? tags.split(',').map((t: string) => t.trim()).filter((t: string) => t) : [],
        lastUsed: Date.now(),
        connectionId,
        databaseName,
        schemaName,
        isTemplate: SqlParser.hasNamedParameters(query)
      };

      await service.updateQuery(updatedQuery);
      vscode.window.showInformationMessage(`✓ Query updated: "${title}"`);
    } else {
      // Save mode: create new query
      const now = Date.now();
      const savedQuery: SavedQuery = {
        id: `query_${now}`,
        title: title.trim(),
        description: description?.trim() || '',
        query: query,
        tags: tags ? tags.split(',').map((t: string) => t.trim()).filter((t: string) => t) : [],
        usageCount: 0,
        createdAt: now,
        lastUsed: now,
        connectionId,
        databaseName,
        schemaName,
        isTemplate: SqlParser.hasNamedParameters(query)
      };

      await service.saveQuery(savedQuery);
      vscode.window.showInformationMessage(`✓ Query saved: "${title}"`);
    }

    this._panel.dispose();

    // Refresh saved queries tree
    vscode.commands.executeCommand('postgresExplorer.savedQueries.refresh');
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
  }

  private _updateForEdit(query: SavedQuery) {
    this._panel.title = `Edit Query: ${query.title}`;
    const html = this._getHtmlForWebview(this._panel.webview);
    this._panel.webview.html = html;
    // Pass edit mode data to webview
    this._panel.webview.postMessage({
      command: 'loadEditData',
      data: {
        title: query.title,
        description: query.description || '',
        tags: (query.tags || []).join(', '),
        query: query.query
      }
    });
  }

  private _highlightSql(sql: string): string {
    const escaped = sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const keywords = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|EXISTS|LIKE|BETWEEN|ORDER|GROUP|BY|HAVING|LIMIT|OFFSET|AS|DISTINCT|UNION|ALL|CREATE|DROP|ALTER|TABLE|VIEW|INDEX|INSERT|UPDATE|DELETE|INTO|VALUES|SET|CASE|WHEN|THEN|ELSE|END|WITH|RECURSIVE|EXPLAIN|ANALYZE)\b/gi;
    const strings = /('([^'\\]|\\.)*')/g;
    const numbers = /\b(\d+(\.\d+)?|\.\d+)\b/g;
    const comments = /(--.*)|(\/\*[\s\S]*?\*\/)/g;
    const functions = /\b([a-z_]\w*)\s*\(/gi;
    
    return escaped
      .replace(comments, '<span class="sql-comment">$&</span>')
      .replace(strings, '<span class="sql-string">$&</span>')
      .replace(keywords, '<span class="sql-keyword">$&</span>')
      .replace(functions, (match, funcName) => `<span class="sql-function">${funcName}</span>(`);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'highlight.css')
    );

    // Highlight query for preview
    const highlightedQuery = this._highlightSql(this._queryText);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Save Query</title>
    <link rel="stylesheet" href="${styleUri}">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 600px;
            margin: 0 auto;
        }

        h1 {
            font-size: 24px;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }

        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 24px;
            font-size: 13px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        label {
            display: block;
            font-weight: 500;
            margin-bottom: 6px;
            color: var(--vscode-foreground);
            font-size: 13px;
        }

        label .required {
            color: var(--vscode-errorForeground);
        }

        input[type="text"],
        textarea {
            width: 100%;
            padding: 10px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
            font-size: 13px;
            border-radius: 4px;
            resize: vertical;
        }

        input[type="text"]:focus,
        textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            background: var(--vscode-input-background);
        }

        textarea {
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
            min-height: 200px;
            max-height: 400px;
            white-space: pre;
        }

        .form-group small {
            display: block;
            margin-top: 4px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .btn-ai-all {
            background: linear-gradient(135deg, var(--vscode-button-background) 0%, var(--vscode-focusBorder) 100%);
            padding: 12px 24px;
            font-size: 14px;
            margin-bottom: 20px;
            width: 100%;
            justify-content: center;
        }

        .btn-ai-all:hover {
            opacity: 0.9;
        }

        .ai-loading {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid var(--vscode-button-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .buttons {
            display: flex;
            gap: 12px;
            margin-top: 30px;
            justify-content: flex-end;
        }

        button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-save {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-save:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .btn-cancel {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-cancel:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .query-preview {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 16px;
            margin-top: 6px;
            font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.6;
            color: var(--vscode-editor-foreground);
            max-height: 200px;
            overflow-y: auto;
            white-space: pre;
            overflow-x: auto;
        }

        /* SQL Syntax Highlighting */
        .query-preview .sql-keyword { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); font-weight: 600; }
        .query-preview .sql-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
        .query-preview .sql-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
        .query-preview .sql-comment { color: var(--vscode-symbolIcon-colorForeground, #6a9955); font-style: italic; }
        .query-preview .sql-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }

        .info-box {
            background: var(--vscode-infoBackground);
            border-left: 3px solid var(--vscode-infoForeground);
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 20px;
            color: var(--vscode-infoForeground);
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>💾 Save Query</h1>
        <p class="subtitle">Save your query to the library for easy reuse</p>

        <div class="info-box">
            📌 Make your queries discoverable by adding meaningful titles, descriptions, and tags
        </div>

        <button type="button" class="btn-ai btn-ai-all" onclick="generateAll()" id="btnAiAll">
            ✨ Auto-Generate All Fields with AI
        </button>

        <form id="saveForm">
            <div class="form-group">
                <label>
                    Query Title <span class="required">*</span>
                </label>
                <input 
                    type="text" 
                    id="title" 
                    placeholder="e.g., Active Users by Department"
                    required
                />
                <small>A memorable name for this query</small>
            </div>

            <div class="form-group">
                <label>Description</label>
                <input 
                    type="text" 
                    id="description" 
                    placeholder="What does this query do? e.g., Returns all active users grouped by department with their activity counts"
                />
                <small>Optional: Help your team understand the purpose of this query</small>
            </div>

            <div class="form-group">
                <label>Tags</label>
                <input 
                    type="text" 
                    id="tags" 
                    placeholder="e.g., users, active, department, reports"
                />
                <small>Comma-separated tags for easy filtering and discovery</small>
            </div>

            <div class="form-group">
                <label>SQL Query</label>
                <div class="query-preview">${highlightedQuery}</div>
            </div>

            <div class="buttons">
                <button type="button" class="btn-cancel" onclick="cancel()">Cancel</button>
                <button type="submit" class="btn-save">💾 Save Query</button>
            </div>
        </form>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let isGenerating = false;

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        function setButtonLoading(loading) {
            const button = document.getElementById('btnAiAll');
            if (loading) {
                button.disabled = true;
                const originalText = button.innerHTML;
                button.setAttribute('data-original-text', originalText);
                button.innerHTML = '<span class="ai-loading"></span> Generating...';
            } else {
                button.disabled = false;
                const originalText = button.getAttribute('data-original-text');
                if (originalText) {
                    button.innerHTML = originalText;
                }
            }
        }

        function generateAll() {
            if (isGenerating) return;
            isGenerating = true;
            setButtonLoading(true);
            vscode.postMessage({ command: 'generateAI', field: 'all' });
        }

        // Listen for messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            
            switch (message.command) {
                case 'aiGenerated':
                    isGenerating = false;
                    document.getElementById('title').value = message.values.title;
                    document.getElementById('description').value = message.values.description;
                    document.getElementById('tags').value = message.values.tags;
                    setButtonLoading(false);
                    break;
                    
                case 'aiError':
                    isGenerating = false;
                    setButtonLoading(false);
                    alert(message.message);
                    break;
                    
                case 'aiGenerating':
                    // Optional: could show which field is being generated
                    break;
            }
        });

        document.getElementById('saveForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const title = document.getElementById('title').value;
            const description = document.getElementById('description').value;
            const tags = document.getElementById('tags').value;
            const query = document.querySelector('.query-preview').textContent;

            vscode.postMessage({
                command: 'save',
                title,
                description,
                tags,
                query
            });
        });
    </script>
</body>
</html>`;
  }
}
