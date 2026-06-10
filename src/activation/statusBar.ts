import * as vscode from 'vscode';
import { PostgresMetadata } from '../common/types';
import { extensionContext } from '../extension';
import { ProfileManager } from '../features/connections/ProfileManager';
import { getTransactionManager } from '../services/TransactionManager';
import { ConnectionUtils } from '../utils/connectionUtils';
import { WorkspaceStateService } from '../services/WorkspaceStateService';
import { FREE_QUOTAS, ProFeature, featureLabel } from '../services/featureGates';
import { QuotaService } from '../services/QuotaService';

/**
 * Manages the notebook status bar items that display connection and database info.
 * Shows clickable status items when a PostgreSQL notebook is active.
 */
export class NotebookStatusBar implements vscode.Disposable {
  private readonly connectionItem: vscode.StatusBarItem;
  private readonly databaseItem: vscode.StatusBarItem;
  private readonly riskIndicatorItem: vscode.StatusBarItem;
  private readonly profileItem: vscode.StatusBarItem;
  private readonly transactionItem: vscode.StatusBarItem;
  /** Shown when no PostgreSQL notebook is active: workspace default connection (per-folder state). */
  private readonly workspaceDefaultItem: vscode.StatusBarItem;
  /** Always-visible license tier indicator (independent of notebook focus). */
  private readonly tierItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private currentEnvironment: string | undefined;
  private currentReadOnlyMode = false;
  private currentTier = 'free';
  private currentOffline = false;

