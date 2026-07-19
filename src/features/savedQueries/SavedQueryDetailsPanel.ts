import * as vscode from 'vscode';
import { extensionContext } from '../../extension';
import { deleteSavedQueryWithCloudPrompt } from './deleteWithCloudPrompt';
import { loadPanelTemplate } from '../../lib/template-loader';
import { highlightSql } from '../../lib/sqlHighlight';

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
        localResourceRoots: [extensionUri]
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

    void this._update();

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

  private async _update() {
    this._panel.webview.html = await this._getHtmlForWebview(this._panel.webview);
  }

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'highlight.css'),
    );

    const query = this._query;
    const highlightedQuery = highlightSql(query.query);
    const createdDate = new Date(query.createdAt || Date.now()).toLocaleDateString();
    const lastUsedDate = query.lastUsed ? new Date(query.lastUsed).toLocaleDateString() : 'Never';

    const tagsHtml =
      query.tags && query.tags.length > 0
        ? query.tags.map((tag: string) => `<span class="pg-pill">${tag}</span>`).join('')
        : '<span class="no-tags">No tags</span>';

    const descriptionBlock = query.description
      ? `<p class="pg-card-desc">${query.description}</p>`
      : '';

    return loadPanelTemplate(webview, this._extensionUri, 'saved-query-details', {
      HIGHLIGHT_CSS_URI: styleUri.toString(),
      PAGE_TITLE: query.title,
      QUERY_TITLE: query.title,
      DESCRIPTION_BLOCK: descriptionBlock,
      TAGS_HTML: tagsHtml,
      HIGHLIGHTED_QUERY: highlightedQuery,
      CREATED_DATE: createdDate,
      LAST_USED_DATE: lastUsedDate,
      USAGE_COUNT: `${query.usageCount || 0} times`,
      QUERY_ID: query.id,
    });
  }
}
