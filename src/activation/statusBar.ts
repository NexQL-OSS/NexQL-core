import * as vscode from 'vscode';
import { PostgresMetadata } from '../common/types';
import { extensionContext } from '../extension';
import { ProfileManager } from '../features/connections/ProfileManager';
import { getTransactionManager } from '../services/TransactionManager';
import { ConnectionUtils } from '../utils/connectionUtils';
import { getCachedAiUsage, refreshAiUsageInBackground, remainingPercentLabel } from '../services/aiUsage';
import { isProBuild } from '../common/buildTier';
import { environmentLabel } from '../features/sentinel/constants';
import type { SentinelEnvironment } from '../features/sentinel/types';
import type { SentinelContext, SentinelSettings } from '../features/sentinel/types';
import { PlatformConnectionService } from '../services/PlatformConnectionService';
import { profileDisplayLabel } from '../lib/platform/PlatformProfile';

/**
 * Manages the notebook status bar items that display connection and database info.
 * Shows clickable status items when a PostgreSQL notebook is active.
 */
export class NotebookStatusBar implements vscode.Disposable {
  private readonly connectionItem: vscode.StatusBarItem;
  private readonly databaseItem: vscode.StatusBarItem;
  private readonly userItem: vscode.StatusBarItem;
  private readonly environmentItem: vscode.StatusBarItem;
  private readonly profileItem: vscode.StatusBarItem;
  private readonly transactionItem: vscode.StatusBarItem;
  /** Always-visible license tier indicator (independent of notebook focus). */
  private readonly tierItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private currentEnvironment: string | undefined;
  private currentReadOnlyMode = false;
  private currentTier = 'free';
  private currentOffline = false;
  private sentinelActive = false;
  private sentinelSettings: SentinelSettings | undefined;

  constructor() {
    this.connectionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.connectionItem.command = 'postgres-explorer.switchConnection';
    this.connectionItem.tooltip = 'Click to switch PostgreSQL connection';

    this.databaseItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.databaseItem.command = 'postgres-explorer.switchDatabase';
    this.databaseItem.tooltip = 'Click to switch database';

    this.userItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.userItem.tooltip = 'Connected database user';

    this.environmentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.environmentItem.command = 'postgres-explorer.showConnectionSafety';
    this.environmentItem.tooltip = 'Click to view connection safety details';

    this.profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.profileItem.command = 'postgres-explorer.switchConnectionProfile';
    this.profileItem.tooltip = 'Click to switch connection profile';

    this.transactionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    this.transactionItem.tooltip = 'Transaction is open — click to view transaction details';

    this.tierItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
    this.tierItem.command = 'postgres-explorer.license.manage';
    this.updateTier('free');
    this.tierItem.show();

    this.disposables.push(
      this.connectionItem,
      this.databaseItem,
      this.userItem,
      this.environmentItem,
      this.profileItem,
      this.transactionItem,
      this.tierItem,
      vscode.window.onDidChangeActiveNotebookEditor(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (vscode.window.activeNotebookEditor?.notebook === e.notebook) {
          this.update();
        }
      }),
    );