  constructor() {
    this.connectionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.connectionItem.command = 'postgres-explorer.switchConnection';
    this.connectionItem.tooltip = 'Click to switch PostgreSQL connection';

    this.databaseItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.databaseItem.command = 'postgres-explorer.switchDatabase';
    this.databaseItem.tooltip = 'Click to switch database';

    this.riskIndicatorItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.riskIndicatorItem.command = 'postgres-explorer.showConnectionSafety';
    this.riskIndicatorItem.tooltip = 'Click to view connection safety details';

    this.profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.profileItem.command = 'postgres-explorer.switchConnectionProfile';
    this.profileItem.tooltip = 'Click to switch connection profile';

    this.transactionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.transactionItem.tooltip = 'Transaction is open — click to view transaction details';

    this.workspaceDefaultItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    this.workspaceDefaultItem.command = 'postgres-explorer.switchWorkspaceDefaultConnection';

    this.tierItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
    this.tierItem.command = 'postgres-explorer.license.manage';
    this.updateTier('free');
    this.tierItem.show();

    this.disposables.push(
      this.connectionItem,
      this.databaseItem,
      this.riskIndicatorItem,
      this.profileItem,
      this.transactionItem,
      this.workspaceDefaultItem,
      this.tierItem,
      vscode.window.onDidChangeActiveNotebookEditor(() => this.update()),
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (vscode.window.activeNotebookEditor?.notebook === e.notebook) {
          this.update();
        }
      })
    );

    this.update();
  }

  /** Updates the status bar based on the active notebook editor */
  update(): void {
    const editor = vscode.window.activeNotebookEditor;

    if (!this.isPostgresNotebook(editor)) {
      this.hideNotebookItems();
      this.updateWorkspaceDefaultItem();
      return;
    }

    this.workspaceDefaultItem.hide();

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

  private getConnection(connectionId: string | undefined): any {
    if (!connectionId) return null;
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    return connections.find(c => c.id === connectionId);
  }

  private hideNotebookItems(): void {
    this.connectionItem.hide();
    this.databaseItem.hide();
    this.riskIndicatorItem.hide();
    this.profileItem.hide();
    this.transactionItem.hide();

    this.currentEnvironment = undefined;
    this.currentReadOnlyMode = false;
    this.renderTierItem();
  }

  private hide(): void {
    this.hideNotebookItems();
    this.workspaceDefaultItem.hide();
  }

  private updateWorkspaceDefaultItem(): void {
    if (!vscode.workspace.workspaceFolders?.length) {
      this.workspaceDefaultItem.hide();
      return;
    }

    const defaults = WorkspaceStateService.getInstance().getDefaults();
    const conn = defaults.lastConnectionId
      ? ConnectionUtils.findConnection(defaults.lastConnectionId)
      : undefined;
    const connLabel = conn?.name || conn?.host;
    const dbLabel = defaults.lastDatabaseName || conn?.database;

    if (!connLabel && !dbLabel) {
      this.workspaceDefaultItem.text = '$(folder) NexQL: set workspace DB';
      this.workspaceDefaultItem.tooltip =
        'Choose a default PostgreSQL connection for this workspace (used when no .pgsql notebook is focused).';
      this.workspaceDefaultItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.workspaceDefaultItem.show();
      return;
    }

    const hostPart = conn ? `${conn.name || conn.host}` : 'Unknown connection';
    const dbPart = dbLabel || '—';
    this.workspaceDefaultItem.text = `$(root-folder) ${hostPart} · $(database) ${dbPart}`;
    this.workspaceDefaultItem.tooltip = 'Workspace default connection. Click to change.';
    this.workspaceDefaultItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    this.workspaceDefaultItem.show();
  }

  private showNoConnection(): void {
    this.connectionItem.text = '$(plug) Click to Connect';
    this.connectionItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.connectionItem.show();
    this.databaseItem.hide();
    this.riskIndicatorItem.hide();
    this.profileItem.hide();
    this.transactionItem.hide();

    this.currentEnvironment = undefined;
    this.currentReadOnlyMode = false;
    this.renderTierItem();
  }

  private showConnection(connection: any, metadata: PostgresMetadata): void {
    const connName = connection?.name || connection?.host || 'Unknown';
    const dbName = metadata.databaseName || connection?.database || 'default';

    this.connectionItem.text = `$(server) ${connName}`;
    this.connectionItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    this.connectionItem.show();

    this.databaseItem.text = `$(database) ${dbName}`;
    this.databaseItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    this.databaseItem.show();

    // Show risk indicator based on environment
    this.updateRiskIndicator(connection);

    // Show active profile if one is set
    this.updateProfileIndicator();

    // Update context for when clauses
    vscode.commands.executeCommand('setContext', 'pgstudio.connectionName', connName);
    vscode.commands.executeCommand('setContext', 'pgstudio.databaseName', dbName);
  }

  private updateProfileIndicator(): void {
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

    // Get the profile name from ProfileManager
    const profileManager = ProfileManager.getInstance();
    const profile = profileManager.getProfiles().find(p => p.id === activeProfileContext.profileId);
    const profileName = profile?.profileName || 'Unknown Profile';

    // Build status text with icons for active constraints
    const constraints: string[] = [];
    if (activeProfileContext.readOnlyMode) constraints.push('🔒 RO');
    if (activeProfileContext.autoLimitSelectResults > 0) constraints.push(`📊 Limit: ${activeProfileContext.autoLimitSelectResults}`);
    
    const constraintText = constraints.length > 0 ? ` [${constraints.join(' | ')}]` : '';
    
    this.profileItem.text = `$(person) Profile: ${profileName}${constraintText}`;
    this.profileItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    this.profileItem.show();
  }

  private updateRiskIndicator(connection: any): void {
    if (!connection) {
      this.currentEnvironment = undefined;
      this.currentReadOnlyMode = false;
    } else {
      this.currentEnvironment = connection.environment;
      this.currentReadOnlyMode = !!connection.readOnlyMode;
    }
    this.renderTierItem();
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

    if (txInfo?.isActive) {
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

    // Determine suffix for environment and color overrides
    let suffix = '';
    let envTooltip = '';
    let finalColor: vscode.ThemeColor | undefined = tierColor;

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

    // Compose text
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
      this.tierItem.color = finalColor;
    } else {
      this.tierItem.text = `${baseIcon} ${tierLabel}${suffix}`;
      this.tierItem.tooltip = `${tierLabel} — license active. Click to manage.${envTooltip}`;
      this.tierItem.command = 'postgres-explorer.license.manage';
      this.tierItem.backgroundColor = undefined;
      this.tierItem.color = finalColor;
    }
  }

  /** Free-tier tooltip: remaining metered usage per feature, refreshed on each render. */
  private buildFreeUsageTooltip(envTooltip: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**NexQL Free** — click for usage details\n\n');
    const quotas = QuotaService.getInstance();
    const now = new Date();
    for (const feature of Object.keys(FREE_QUOTAS) as ProFeature[]) {
      const status = quotas.peek(feature, now);
      if (!status) { continue; }
      const word = status.period === 'week' ? 'this week' : 'today';
      md.appendMarkdown(`- ${featureLabel(feature)}: ${status.remaining}/${status.limit} left ${word}\n`);
    }
    if (envTooltip) {
      md.appendMarkdown(`\n${envTooltip.trim()}`);
    }
    return md;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

/** Sync status indicator — click opens sync QuickPick menu. */
export class SyncStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private status: string = 'not_configured';
  private conflictCount = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 93);
    this.item.command = 'postgres-explorer.sync.statusMenu';
    this.update('not_configured', 0, false);
    this.item.show();
  }

  updateSyncStatus(status: string, conflicts = 0, configured = false): void {
    this.update(status, conflicts, configured);
  }

  private update(status: string, conflicts: number, configured: boolean): void {
    this.status = status;
    this.conflictCount = conflicts;

    if (!configured) {
      this.item.text = '$(cloud-upload) Set up sync';
      this.item.tooltip = 'PgStudio sync not configured. Click to set up.';
      this.item.backgroundColor = undefined;
      return;
    }

    switch (status) {
      case 'synced':
        this.item.text = '$(cloud) Synced';
        this.item.tooltip = 'PgStudio sync is up to date. Click for options.';
        this.item.backgroundColor = undefined;
        break;
      case 'idle':
        this.item.text = '$(cloud) Sync ready';
        this.item.tooltip = 'Sync is configured. Click for options.';
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
        this.item.tooltip = `${conflicts} conflict(s) — review copies saved locally.`;
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

  dispose(): void {
    this.item.dispose();
  }
}
