import * as vscode from 'vscode';
import { SqlParser } from '../../providers/kernel/SqlParser';
import { SavedQueriesService, SavedQuery } from './SavedQueriesService';
import { loadPanelTemplate } from '../../lib/template-loader';
import { highlightSql } from '../../lib/sqlHighlight';
import { getAiService } from '../../services/chatViewRegistry';

export class SaveQueryPanel {
  public static currentPanel: SaveQueryPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _queryText: string;
  private readonly _disposables: vscode.Disposable[] = [];
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
        localResourceRoots: [extensionUri]
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
        localResourceRoots: [extensionUri]
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

    // Set the webview's initial html content
    void this._update();

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
      const aiService = getAiService();
      if (!aiService) {
        this._panel.webview.postMessage({
          command: 'aiError',
          message: 'AI Assistant is premium-only or not initialized. Please active NexQL Pro or fill the fields manually.'
        });
        return;
      }

      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const provider = config.get<string>('ai.notebook.provider') || config.get<string>('aiProvider') || 'nexql-free';

      // Check if AI is available
      try {
        await aiService.getModelInfo(provider, config, 'notebook');
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
      const result = await aiService.callProvider(provider, prompt, config, '', 'notebook');

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
        const titleResult = await aiService.callProvider(provider, titlePrompt, config, '', 'notebook');
        const title = titleResult.text.trim().replace(/^["']|["']$/g, '').trim();

        // Generate description
        const descPrompt = `Analyze this SQL query and generate a brief description (1-2 sentences) explaining what it does:\n\n${this._queryText}\n\nRespond with ONLY the description, nothing else.`;
        const descResult = await aiService.callProvider(provider, descPrompt, config, '', 'notebook');
        const description = descResult.text.trim().replace(/^["']|["']$/g, '').trim();

        // Generate tags
        const tagsPrompt = `Analyze this SQL query and generate 3-5 relevant tags (single words or short phrases) separated by commas:\n\n${this._queryText}\n\nRespond with ONLY the comma-separated tags, nothing else.`;
        const tagsResult = await aiService.callProvider(provider, tagsPrompt, config, '', 'notebook');
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

  private async _update() {
    this._panel.webview.html = await this._getHtmlForWebview(this._panel.webview);
  }

  private async _updateForEdit(query: SavedQuery) {
    this._panel.title = `Edit Query: ${query.title}`;
    const html = await this._getHtmlForWebview(this._panel.webview);
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

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'highlight.css'),
    );
    const highlightedQuery = highlightSql(this._queryText);
    const isEdit = this._editMode;

    return loadPanelTemplate(webview, this._extensionUri, 'saved-query-form', {
      HIGHLIGHT_CSS_URI: styleUri.toString(),
      PAGE_TITLE: isEdit ? 'Edit Query' : 'Save Query',
      HEADING: isEdit ? '✏️ Edit Query' : '💾 Save Query',
      SUBTITLE: isEdit
        ? 'Update your saved query metadata and content'
        : 'Save your query to the library for easy reuse',
      HIGHLIGHTED_QUERY: highlightedQuery,
      SAVE_LABEL: isEdit ? '💾 Update Query' : '💾 Save Query',
    });
  }
}