    this.update();
  }

  /** Called by SentinelContextService after gate resolution. */
  applySentinel(context: SentinelContext | null, settings: SentinelSettings): void {
    this.sentinelActive = !!context;
    this.sentinelSettings = settings;
    if (context) {
      this.currentEnvironment = context.environment;
      this.currentReadOnlyMode = context.readOnlyMode;
    }
    this.renderTierItem();
  }

  /** Updates the status bar based on the active notebook editor */
  update(): void {
    const editor = vscode.window.activeNotebookEditor;

    if (!this.isPostgresNotebook(editor)) {
      this.hideNotebookItems();
      return;
    }

    const effectiveMetadata = ConnectionUtils.getEffectiveMetadata(editor!.notebook.metadata) as PostgresMetadata;
    const connection = ConnectionUtils.findConnectionWithFallback(effectiveMetadata?.connectionId, editor!.notebook.metadata);

    if (!effectiveMetadata?.connectionId || !connection) {
      this.showNoConnection();
      return;
    }

    this.showConnection(connection, effectiveMetadata);
  }

  private isPostgresNotebook(editor: vscode.NotebookEditor | undefined): boolean {
    return !!editor && (
      editor.notebook.notebookType === 'postgres-notebook' ||
      editor.notebook.notebookType === 'postgres-query'
    );
  }

  private hideNotebookItems(): void {
    this.connectionItem.hide();
    this.databaseItem.hide();
    this.userItem.hide();
    this.environmentItem.hide();
    this.profileItem.hide();
    this.transactionItem.hide();

    if (!this.sentinelActive) {
      this.currentEnvironment = undefined;
      this.currentReadOnlyMode = false;
    }
    this.renderTierItem();
  }

  private showNoConnection(): void {
    this.connectionItem.text = '$(plug) Click to Connect';
    this.connectionItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.connectionItem.show();
    this.databaseItem.hide();
    this.userItem.hide();
    this.environmentItem.hide();
    this.profileItem.hide();
    this.transactionItem.hide();

    this.currentEnvironment = undefined;
    this.currentReadOnlyMode = false;
    this.sentinelActive = false;
    this.renderTierItem();
  }

  private showConnection(connection: any, metadata: PostgresMetadata): void {
    const connName = connection?.name || connection?.host || 'Unknown';
    const dbName = metadata.databaseName || connection?.database || 'default';
    const username = connection?.username || metadata.username || '';
    const host = connection?.host || metadata.host || '';
    const port = connection?.port || metadata.port || 5432;
    const environment = connection?.environment;
    const accentEnabled = this.sentinelSettings?.statusBarAccent !== false;
    const showEnvItem = this.sentinelActive && accentEnabled && environment;
    let itemStyle = showEnvItem ? this.envItemStyle(environment) : this.defaultItemStyle();

    const connectionColor = connection?.color || (environment === 'production' ? 'red' : environment === 'staging' ? 'orange' : environment === 'development' ? 'green' : undefined);
    if (connectionColor) {
      if (connectionColor === 'red') {
        itemStyle = { background: new vscode.ThemeColor('statusBarItem.errorBackground') };
      } else if (connectionColor === 'orange') {
        itemStyle = { background: new vscode.ThemeColor('statusBarItem.warningBackground') };
      } else {
        itemStyle = {
          background: new vscode.ThemeColor('statusBarItem.prominentBackground'),
          color: new vscode.ThemeColor(`charts.${connectionColor}`)
        };
      }
    }

    const platformCached = PlatformConnectionService.getInstance().getCached(
      metadata.connectionId,
      metadata.databaseName,
    );
    const pgMajor = platformCached?.profile.serverMajor;
    const platformLabel = platformCached
      ? profileDisplayLabel(platformCached.profile)
      : undefined;
    const connTextParts = [`$(server) ${connName}`];
    if (pgMajor) {
      connTextParts.push(`PG ${pgMajor}`);
    }
    this.connectionItem.text = connTextParts.join(' · ');
    let tooltip = this.buildConnectionTooltip(connName, host, port, username, environment);
    if (platformLabel) {
      tooltip += `\nPlatform: ${platformLabel}`;
    }
    if (pgMajor) {
      tooltip += `\nPostgreSQL ${pgMajor}`;
    }
    this.connectionItem.tooltip = tooltip;
    this.applyItemStyle(this.connectionItem, itemStyle);
    this.connectionItem.show();

    this.databaseItem.text = `$(database) ${dbName}`;
    this.databaseItem.tooltip = `Database: ${dbName}\nClick to switch database`;
    this.applyItemStyle(this.databaseItem, itemStyle);
    this.databaseItem.show();

    if (username) {
      this.userItem.text = `$(account) ${username}`;
      this.userItem.tooltip = `User: ${username}`;
      this.applyItemStyle(this.userItem, itemStyle);
      this.userItem.show();
    } else {
      this.userItem.hide();
    }

    if (showEnvItem) {
      const label = environmentLabel(environment);
      const roSuffix = connection.readOnlyMode ? ' RO' : '';
      this.environmentItem.text = `$(shield) ${label}${roSuffix}`;
      this.environmentItem.tooltip = `Environment: ${label}${roSuffix ? ' (read-only)' : ''}\nClick for safety details`;
      this.applyItemStyle(this.environmentItem, itemStyle);
      this.environmentItem.show();
    } else {
      this.environmentItem.hide();
    }

    if (!this.sentinelActive) {
      this.currentEnvironment = connection.environment;
      this.currentReadOnlyMode = !!connection.readOnlyMode;
    }

    this.updateProfileIndicator(itemStyle);
    this.renderTierItem();

    vscode.commands.executeCommand('setContext', 'nexql.connectionName', connName);
    vscode.commands.executeCommand('setContext', 'nexql.databaseName', dbName);
  }

  private buildConnectionTooltip(
    name: string,
    host: string,
    port: number | string,
    username: string,
    environment?: string,
  ): string {
    const lines = [
      `Connection: ${name}`,
      `Host: ${host}:${port}`,
    ];
    if (username) {
      lines.push(`User: ${username}`);
    }
    if (environment) {
      lines.push(`Environment: ${environmentLabel(environment as any) || environment}`);
    }
    lines.push('Click to switch connection');
    return lines.join('\n');
  }

  private defaultItemStyle(): { background?: vscode.ThemeColor; color?: vscode.ThemeColor } {
    return { background: new vscode.ThemeColor('statusBarItem.prominentBackground') };
  }

  private envItemStyle(environment: SentinelEnvironment): { background?: vscode.ThemeColor; color?: vscode.ThemeColor } {
    switch (environment) {
      case 'production':
        return { background: new vscode.ThemeColor('statusBarItem.errorBackground') };
      case 'staging':
        return { background: new vscode.ThemeColor('statusBarItem.warningBackground') };
      case 'development':
        return {
          background: new vscode.ThemeColor('statusBarItem.prominentBackground'),
          color: new vscode.ThemeColor('charts.blue'),
        };
    }
  }

  private applyItemStyle(
    item: vscode.StatusBarItem,
    style: { background?: vscode.ThemeColor; color?: vscode.ThemeColor },
  ): void {
    item.backgroundColor = style.background;
    item.color = style.color;
  }

  private updateProfileIndicator(
    style: { background?: vscode.ThemeColor; color?: vscode.ThemeColor },
  ): void {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
      this.profileItem.hide();
      return;
    }

    const notebookKey = `activeProfile-${editor.notebook.uri.toString()}`;
    const activeProfileContext = extensionContext?.globalState.get<any>(notebookKey);

    if (!activeProfileContext) {
      this.profileItem.hide();
      return;
    }

    const profileManager = ProfileManager.getInstance();
    const profile = profileManager.getProfiles().find((p) => p.id === activeProfileContext.profileId);
    const profileName = profile?.profileName || 'Unknown Profile';

    const constraints: string[] = [];
    if (activeProfileContext.readOnlyMode) constraints.push('🔒 RO');
    if (activeProfileContext.autoLimitSelectResults > 0) {
      constraints.push(`📊 Limit: ${activeProfileContext.autoLimitSelectResults}`);
    }

    const constraintText = constraints.length > 0 ? ` [${constraints.join(' | ')}]` : '';

    this.profileItem.text = `$(person) Profile: ${profileName}${constraintText}`;
    this.applyItemStyle(this.profileItem, style);
    this.profileItem.show();
  }

  /**
   * Updates the transaction status bar item based on the current transaction state.
   * Call this after a transaction begins, commits, or rolls back.
   * @param sessionId The notebook URI string used as the session ID.
   */
  public updateTransactionState(sessionId?: string): void {
    const editor = vscode.window.activeNotebookEditor;
    if (!this.isPostgresNotebook(editor)) {
      this.transactionItem.hide();
      return;
    }

    const id = sessionId ?? editor!.notebook.uri.toString();
    const txManager = getTransactionManager();
    const txInfo = txManager.getTransactionInfo(id);

    const editorMeta = editor
      ? (ConnectionUtils.getEffectiveMetadata(editor.notebook.metadata) as PostgresMetadata)
      : undefined;
    const txProfile = editorMeta?.connectionId
      ? PlatformConnectionService.getInstance().getProfile(
          editorMeta.connectionId,
          editorMeta.databaseName,
        )
      : undefined;
    const sessionUnreliable = txProfile && !txProfile.capabilities.sessionStateReliable;

    if (sessionUnreliable) {
      this.transactionItem.text = '$(warning) Txn unavailable (pooled)';
      this.transactionItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
      this.transactionItem.tooltip =
        'Transactions are unreliable on transaction-mode poolers. Use a direct or session pooler endpoint.';
      this.transactionItem.show();
    } else if (txInfo?.isActive) {
      this.transactionItem.text = '$(sync~spin) Transaction open';
      this.transactionItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.transactionItem.tooltip = 'A PostgreSQL transaction is open — commit or rollback to close it';
      this.transactionItem.show();
    } else {
      this.transactionItem.hide();
    }
  }

  public updateTier(tier: string, offline: boolean = false): void {
    this.currentTier = tier;
    this.currentOffline = offline;
    this.renderTierItem();
  }

  private renderTierItem(): void {
    const tier = this.currentTier;
    const offline = this.currentOffline;
    const env = this.currentEnvironment;
    const ro = this.currentReadOnlyMode;
    const demoteEnvSuffix = this.sentinelActive;

    let tierLabel = 'Free';
    let baseIcon = '$(unlock)';
    let tierColor: vscode.ThemeColor | undefined = undefined;

    if (tier === 'free') {
      tierLabel = 'Free';
      baseIcon = '$(unlock)';
    } else if (tier === 'sponsor') {
      tierLabel = 'Sponsor';
      baseIcon = '$(heart)';
      tierColor = new vscode.ThemeColor('charts.green');
    } else if (tier === 'singularity') {
      tierLabel = 'Team';
      baseIcon = '$(verified)';
      tierColor = new vscode.ThemeColor('charts.purple');
    }

    let suffix = '';
    let envTooltip = '';
    let finalColor: vscode.ThemeColor | undefined = tierColor;

    // Free/OSS build: no license surface. The item degrades to a pure
    // environment-risk indicator ([PROD]/[STAGING]/[RO]) and stays hidden
    // when there is no environment context.
    const licensedBuild = isProBuild();

    if (!demoteEnvSuffix) {
      if (env === 'production') {
        suffix = ro ? ' [PROD-RO]' : ' [PROD]';
        envTooltip = ro
          ? '\nEnvironment: Production (Read-only mode & safety checks active)'
          : '\n⚠️ Warning: Connected to PRODUCTION database (Safety checks active)';
        finalColor = new vscode.ThemeColor('charts.red');
      } else if (env === 'staging') {
        suffix = ro ? ' [STAGING-RO]' : ' [STAGING]';
        envTooltip = ro
          ? '\nEnvironment: Staging (Read-only mode & safety checks active)'
          : '\nEnvironment: Staging (Safety checks active)';
        finalColor = new vscode.ThemeColor('charts.orange');
      } else if (env === 'development') {
        suffix = ro ? ' [DEV-RO]' : ' [DEV]';
        envTooltip = ro
          ? '\nEnvironment: Development (Read-only mode & safety checks active)'
          : '\nEnvironment: Development (Safety checks active)';
        finalColor = new vscode.ThemeColor('charts.blue');
      } else if (ro) {
        suffix = ' [RO]';
        envTooltip = '\nRead-only mode active';
        finalColor = new vscode.ThemeColor('charts.blue');
      }
    } else if (ro) {
      suffix = ' [RO]';
      envTooltip = '\nRead-only mode active';
    }

    if (!licensedBuild) {
      if (!suffix) {
        this.tierItem.hide();
        return;
      }
      this.tierItem.text = suffix.trim();
      this.tierItem.tooltip = envTooltip.trim() || 'Connection environment';
      this.tierItem.command = 'postgres-explorer.showConnectionSafety';
      this.tierItem.backgroundColor = undefined;
      this.tierItem.color = demoteEnvSuffix ? undefined : finalColor;
      this.tierItem.show();
      return;
    }

    if (offline && tier !== 'free') {
      this.tierItem.text = `$(warning) ${tierLabel}${suffix} (offline)`;
      this.tierItem.tooltip = `${tierLabel} — running on cached license (offline grace). Click to manage.${envTooltip}`;
      this.tierItem.command = 'postgres-explorer.license.manage';
      this.tierItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.tierItem.color = undefined;
    } else if (tier === 'free') {
      this.tierItem.text = `${baseIcon} ${tierLabel}${suffix}`;
      this.tierItem.tooltip = this.buildFreeUsageTooltip(envTooltip);
      this.tierItem.command = 'postgres-explorer.license.showUsage';
      this.tierItem.backgroundColor = undefined;
      this.tierItem.color = demoteEnvSuffix ? undefined : finalColor;
    } else {
      this.tierItem.text = `${baseIcon} ${tierLabel}${suffix}`;
      this.tierItem.tooltip = this.buildPaidUsageTooltip(tierLabel, envTooltip);
      this.tierItem.command = 'postgres-explorer.license.manage';
      this.tierItem.backgroundColor = undefined;
      this.tierItem.color = demoteEnvSuffix ? undefined : finalColor;
    }
  }

  /** Free-tier tooltip: AI usage only — all features are unlimited. */
  private buildFreeUsageTooltip(envTooltip: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**NexQL Free** — click for usage details\n\n');

    const aiUsage = getCachedAiUsage();
    if (aiUsage) {
      md.appendMarkdown(`- AI Chat Assistant: ${remainingPercentLabel(aiUsage.remaining, aiUsage.limit)} left this month\n`);
    } else {
      md.appendMarkdown('- AI Chat Assistant: … this month\n');
    }
    refreshAiUsageInBackground(extensionContext, () => this.renderTierItem());

    md.appendMarkdown('\nAll features are unlimited on the free tier.\n');
    md.appendMarkdown('\nClick for details — full view in Settings → License.\n');
    if (envTooltip) {
      md.appendMarkdown(`\n${envTooltip.trim()}`);
    }
    return md;
  }

  /** Paid-tier tooltip: cloud storage usage. */
  private buildPaidUsageTooltip(tierLabel: string, envTooltip: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**NexQL ${tierLabel}** — license active. Click to manage.\n\n`);
    md.appendMarkdown(`- Cloud Storage: click for details — full view in Settings → License\n`);
    if (envTooltip) {
      md.appendMarkdown(`\n${envTooltip.trim()}`);
    }
    return md;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

/** Sync status indicator — click opens sync menu; conflicts jump to resolver. */
export class SyncStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private status: string = 'not_configured';
  private conflictCount = 0;
  private lastSyncAt: number | undefined;
  private pendingCount = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 93);
    this.item.command = 'postgres-explorer.sync.statusMenu';
    this.update('not_configured', 0, false);
    this.item.show();
  }

  updateSyncStatus(status: string, conflicts = 0, configured = false, extras?: {
    lastSyncAt?: number;
    pendingCount?: number;
  }): void {
    this.lastSyncAt = extras?.lastSyncAt;
    this.pendingCount = extras?.pendingCount ?? 0;
    if (status === 'conflict' && conflicts > 0) {
      this.item.command = 'postgres-explorer.sync.conflicts';
    } else {
      this.item.command = 'postgres-explorer.sync.statusMenu';
    }
    this.update(status, conflicts, configured);
  }

  private update(status: string, conflicts: number, configured: boolean): void {
    this.status = status;
    this.conflictCount = conflicts;

    if (!configured) {
      this.item.text = '$(cloud-upload) Set up sync';
      this.item.tooltip = 'NexQL sync not configured. Click to set up.';
      this.item.backgroundColor = undefined;
      return;
    }

    switch (status) {
      case 'synced':
        this.item.text = '$(cloud) Synced';
        this.item.tooltip = this.buildTooltip('NexQL sync is up to date.');
        this.item.backgroundColor = undefined;
        break;
      case 'idle':
        this.item.text = '$(cloud) Sync ready';
        this.item.tooltip = this.buildTooltip('Sync is configured.');
        this.item.backgroundColor = undefined;
        break;
      case 'syncing':
        this.item.text = '$(sync~spin) Syncing';
        this.item.tooltip = 'Sync in progress…';
        break;
      case 'offline':
        this.item.text = '$(cloud-offline) Offline';
        this.item.tooltip = 'Offline — changes queued, will retry automatically.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'conflict':
        this.item.text = `$(warning) Sync conflict (${conflicts})`;
        this.item.tooltip = this.buildTooltip(`${conflicts} conflict(s) — click to resolve.`);
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'error':
        this.item.text = '$(error) Sync error';
        this.item.tooltip = 'Sync error — click for options.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'locked':
        this.item.text = '$(lock) Vault locked';
        this.item.tooltip = 'Unlock sync with your vault secret key (re-run setup → Unlock existing vault).';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'paused':
        this.item.text = '$(debug-pause) Sync paused';
        this.item.tooltip = 'Sync is paused. Click to resume.';
        break;
      default:
        this.item.text = '$(cloud) Sync ready';
        this.item.tooltip = 'Sync is configured. Click for options.';
        this.item.backgroundColor = undefined;
    }
  }

  private buildTooltip(base: string): string {
    const parts = [base];
    if (this.lastSyncAt) {
      parts.push(`Last sync: ${new Date(this.lastSyncAt).toLocaleString()}`);
    }
    if (this.pendingCount > 0) {
      parts.push(`Pending: ${this.pendingCount}`);
    }
    return parts.join('\n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
