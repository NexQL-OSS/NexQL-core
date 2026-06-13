import * as vscode from 'vscode';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { TelemetryService } from '../../services/TelemetryService';
import type { NotebookStatusBar } from '../../activation/statusBar';
import { environmentIcon, environmentLabel, SENTINEL_PROD_TOUR_KEY } from './constants';
import { NotebookContextStripService } from './NotebookContextStripService';
import { SentinelAccentService } from './SentinelAccentService';
import { SentinelThemeSwapService } from './SentinelThemeSwapService';
import type { SentinelTabDecorationProvider } from './SentinelTabDecorationProvider';
import type { SentinelContext, SentinelEnvironment, SentinelSettings } from './types';

function isSentinelEnvironment(value: unknown): value is SentinelEnvironment {
  return value === 'production' || value === 'staging' || value === 'development';
}

export type SentinelContextListener = (context: SentinelContext | null) => void;

/**
 * Orchestrates Sentinel layers: activation gate, transitions, status bar accents,
 * chrome overlay, theme swap, and notebook context strip.
 */
export class SentinelContextService implements vscode.Disposable {
  private lastEnvironment: SentinelEnvironment | undefined;
  private lastContext: SentinelContext | null = null;
  private lastTaggedContext: SentinelContext | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly contextListeners = new Set<SentinelContextListener>();
  private statusBar: NotebookStatusBar | undefined;
  private tabDecorations: SentinelTabDecorationProvider | undefined;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly accentService: SentinelAccentService,
    private readonly themeSwapService: SentinelThemeSwapService,
    private readonly stripService: NotebookContextStripService,
  ) {
    const sync = () => void this.sync();
    this.disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor(sync),
      vscode.window.onDidChangeActiveTextEditor(sync),
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (NotebookContextStripService.isMutating(e.notebook.uri)) {
          this.tabDecorations?.refresh();
          return;
        }
        const isActive = vscode.window.activeNotebookEditor?.notebook === e.notebook;
        if (isActive && e.metadata !== undefined) {
          sync();
        }
        this.tabDecorations?.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('postgresExplorer.sentinel')) {
          sync();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => void this.sync()),
    );
  }

  attachStatusBar(statusBar: NotebookStatusBar): void {
    this.statusBar = statusBar;
    void this.sync();
  }

  attachTabDecorations(provider: SentinelTabDecorationProvider): void {
    this.tabDecorations = provider;
  }

  onDidChangeContext(listener: SentinelContextListener): vscode.Disposable {
    this.contextListeners.add(listener);
    listener(this.lastContext);
    return new vscode.Disposable(() => this.contextListeners.delete(listener));
  }

  getLastContext(): SentinelContext | null {
    return this.lastContext;
  }

  /** Active gated context, or the last tagged notebook context for ambient chat signaling. */
  getChatContext(): SentinelContext | null {
    const settings = this.readSettings();
    if (!settings.enabled || !settings.chatEnvChip) {
      return null;
    }
    return this.resolveContext() ?? this.lastTaggedContext;
  }

  resolveContext(): SentinelContext | null {
    if (!this.readSettings().enabled) {
      return null;
    }

    const editor = ConnectionUtils.getActivePostgresNotebook();
    if (!editor) {
      return null;
    }

    const metadata = ConnectionUtils.getEffectiveMetadata(editor.notebook.metadata);
    const connection = ConnectionUtils.findConnectionWithFallback(metadata?.connectionId, editor.notebook.metadata);
    if (!metadata?.connectionId || !connection || !isSentinelEnvironment(connection.environment)) {
      return null;
    }

    return {
      environment: connection.environment,
      connectionId: connection.id,
      connectionName: connection.name || connection.host || 'Unknown',
      database: metadata.databaseName || connection.database || 'default',
      username: connection.username || metadata.username || '',
      host: connection.host,
      port: Number(connection.port) || 5432,
      readOnlyMode: !!connection.readOnlyMode,
    };
  }

  readSettings(): SentinelSettings {
    const config = vscode.workspace.getConfiguration('postgresExplorer.sentinel');
    return {
      enabled: config.get<boolean>('enabled', true),
      statusBarAccent: config.get<boolean>('statusBarAccent', true),
      notebookContextStrip: config.get<boolean>('notebookContextStrip', true),
      chromeAccent: config.get<boolean>('chromeAccent', true),
      tabBadges: config.get<boolean>('tabBadges', true),
      chatEnvChip: config.get<boolean>('chatEnvChip', true),
      notifyOnTransition: config.get<boolean>('notifyOnTransition', false),
      themeSwapEnabled: config.get<boolean>('themeSwap.enabled', false),
      themeSwapMode: config.get<'suggest' | 'auto'>('themeSwap.mode', 'suggest'),
      themeSwapThemes: config.get<Record<string, string>>('themeSwap.themes', {}),
    };
  }

  async sync(): Promise<void> {
    const settings = this.readSettings();
    const context = settings.enabled ? this.resolveContext() : null;
    const prevEnvironment = this.lastEnvironment;

    this.statusBar?.applySentinel(context, settings);
    this.statusBar?.update();

    if (!context || !settings.chromeAccent) {
      await this.accentService.restore();
    } else {
      await this.accentService.apply(context.environment);
    }

    await this.handleThemeSwap(context, settings, prevEnvironment);

    const editor = ConnectionUtils.getActivePostgresNotebook();
    await this.stripService.sync(editor, context);

    this.maybeNotifyTransition(context?.environment, settings.notifyOnTransition, prevEnvironment);
    this.maybeProdTour(context);
    this.trackGateEvents(context, prevEnvironment);

    if (context) {
      this.lastTaggedContext = context;
    }

    this.lastEnvironment = context?.environment;
    this.lastContext = context;
    this.tabDecorations?.refresh();
    this.notifyContextListeners(context);
  }

  private async handleThemeSwap(
    context: SentinelContext | null,
    settings: SentinelSettings,
    prevEnvironment: SentinelEnvironment | undefined,
  ): Promise<void> {
    if (!settings.themeSwapEnabled || !context) {
      await this.themeSwapService.restore(settings);
      return;
    }

    const isTransition = prevEnvironment !== context.environment;
    await this.themeSwapService.applyForEnvironment(context.environment, settings, { isTransition });
  }

  private notifyContextListeners(context: SentinelContext | null): void {
    for (const listener of this.contextListeners) {
      listener(context);
    }
  }

  private maybeNotifyTransition(
    nextEnvironment: SentinelEnvironment | undefined,
    notify: boolean,
    prevEnvironment: SentinelEnvironment | undefined,
  ): void {
    if (!notify || !nextEnvironment || !prevEnvironment || prevEnvironment === nextEnvironment) {
      return;
    }

    const from = environmentLabel(prevEnvironment);
    const to = environmentLabel(nextEnvironment);
    void vscode.window.showInformationMessage(
      `${environmentIcon(nextEnvironment)} Environment changed: ${from} → ${to}`,
      'View Safety Details',
    ).then((choice) => {
      if (choice === 'View Safety Details') {
        void vscode.commands.executeCommand('postgres-explorer.showConnectionSafety');
      }
    });
  }

  private maybeProdTour(context: SentinelContext | null): void {
    if (!context || context.environment !== 'production') {
      return;
    }
    if (this.extensionContext.globalState.get<boolean>(SENTINEL_PROD_TOUR_KEY, false)) {
      return;
    }
    void this.extensionContext.globalState.update(SENTINEL_PROD_TOUR_KEY, true);
    void vscode.window.showInformationMessage(
      '🔴 Production notebook focused — Sentinel is highlighting this environment in the status bar and workbench chrome. Your syntax theme is unchanged.',
      'Sentinel Settings',
    ).then((choice) => {
      if (choice === 'Sentinel Settings') {
        void vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sentinel' });
      }
    });
  }

  private trackGateEvents(
    context: SentinelContext | null,
    prevEnvironment: SentinelEnvironment | undefined,
  ): void {
    const telemetry = TelemetryService.getInstance();
    if (context && prevEnvironment !== context.environment) {
      telemetry.trackEvent('sentinel_gate_open', { environment: context.environment });
      if (prevEnvironment) {
        telemetry.trackEvent('sentinel_transition', {
          fromEnv: prevEnvironment,
          toEnv: context.environment,
        });
      }
    }
  }

  dispose(): void {
    void this.accentService.restore();
    void this.themeSwapService.restore();
    this.disposables.forEach((d) => d.dispose());
    this.contextListeners.clear();
  }
}
