import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { MODERN_WEBVIEW_BASE_CSS } from '../../common/htmlStyles';
import { readSharedTemplateCss } from '../../lib/template-loader';

/**
 * Loads `templates/backup-restore/` (index.html, styles.css, scripts.js), injects shared base CSS,
 * CSP, and script nonce — same pattern as {@link dashboard/DashboardHtml.ts}.
 */
export async function getBackupRestoreHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): Promise<string> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  try {
    const dir = vscode.Uri.joinPath(extensionUri, 'templates', 'backup-restore');
    const [htmlBuf, cssBuf, jsBuf, sharedCss] = await Promise.all([
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'index.html')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'styles.css')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'scripts.js')),
      readSharedTemplateCss(extensionUri)
    ]);

    let html = new TextDecoder().decode(htmlBuf);
    const backupCss = new TextDecoder().decode(cssBuf);
    const js = new TextDecoder().decode(jsBuf);
    const inlineStyles = `${MODERN_WEBVIEW_BASE_CSS}\n${sharedCss}\n${backupCss}`;

    html = html.replace(/\{\{CSP\}\}/g, () => csp);
    html = html.replace(/\{\{INLINE_STYLES\}\}/g, () => inlineStyles);
    html = html.replace(/\{\{NONCE\}\}/g, () => nonce);
    html = html.replace(/\{\{INLINE_SCRIPTS\}\}/g, () => js);
    return html;
  } catch (e) {
    console.error('Failed to load backup-restore templates:', e);
    return getBackupRestoreErrorHtml(e instanceof Error ? e.message : String(e));
  }
}

function getBackupRestoreErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>${MODERN_WEBVIEW_BASE_CSS}</style>
</head>
<body style="padding:16px;color:var(--vscode-errorForeground);font-family:var(--vscode-font-family);">
  <p><strong>Backup &amp; Restore</strong> failed to load webview templates.</p>
  <pre style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(message)}</pre>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
