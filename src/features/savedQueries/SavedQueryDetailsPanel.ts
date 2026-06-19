import * as vscode from 'vscode';
import { extensionContext } from '../../extension';
import { deleteSavedQueryWithCloudPrompt } from '../sync/localDeletePrompt';

export class SavedQueryDetailsPanel {
  public static currentPanel: SavedQueryDetailsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _query: any;
  private readonly _disposables: vscode.Disposable[] = [];

  public static show(
    extensionUri: vscode.Uri,
    query: any
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SavedQueryDetailsPanel.currentPanel) {
      SavedQueryDetailsPanel.currentPanel._panel.reveal(column);
      SavedQueryDetailsPanel.currentPanel._updateQuery(query);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'savedQueryDetails',
      `📌 ${query.title}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
      }
    );

    SavedQueryDetailsPanel.currentPanel = new SavedQueryDetailsPanel(panel, extensionUri, query);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    query: any
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._query = query;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'copy':
            this._handleCopy();
            return;
          case 'delete':
            this._handleDelete();
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    SavedQueryDetailsPanel.currentPanel = undefined;

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }

    this._panel.dispose();
  }

  private _updateQuery(query: any) {
    this._panel.webview.postMessage({
      command: 'updateQuery',
      query
    });
  }

  private async _handleCopy() {
    await vscode.env.clipboard.writeText(this._query.query);
    vscode.window.showInformationMessage('✓ Query copied to clipboard');
  }

  private async _handleDelete() {
    if (!extensionContext) {
      vscode.window.showErrorMessage('Extension context not available.');
      return;
    }
    const deleted = await deleteSavedQueryWithCloudPrompt(
      extensionContext,
      this._query.id,
      this._query.title,
    );
    if (!deleted) {
      return;
    }
    vscode.window.showInformationMessage(`✓ Query deleted: "${this._query.title}"`);
    this._panel.dispose();
    vscode.commands.executeCommand('postgresExplorer.savedQueries.refresh');
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
  }

  private _highlightSql(sql: string): string {
    const escaped = sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const keywords = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|EXISTS|LIKE|BETWEEN|ORDER|GROUP|BY|HAVING|LIMIT|OFFSET|AS|DISTINCT|UNION|ALL|CREATE|DROP|ALTER|TABLE|VIEW|INDEX|INSERT|UPDATE|DELETE|INTO|VALUES|SET|CASE|WHEN|THEN|ELSE|END|WITH|RECURSIVE|EXPLAIN|ANALYZE)\b/gi;
    const strings = /('([^'\\\\]|\\\\.)*')/g;
    const numbers = /\b(\d+(\.\d+)?|\.\d+)\b/g;
    const comments = /(--.*)|((\/\*)([\s\S]*?)(\*\/))/g;
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

    const query = this._query;
    const highlightedQuery = this._highlightSql(query.query);
    const createdDate = new Date(query.createdAt || Date.now()).toLocaleDateString();
    const lastUsedDate = query.lastUsed ? new Date(query.lastUsed).toLocaleDateString() : 'Never';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${query.title}</title>
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
            max-width: 800px;
            margin: 0 auto;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            gap: 20px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-input-border);
        }

        .title-section h1 {
            font-size: 24px;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }

        .description {
            color: var(--vscode-descriptionForeground);
            font-size: 14px;
            margin-bottom: 12px;
        }

        .tags {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 12px;
        }

        .tag {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
        }

        .actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
        }

        .btn-copy {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-copy:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .btn-delete {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-delete:hover {
            background: var(--vscode-errorBackground);
            color: var(--vscode-errorForeground);
        }

        .section {
            margin-bottom: 28px;
        }

        .section-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .query-code {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 16px;
            font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.6;
            color: var(--vscode-editor-foreground);
            overflow-x: auto;
            white-space: pre;
            max-height: 400px;
            overflow-y: auto;
        }

        /* SQL Syntax Highlighting */
        .query-code .sql-keyword { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); font-weight: 600; }
        .query-code .sql-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
        .query-code .sql-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
        .query-code .sql-comment { color: var(--vscode-symbolIcon-colorForeground, #6a9955); font-style: italic; }
        .query-code .sql-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }

        .meta-info {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            padding: 12px;
            background: var(--vscode-input-background);
            border-radius: 4px;
        }

        .meta-item {
            display: flex;
            flex-direction: column;
        }

        .meta-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            font-weight: 500;
        }

        .meta-value {
            font-size: 13px;
            color: var(--vscode-foreground);
        }

        .no-tags {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title-section">
                <h1>📌 ${query.title}</h1>
                ${query.description ? `<p class="description">${query.description}</p>` : ''}
                <div class="tags">
                    ${query.tags && query.tags.length > 0 
                        ? query.tags.map((tag: string) => `<span class="tag">${tag}</span>`).join('')
                        : '<span class="no-tags">No tags</span>'
                    }
                </div>
            </div>
            <div class="actions">
                <button class="btn-copy" onclick="copy()" title="Copy SQL to clipboard">📋 Copy Query</button>
                <button class="btn-delete" onclick="deleteQuery()" title="Delete this saved query">🗑️ Delete</button>
            </div>
        </div>

        <div class="section">
            <div class="section-title">📝 SQL Query</div>
            <div class="query-code">${highlightedQuery}</div>
        </div>

        <div class="section">
            <div class="section-title">📊 Metadata</div>
            <div class="meta-info">
                <div class="meta-item">
                    <span class="meta-label">Created</span>
                    <span class="meta-value">${createdDate}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Last Used</span>
                    <span class="meta-value">${lastUsedDate}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Usage Count</span>
                    <span class="meta-value">${query.usageCount || 0} times</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Query ID</span>
                    <span class="meta-value" style="font-family: monospace; font-size: 11px;">${query.id}</span>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function copy() {
            vscode.postMessage({ command: 'copy' });
        }

        function deleteQuery() {
            vscode.postMessage({ command: 'delete' });
        }

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'updateQuery') {
                // Update the panel with new query data
                window.location.reload();
            }
        });
    </script>
</body>
</html>`;
  }
}