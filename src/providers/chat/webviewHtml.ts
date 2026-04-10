/**
 * Webview HTML template for Chat View
 */
import * as vscode from 'vscode';

export async function getWebviewHtml(
  webview: vscode.Webview,
  markedUri: vscode.Uri,
  highlightJsUri: vscode.Uri,
  highlightCssUri: vscode.Uri,
  extensionUri: vscode.Uri
): Promise<string> {
  const cspSource = webview.cspSource;

  try {
    // Load template files
    const templatesDir = vscode.Uri.joinPath(extensionUri, 'templates', 'chat');

    const [htmlBuffer, cssBuffer, jsBuffer, themeBuffer] = await Promise.all([
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'index.html')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'styles.css')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'scripts.js')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'theme-detection.js'))
    ]);

    let html = new TextDecoder().decode(htmlBuffer);
    const css = new TextDecoder().decode(cssBuffer);
    const js = new TextDecoder().decode(jsBuffer);
    const themeDetection = new TextDecoder().decode(themeBuffer);

    // Build CSP string
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data: blob:;`;

    // Replace placeholders
    html = html.replace('{{CSP}}', csp);
    html = html.replace('{{HIGHLIGHT_CSS_URI}}', highlightCssUri.toString());
    html = html.replace('{{MARKED_URI}}', markedUri.toString());
    html = html.replace('{{HIGHLIGHT_JS_URI}}', highlightJsUri.toString());
    html = html.replace('{{INLINE_STYLES}}', () => css);
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
  <body style="display: flex; align-items: center; justify-content: center; height: 100vh; font-family: var(--vscode-font-family);">
    <div style="text-align: center;">
      <div style="font-size: 24px; margin-bottom: 16px;">????</div>
      <div>Loading chat...</div>
    </div>
  </body>
  </html>`;
}
