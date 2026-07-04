/**
 * Template Loader Utility
 * 
 * Loads HTML/CSS/JS templates from files and processes variable substitution.
 * Supports loading templates with embedded CSS and JS from separate files.
 */
import * as vscode from 'vscode';
import { MODERN_WEBVIEW_BASE_CSS } from '../common/htmlStyles';

interface TemplateVariables {
  [key: string]: string;
}

interface TemplateOptions {
  /** Template folder name (e.g., 'chat', 'ai-settings') */
  folder: string;
  /** CSS file to inline (optional) */
  cssFile?: string;
  /** When true, prepend `templates/shared/styles.css` before folder CSS */
  prependSharedTemplateCss?: boolean;
  /** JS file to inline (optional) */
  jsFile?: string;
  /** Variables to substitute in template */
  variables?: TemplateVariables;
}

/**
 * Load a template file and optionally inject CSS/JS
 */
export async function loadTemplate(
  extensionUri: vscode.Uri,
  templateName: string,
  options: TemplateOptions
): Promise<string> {
  const templatesDir = vscode.Uri.joinPath(extensionUri, 'templates', options.folder);

  // Load main HTML template
  const htmlUri = vscode.Uri.joinPath(templatesDir, `${templateName}.html`);
  let html = await readFileContent(htmlUri);

  // Load and inject CSS if specified
  if (options.cssFile) {
    const cssUri = vscode.Uri.joinPath(templatesDir, options.cssFile);
    let css = await readFileContent(cssUri);
    if (options.prependSharedTemplateCss) {
      const shared = await readSharedTemplateCss(extensionUri);
      css = `${shared}\n${css}`;
    }
    html = html.replace('{{STYLES}}', () => `<style>\n${css}\n</style>`);
  }

  // Load and inject JS if specified
  if (options.jsFile) {
    const jsUri = vscode.Uri.joinPath(templatesDir, options.jsFile);
    const js = await readFileContent(jsUri);
    html = html.replace('{{SCRIPTS}}', () => `<script>\n${js}\n</script>`);
  }

  // Replace variables
  if (options.variables) {
    html = substituteVariables(html, options.variables);
  }

  // Clean up any unreplaced placeholders
  html = html.replace(/\{\{STYLES\}\}/g, '');
  html = html.replace(/\{\{SCRIPTS\}\}/g, '');

  return html;
}

/**
 * Load a complete template with all parts (HTML, CSS, JS)
 */
export async function loadCompleteTemplate(
  extensionUri: vscode.Uri,
  folder: string,
  variables?: TemplateVariables
): Promise<string> {
  return loadTemplate(extensionUri, 'index', {
    folder,
    cssFile: 'styles.css',
    jsFile: 'scripts.js',
    prependSharedTemplateCss: true,
    variables
  });
}

/** Shared design tokens + primitives + components for all `templates/*` webviews. */
export async function readSharedTemplateCss(extensionUri: vscode.Uri): Promise<string> {
  const sharedDir = vscode.Uri.joinPath(extensionUri, 'templates', 'shared');
  const parts: string[] = [];
  for (const file of ['styles.css', 'components.css']) {
    const uri = vscode.Uri.joinPath(sharedDir, file);
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      parts.push(new TextDecoder().decode(buf));
    } catch (error) {
      console.warn(`Shared template CSS not found: ${uri.fsPath}`);
    }
  }
  return parts.join('\n');
}

/**
 * Load a panel template folder (index.html + styles.css + scripts.js) with shared
 * design system, CSP, and nonce — same pattern as BackupRestoreHtml / DashboardHtml.
 */
export async function loadPanelTemplate(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  folder: string,
  variables: TemplateVariables = {},
): Promise<string> {
  const nonce = getNonce();
  const csp = buildCsp(webview, nonce);
  const dir = vscode.Uri.joinPath(extensionUri, 'templates', folder);

  try {
    const [htmlBuf, cssBuf, jsBuf, sharedCss] = await Promise.all([
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'index.html')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'styles.css')),
      vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'scripts.js')),
      readSharedTemplateCss(extensionUri),
    ]);

    let html = new TextDecoder().decode(htmlBuf);
    const panelCss = new TextDecoder().decode(cssBuf);
    const js = new TextDecoder().decode(jsBuf);
    const inlineStyles = `${MODERN_WEBVIEW_BASE_CSS}\n${sharedCss}\n${panelCss}`;

    html = html.replace(/\{\{CSP\}\}/g, () => csp);
    html = html.replace(/\{\{INLINE_STYLES\}\}/g, () => inlineStyles);
    html = html.replace(/\{\{NONCE\}\}/g, () => nonce);
    html = html.replace(/\{\{INLINE_SCRIPTS\}\}/g, () => js);
    html = substituteVariables(html, variables);
    return html;
  } catch (error) {
    console.error(`Failed to load panel template "${folder}":`, error);
    throw error;
  }
}

/**
 * Generate a nonce for Content Security Policy
 */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Get webview URI for a resource
 */
export function getWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  pathSegments: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathSegments));
}

/**
 * Read file content as string
 */
async function readFileContent(uri: vscode.Uri): Promise<string> {
  try {
    const content = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(content);
  } catch (error) {
    console.warn(`Template file not found: ${uri.fsPath}`);
    return '';
  }
}

/**
 * Substitute {{variable}} placeholders with values
 */
function substituteVariables(template: string, variables: TemplateVariables): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(regex, () => value);
  }
  return result;
}

/**
 * Build standard webview options
 */
export function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [extensionUri]
  };
}

/**
 * Build Content Security Policy for webviews
 */
export function buildCsp(webview: vscode.Webview, nonce: string): string {
  return `default-src 'none'; 
    style-src ${webview.cspSource} 'unsafe-inline'; 
    script-src 'nonce-${nonce}'; 
    img-src ${webview.cspSource} https: data:; 
    font-src ${webview.cspSource};`;
}
