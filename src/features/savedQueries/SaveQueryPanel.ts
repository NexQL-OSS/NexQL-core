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
      void SaveQueryPanel.scheduleRemoteCheck(query);
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
    void SaveQueryPanel.scheduleRemoteCheck(query);
  }

  /** Refresh the edit panel after a sync pull applied new query content. */
  public refreshForEdit(query: SavedQuery): void {
    this._editMode = true;
    this._editingQuery = query;
    this._updateForEdit(query);
  }

  private static scheduleRemoteCheck(query: SavedQuery): void {
    void import('../sync/SyncController').then(({ SyncController }) => {
      try {
        SyncController.getInstance().scheduleOpenCheck(query.id, {
          kind: 'query',
          label: query.title,
          onReload: () => {
            const fresh = SavedQueriesService.getInstance().getQuery(query.id);
            if (fresh && SaveQueryPanel.currentPanel) {
              SaveQueryPanel.currentPanel.refreshForEdit(fresh);
            }
          },
        });
      } catch {
        /* sync not initialized */
      }
    });
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
      const { readAiScopeSettings } = await import('../aiAssistant/aiConfig');
      const provider = readAiScopeSettings(config, 'notebook').provider;

      // Check if AI is available
      try {
        await this._aiService.getModelInfo(provider, config, 'notebook');
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
      const result = await this._aiService.callProvider(provider, prompt, config, '', 'notebook');

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
        const titleResult = await this._aiService.callProvider(provider, titlePrompt, config, '', 'notebook');
        const title = titleResult.text.trim().replace(/^["']|["']$/g, '').trim();

        // Generate description
        const descPrompt = `Analyze this SQL query and generate a brief description (1-2 sentences) explaining what it does:\n\n${this._queryText}\n\nRespond with ONLY the description, nothing else.`;
        const descResult = await this._aiService.callProvider(provider, descPrompt, config, '', 'notebook');
        const description = descResult.text.trim().replace(/^["']|["']$/g, '').trim();

        // Generate tags
        const tagsPrompt = `Analyze this SQL query and generate 3-5 relevant tags (single words or short phrases) separated by commas:\n\n${this._queryText}\n\nRespond with ONLY the comma-separated tags, nothing else.`;
        const tagsResult = await this._aiService.callProvider(provider, tagsPrompt, config, '', 'notebook');
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
      try {
        const { SyncController } = await import('../sync/SyncController');
        if (SyncController.getInstance().isItemReadOnly(this._editingQuery.id)) {
          void vscode.window.showWarningMessage('This query is read-only (team viewer access).');
          return;
        }
      } catch {
        /* sync not initialized */
      }
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
      :root { --pg-container-max: 760px; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 20px; }
      .container { max-width: var(--pg-container-max); margin: 0 auto; background: var(--pg-ui-surface-raised, color-mix(in srgb, var(--vscode-input-background) 88%, var(--vscode-editor-background) 12%)); border: 1px solid var(--pg-ui-border, color-mix(in srgb, var(--vscode-widget-border) 65%, transparent)); border-radius: 10px; padding: 20px; box-shadow: 0 6px 18px rgba(0,0,0,0.04); }
      h1 { font-size: 20px; margin-bottom: 6px; }
      .subtitle { color: var(--pg-text-muted, var(--vscode-descriptionForeground)); margin-bottom: 16px; font-size: 13px; }
      .section { margin-bottom: 16px; }
      .pg-field-label { display:block; margin-bottom:6px; font-size:12px; font-weight:600; color:var(--vscode-foreground); }
      .pg-field-hint { font-size:12px; color:var(--pg-text-muted); margin-top:6px; }
      .pg-field-control { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-size:13px; }
      .pg-field-control:focus { outline:none; border-color:var(--vscode-focusBorder); }
      .btn-row { display:flex; gap:12px; margin-top:18px; justify-content:flex-end; }
      .pg-btn { display:inline-flex; align-items:center; gap:8px; padding:8px 14px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; border:none; }
      .pg-btn--primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
      .pg-btn--primary:hover { background:var(--vscode-button-hoverBackground); }
      .pg-btn--secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
      .pg-btn--ghost { background:transparent; border:1px solid var(--pg-ui-border); color:var(--vscode-descriptionForeground); }
      .ai-row { margin-bottom:12px; display:flex; }
      .btn-ai-all { width:100%; justify-content:center; }
      .ai-loading { display:inline-block; width:14px; height:14px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; }
      @keyframes spin { to { transform:rotate(360deg); } }
      .query-preview { font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace); font-size:13px; border-radius:8px; padding:12px; background:var(--pg-ui-surface); border:1px solid var(--vscode-input-border); max-height:260px; overflow:auto; white-space:pre; }
      .info-box { padding:10px 12px; border-radius:8px; background:var(--pg-semantic-info-bg); border:1px solid var(--pg-semantic-info-border); color:var(--vscode-foreground); margin-bottom:12px; }
      @media (max-width:720px) { .container { padding:12px; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>💾 Save Query</h1>
        <p class="subtitle">Save your query to the library for easy reuse</p>

        <div class="info-box">
            📌 Make your queries discoverable by adding meaningful titles, descriptions, and tags
        </div>

        <div class="ai-row">
          <button type="button" class="pg-btn pg-btn--primary btn-ai-all" onclick="generateAll()" id="btnAiAll">
            ✨ Auto-Generate All Fields with AI
          </button>
        </div>

        <form id="saveForm">
            <div class="form-group section">
              <label class="pg-field-label">
                Query Title <span class="required">*</span>
              </label>
              <input 
                class="pg-field-control"
                type="text" 
                id="title" 
                placeholder="e.g., Active Users by Department"
                required
              />
              <div class="pg-field-hint">A memorable name for this query</div>
            </div>

            <div class="form-group section">
              <label class="pg-field-label">Description</label>
              <input 
                class="pg-field-control"
                type="text" 
                id="description" 
                placeholder="What does this query do? e.g., Returns all active users grouped by department with their activity counts"
              />
              <div class="pg-field-hint">Optional: Help your team understand the purpose of this query</div>
            </div>

            <div class="form-group section">
              <label class="pg-field-label">Tags</label>
              <input 
                class="pg-field-control"
                type="text" 
                id="tags" 
                placeholder="e.g., users, active, department, reports"
              />
              <div class="pg-field-hint">Comma-separated tags for easy filtering and discovery</div>
            </div>

            <div class="form-group">
                <label>SQL Query</label>
                <div class="query-preview">${highlightedQuery}</div>
            </div>

            <div class="btn-row">
              <button type="button" class="pg-btn pg-btn--secondary" onclick="cancel()">Cancel</button>
              <button type="submit" class="pg-btn pg-btn--primary">💾 Save Query</button>
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
