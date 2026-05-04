
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** Internal id for {@link vscode.window.createWebviewPanel} (not a sidebar view). */
const WHATS_NEW_PANEL_VIEW_TYPE = 'postgresExplorer.whatsNew';

export class WhatsNewManager {
  private static readonly globalStateKey = 'postgres-explorer.lastRunVersion';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri
  ) { }

  public async checkAndShow(manual: boolean = false): Promise<void> {
    const currentVersion = this.context.extension.packageJSON.version;
    const lastRunVersion = this.context.globalState.get<string>(WhatsNewManager.globalStateKey);

    if (manual || currentVersion !== lastRunVersion) {
      await this.showWhatsNew(currentVersion);
      await this.context.globalState.update(WhatsNewManager.globalStateKey, currentVersion);
    }
  }

  private async showWhatsNew(version: string): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    const panel = vscode.window.createWebviewPanel(
      WHATS_NEW_PANEL_VIEW_TYPE,
      `What's New in PgStudio ${version}`,
      column,
      {
        enableScripts: true,
        enableCommandUris: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'resources'),
          vscode.Uri.joinPath(this.extensionUri, 'out')
        ]
      }
    );

    panel.webview.html = await this.getWebviewContent(panel.webview, version);

    const messageSub = panel.webview.onDidReceiveMessage(async (message: { type?: string; command?: string }) => {
      if (message?.type !== 'runCommand' || typeof message.command !== 'string') {
        return;
      }
      if (!message.command.startsWith('postgres-explorer.')) {
        return;
      }
      await vscode.commands.executeCommand(message.command);
    });
    panel.onDidDispose(() => messageSub.dispose());
  }

  private async getWebviewContent(webview: vscode.Webview, version: string): Promise<string> {
    const changelogContent = await this.getChangelogContent();
    const logoPath = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'postgres-explorer.png'));
    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'marked.min.js'));
    const highlightScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'highlight.min.js'));
    const highlightCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'highlight.css'));

    const encodedChangelog = Buffer.from(changelogContent).toString('base64');

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>What's New in PgStudio</title>
        <link rel="stylesheet" href="${highlightCssUri}">
        <script src="${markedUri}"></script>
        <script src="${highlightScriptUri}"></script>
        <style>
          /* Editor font + system/emoji fonts so changelog Unicode and emoji render reliably (GFM is default in marked). */
          body {
            font-family: var(--vscode-font-family), system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif,
              "Segoe UI Emoji", "Segoe UI Symbol", "Apple Color Emoji", "Noto Color Emoji", emoji;
            padding: 20px;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            font-size: 1em;
          }
          h1, h2, h3 {
            color: var(--vscode-textLink-foreground);
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 0.3em;
          }
          h1 { font-size: 2em; margin-top: 0; }
          h2 { font-size: 1.5em; margin-top: 1.5em; }
          h3 { font-size: 1.25em; margin-top: 1em; color: var(--vscode-editor-foreground); border-bottom: none; }

          .header {
            display: flex;
            align-items: center;
            margin-bottom: 2rem;
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 1rem;
            flex-direction: row;
            text-align: left;
          }
          .logo {
            width: 64px;
            height: 64px;
            margin-right: 1.5rem;
            margin-bottom: 0;
          }
          .version-badge {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 0.2rem 0.5rem;
            border-radius: 4px;
            font-size: 0.9em;
            margin-left: 1rem;
            vertical-align: middle;
          }

          .content {
            margin-top: 1rem;
          }
          .content a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
          }
          .content a:hover {
            text-decoration: underline;
          }
          .content code {
            font-family: var(--vscode-editor-font-family);
            background-color: var(--vscode-textBlockQuote-background);
            padding: 2px 4px;
            border-radius: 3px;
          }
          .content pre {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 1rem;
            overflow-x: auto;
            border-radius: 4px;
          }
          .content pre code {
            background-color: transparent;
            padding: 0;
          }
          .content blockquote {
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            margin: 0;
            padding-left: 1rem;
            color: var(--vscode-descriptionForeground);
          }
          .content ul, .content ol {
            padding-left: 2rem;
          }
          .content li {
            margin-bottom: 0.5rem;
          }
          .content li.task-list-item,
          .content li:has(> input[type="checkbox"]:first-child) {
            list-style-type: none;
            margin-left: -1.25rem;
          }
          .content input[type="checkbox"] {
            margin-right: 0.5rem;
            vertical-align: middle;
            pointer-events: none;
            accent-color: var(--vscode-textLink-foreground);
          }
          .content hr {
            border: none;
            border-top: 1px solid var(--vscode-widget-border);
            margin: 1.5rem 0;
          }
          .content table {
            border-collapse: collapse;
            width: 100%;
            margin: 1rem 0;
            font-size: 0.95em;
          }
          .content th, .content td {
            border: 1px solid var(--vscode-widget-border);
            padding: 0.45rem 0.65rem;
            text-align: left;
          }
          .content thead th {
            background-color: var(--vscode-editor-lineHighlightBackground, var(--vscode-textBlockQuote-background));
            font-weight: 600;
          }
          .content img {
            max-width: 100%;
            height: auto;
            vertical-align: middle;
          }
          .content del { opacity: 0.9; }
          /* Theme-aware code blocks: base from VS Code; highlight.js classes keep token contrast. */
          .content pre code.hljs {
            background: transparent !important;
            color: var(--vscode-editor-foreground) !important;
          }
          .content pre:has(> code.hljs) {
            background-color: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-widget-border);
          }
          .content .hljs-comment,
          .content .hljs-quote { color: var(--vscode-descriptionForeground) !important; }
          .content .hljs-keyword,
          .content .hljs-selector-tag,
          .content .hljs-meta .hljs-keyword { color: var(--vscode-symbolIcon-keywordForeground, #569cd6) !important; }
          .content .hljs-string,
          .content .hljs-meta .hljs-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178) !important; }
          .content .hljs-number,
          .content .hljs-literal { color: var(--vscode-symbolIcon-numberForeground, #b5cea8) !important; }
          .content .hljs-title,
          .content .hljs-section { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa) !important; }
          .content .hljs-built_in,
          .content .hljs-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0) !important; }

          .footer {
            margin-top: 3rem;
            padding-top: 1rem;
            border-top: 1px solid var(--vscode-widget-border);
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <img src="${logoPath}" alt="PgStudio Logo" class="logo">
          <div>
            <h1>PgStudio <span class="version-badge">v${version}</span></h1>
            <p>Thanks for using PgStudio! Here are the latest updates.</p>
          </div>
        </div>

        <div id="markdown-content" class="content"></div>

        <div class="footer">
          <p>
            <a href="https://github.com/dev-asterix/PgStudio/issues">Report Issue</a> |
            <a href="https://github.com/dev-asterix/PgStudio">GitHub Repository</a>
          </p>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          const rawContent = "${encodedChangelog}";
          /** atob() yields one char per byte; markdown is UTF-8 — must decode bytes to Unicode or em dashes etc. become mojibake (â). */
          function base64ToUtf8(b64) {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            return new TextDecoder('utf-8').decode(bytes);
          }
          const decodedContent = base64ToUtf8(rawContent);
          const parseOpts = { async: false, breaks: true, gfm: true };
          document.getElementById('markdown-content').innerHTML = marked.parse(decodedContent, parseOpts);
          if (typeof hljs !== 'undefined' && typeof hljs.highlightElement === 'function') {
            document.querySelectorAll('#markdown-content pre code').forEach(function (block) {
              try {
                hljs.highlightElement(block);
              } catch (e) {
                console.warn('[PgStudio WhatsNew] code highlight skipped', e);
              }
            });
          }

          /** Resolve command id from href; packaged webviews may resolve command: as relative to a repo base URL. */
          function commandIdFromHref(href) {
            if (!href) return null;
            const i = href.indexOf('command:');
            if (i < 0) return null;
            let id = href.slice(i + 'command:'.length).split(/[?#]/)[0];
            id = decodeURIComponent(id);
            return id || null;
          }

          document.getElementById('markdown-content').addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('a');
            if (!a) return;
            const href = a.getAttribute('href');
            const command = commandIdFromHref(href);
            if (!command || !command.startsWith('postgres-explorer.')) return;
            e.preventDefault();
            vscode.postMessage({ type: 'runCommand', command });
          });
        </script>
      </body>
      </html>
    `;
  }

  private async getChangelogContent(): Promise<string> {
    const variants = ['CHANGELOG.md', 'changelog.md', 'Changelog.md'];

    for (const variant of variants) {
      try {
        const changelogPath = path.join(this.extensionUri.fsPath, variant);
        return await fs.promises.readFile(changelogPath, 'utf8');
      } catch {
        // Try next variant
      }
    }

    let files: string[] = [];
    try {
      files = await fs.promises.readdir(this.extensionUri.fsPath);
    } catch {
      files = ['(unable to list directory)'];
    }

    return `# Error\nUnable to load CHANGELOG.md\n\nExtension path: \`${this.extensionUri.fsPath}\`\n\nFiles in extension root:\n${files.map(f => `- ${f}`).join('\n')}`;
  }
}
