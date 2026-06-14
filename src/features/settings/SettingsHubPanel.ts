import * as vscode from 'vscode';
import { MODERN_WEBVIEW_BASE_CSS } from '../../common/htmlStyles';
import { readSharedTemplateCss, getNonce } from '../../lib/template-loader';
import { LicenseService } from '../../services/LicenseService';
import type { SettingsHubMessage, SettingsSectionHandler } from './types';
import { ConnectionsSectionHandler } from './handlers/connections';
import { AiSectionHandler } from './handlers/ai';
import { PreferencesSectionHandler } from './handlers/preferences';
import { SyncSectionHandler } from './handlers/sync';
import { LicenseSectionHandler } from './handlers/license';
import { SentinelSectionHandler } from '../sentinel/SentinelSectionHandler';
import { SentinelThemeSwapService } from '../sentinel/SentinelThemeSwapService';
import { CONNECTION_PLATFORM_PRESETS } from '../../lib/platform/connectionPresets';

export type SettingsHubSection = 'connections' | 'ai' | 'prefs' | 'sentinel' | 'sync' | 'license';

export interface SettingsHubShowOptions {
  section?: SettingsHubSection;
  /** Open the inline edit form for this connection. */
  editConnectionId?: string;
  /** Open the inline form in add mode. */
  addConnection?: boolean;
  /** Launch sync onboarding wizard (`cloud` default path or `advanced`). */
  wizard?: 'cloud' | 'advanced';
  /** Prefill the connection editor from a postgres:// URL. */
  prefillConnectionUrl?: string;
  /** Deep-link sync hub sub-tab. */
  tab?: 'overview' | 'settings' | 'items' | 'preview' | 'conflicts' | 'shares' | 'devices' | 'advanced';
}

const DEFAULT_SECTION: SettingsHubSection = 'connections';

/**
 * Centralized Settings Hub — single webview consolidating connection
 * management, AI settings, preferences, cloud sync, and license status.
 * Host-side logic lives in per-section handlers (`handlers/*`); messages are
 * routed by `<section>/<action>` prefix.
 */
export class SettingsHubPanel {
  public static currentPanel: SettingsHubPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _handlers: Map<string, SettingsSectionHandler>;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    extensionContext: vscode.ExtensionContext,
    private readonly _initialOptions: SettingsHubShowOptions,
    sentinelThemeSwap?: SentinelThemeSwapService,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    const host = {
      extensionContext,
      post: (message: Record<string, unknown>) => {
        void this._panel.webview.postMessage(message);
      },
    };

    this._handlers = new Map<string, SettingsSectionHandler>(
      [
        new ConnectionsSectionHandler(host),
        new AiSectionHandler(host),
        new PreferencesSectionHandler(host),
        new SentinelSectionHandler(host, sentinelThemeSwap ?? new SentinelThemeSwapService(extensionContext)),
        new SyncSectionHandler(host),
        new LicenseSectionHandler(host),
      ].map((h) => [h.section, h]),
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message: SettingsHubMessage) => void this._dispatch(message),
      undefined,
      this._disposables,
    );

    // Tier changes affect both the License section and Cloud Sync gating.
    this._disposables.push(
      LicenseService.getInstance().onDidChangeLicense(() => {
        void this._handlers.get('license')?.handle('load', { command: 'license/load' });
        void this._handlers.get('sync')?.handle('load', { command: 'sync/load' });
      }),
    );

    void this._initialize();
  }

  public static show(
    extensionUri: vscode.Uri,
    extensionContext: vscode.ExtensionContext,
    options: SettingsHubShowOptions = {},
    sentinelThemeSwap?: SentinelThemeSwapService,
  ): void {
    if (SettingsHubPanel.currentPanel) {
      const current = SettingsHubPanel.currentPanel;
      current._panel.reveal(vscode.ViewColumn.One);
      void current._panel.webview.postMessage({
        type: 'hub/navigate',
        section: options.section ?? DEFAULT_SECTION,
        editConnectionId: options.editConnectionId ?? null,
        addConnection: !!options.addConnection,
        wizard: options.wizard ?? null,
        tab: options.tab ?? null,
      });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'settingsHub',
      'PgStudio Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'postgres-vsc-icon.png');

    SettingsHubPanel.currentPanel = new SettingsHubPanel(
      panel,
      extensionUri,
      extensionContext,
      options,
      sentinelThemeSwap,
    );
  }

  private async _dispatch(message: SettingsHubMessage): Promise<void> {
    const command = String(message.command ?? '');
    const slash = command.indexOf('/');
    if (slash <= 0) {
      return;
    }
    const section = command.slice(0, slash);
    const action = command.slice(slash + 1);
    const handler = this._handlers.get(section);
    if (!handler) {
      console.warn(`SettingsHub: no handler for message "${command}"`);
      return;
    }
    try {
      await handler.handle(action, message);
    } catch (err: unknown) {
      void this._panel.webview.postMessage({
        type: `${section}/error`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _initialize(): Promise<void> {
    this._panel.webview.html = await this._getHtmlContent();
  }

  private async _getHtmlContent(): Promise<string> {
    const nonce = getNonce();
    const cspSource = this._panel.webview.cspSource;
    const logoUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'NexQL.png'),
    );

    try {
      const templatesDir = vscode.Uri.joinPath(this._extensionUri, 'templates', 'settings-hub');
      const [htmlBuffer, cssBuffer, jsBuffer, sharedCss] = await Promise.all([
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'index.html')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'styles.css')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(templatesDir, 'scripts.js')),
        readSharedTemplateCss(this._extensionUri),
      ]);

      let html = new TextDecoder().decode(htmlBuffer);
      const css = new TextDecoder().decode(cssBuffer);
      const inlineStyles = `${MODERN_WEBVIEW_BASE_CSS}\n${sharedCss}\n${css}`;
      let js = new TextDecoder().decode(jsBuffer);

      const platformPresets = CONNECTION_PLATFORM_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        hint: preset.hint,
        hostPlaceholder: preset.hostPlaceholder,
        defaults: preset.defaults,
        iconUri: this._panel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(
              this._extensionUri,
              'resources',
              'platform-icons',
              `${preset.icon}.svg`,
            ),
          )
          .toString(),
      }));

      const initialState = JSON.stringify({
        section: this._initialOptions.section ?? DEFAULT_SECTION,
        editConnectionId: this._initialOptions.editConnectionId ?? null,
        addConnection: !!this._initialOptions.addConnection,
        wizard: this._initialOptions.wizard ?? null,
        tab: this._initialOptions.tab ?? null,
        platformPresets,
        prefillConnectionUrl: this._initialOptions.prefillConnectionUrl ?? null,
      });
      js = js.replace(/{{\s*INITIAL_STATE\s*}}/, () => initialState);

      const csp = `default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

      html = html.replace('{{CSP}}', csp);
      html = html.replace('{{INLINE_STYLES}}', () => inlineStyles);
      html = html.replace('{{INLINE_SCRIPTS}}', () => js);
      html = html.replace(/\{\{NONCE\}\}/g, nonce);
      html = html.replace('{{LOGO_URI}}', logoUri.toString());

      return html;
    } catch (error) {
      console.error('Failed to load settings hub templates:', error);
      return `<!DOCTYPE html>
        <html>
        <body>
          <h1>Error loading PgStudio Settings</h1>
          <p>Could not load template files. Please check that the extension is installed correctly.</p>
          <p>Error: ${error instanceof Error ? error.message : String(error)}</p>
        </body>
        </html>`;
    }
  }

  private dispose(): void {
    SettingsHubPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
