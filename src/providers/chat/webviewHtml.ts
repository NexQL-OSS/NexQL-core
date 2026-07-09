/**
 * Webview HTML template for Chat View
 */
import * as vscode from 'vscode';
import { MODERN_WEBVIEW_BASE_CSS } from '../../common/htmlStyles';
import { readSharedTemplateCss } from '../../lib/template-loader';

export async function getWebviewHtml(
  webview: vscode.Webview,
  markedUri: vscode.Uri,
  highlightJsUri: vscode.Uri,
  highlightCssUri: vscode.Uri,
  extensionUri: vscode.Uri
): Promise<string> {
  const cspSource = webview.cspSource;
  const nonce = getNonce();

  try {
    // Load template files
    const templatesDir = vscode.Uri.joinPath(extensionUri, 'templates', 'chat');

    const [htmlBuffer, cssBuffer, jsBuffer, themeBuffer, sharedCss] = await Promise.all([
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'index.html')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'styles.css')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'scripts.js')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'theme-detection.js')),
      readSharedTemplateCss(extensionUri)
    ]);

    let html = new TextDecoder().decode(htmlBuffer);
    const css = new TextDecoder().decode(cssBuffer);
    const js = new TextDecoder().decode(jsBuffer);
    const themeDetection = new TextDecoder().decode(themeBuffer);

    // Build CSP string
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data: blob:;`;

    // Replace placeholders
    html = html.replace('{{CSP}}', () => csp);
    html = html.replace('{{HIGHLIGHT_CSS_URI}}', () => highlightCssUri.toString());
    html = html.replace('{{MARKED_URI}}', () => markedUri.toString());
    html = html.replace('{{HIGHLIGHT_JS_URI}}', () => highlightJsUri.toString());
    const inlineStyles = `${MODERN_WEBVIEW_BASE_CSS}\n${sharedCss}\n${css}`;
    html = html.replace('{{INLINE_STYLES}}', () => inlineStyles);
    html = html.replace(/\{\{NONCE\}\}/g, () => nonce);
    html = html.replace('{{THEME_DETECTION_SCRIPT}}', () => themeDetection);
    html = html.replace('{{INLINE_SCRIPTS}}', () => js);

    return html;
  } catch (error) {
    console.error('Failed to load chat templates:', error);
    return `<!DOCTYPE html>
    <html>
    <body>
      <h1>Error loading Chat View</h1>
      <p>Could not load template files. Please check that the extension is installed correctly.</p>
      <p>Error: ${error instanceof Error ? error.message : String(error)}</p>
    </body>
    </html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Keep backward-compatible synchronous version for cases that can't use async
export function getWebviewHtmlSync(
  webview: vscode.Webview,
  markedUri: vscode.Uri,
  highlightJsUri: vscode.Uri,
  highlightCssUri: vscode.Uri
): string {
  // This returns a loading placeholder - async version should be used
  return `<!DOCTYPE html>
  <html>
  <head>
    <style>${MODERN_WEBVIEW_BASE_CSS}</style>
  </head>
  <body style="display: flex; align-items: center; justify-content: center; height: 100vh; font-family: var(--vscode-font-family);">
    <section class="pg-panel" style="width:min(520px,92vw);">
      <div class="pg-panel-body">
        <div class="empty-state-simple">
          <div class="skeleton skeleton-text" style="width: 120px;"></div>
          <div>Loading SQL Assistant (Beta)...</div>
        </div>
      </div>
    </section>
  </body>
  </html>`;
}
