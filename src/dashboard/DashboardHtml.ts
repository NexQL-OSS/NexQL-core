import * as vscode from 'vscode';
import { DashboardStats } from '../common/types';

export async function getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri, stats: DashboardStats): Promise<string> {
  const nonce = getNonce();
  const cspSource = webview.cspSource;

  try {
    const templatesDir = vscode.Uri.joinPath(extensionUri, 'templates', 'dashboard');
    const [htmlBuffer, cssBuffer, jsBuffer] = await Promise.all([
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'index.html')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'styles.css')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'scripts.js'))
    ]);

    let html = new TextDecoder().decode(htmlBuffer);
    const css = new TextDecoder().decode(cssBuffer);
    const js = new TextDecoder().decode(jsBuffer);

    // Security: Content Security Policy
    const csp = `default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;`;

    const statsJson = JSON.stringify(stats)
      .replace(/&/g, '\\u0026')
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

    html = html.replace('{{CSP}}', () => csp);
    html = html.replace('{{STATS_JSON}}', () => statsJson);
    html = html.replace('{{INLINE_STYLES}}', () => css);
    html = html.replace('{{INLINE_SCRIPTS}}', () => js);
    html = html.replace('{{NONCE}}', () => nonce);

    return html;
  } catch (error) {
    console.error('Failed to load dashboard templates:', error);
    return getErrorHtml(error instanceof Error ? error.message : String(error));
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getErrorHtml(error: string) {
  return `<!DOCTYPE html>
    <html>
        <body style="padding: 20px; color: #f87171; font-family: sans-serif;">
            <h3>Dashboard Error</h3>
            <p>Failed to load dashboard resources.</p>
            <pre>${error}</pre>
        </body>
    </html>`;
}

export function getLoadingHtml(): string {
  return `<!DOCTYPE html>
    <html>
      <head><title>Loading</title></head>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;background-color: var(--vscode-editor-background);color: var(--vscode-editor-foreground);font-family: var(--vscode-font-family);">
        <h3 style="font-weight: normal;">Loading Dashboard...</h3>
      </body>
    </html>`;
}
