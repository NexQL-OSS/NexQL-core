import * as vscode from 'vscode';
import { PostgresMetadata } from '../common/types';
import { extensionContext } from '../extension';
import { ProfileManager } from '../features/connections/ProfileManager';
import { getTransactionManager } from '../services/TransactionManager';
import { ConnectionUtils } from '../utils/connectionUtils';
import { WorkspaceStateService } from '../services/WorkspaceStateService';

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
      this.workspaceDefaultItem.text = '$(folder) PgStudio: set workspace DB';
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
      this.riskIndicatorItem.hide();
      return;
    }

    const environment = connection.environment;
    const readOnlyMode = connection.readOnlyMode;

    if (environment === 'production') {
      this.riskIndicatorItem.text = readOnlyMode ? '$(shield) PROD (READ-ONLY)' : '$(alert) PRODUCTION';
      this.riskIndicatorItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.riskIndicatorItem.tooltip = readOnlyMode 
        ? 'Production environment - Read-only mode active'
        : '⚠️ Warning: Connected to PRODUCTION database';
      this.riskIndicatorItem.show();
    } else if (environment === 'staging') {
      this.riskIndicatorItem.text = readOnlyMode ? '$(shield) STAGING (READ-ONLY)' : '$(info) STAGING';
      this.riskIndicatorItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.riskIndicatorItem.tooltip = readOnlyMode
        ? 'Staging environment - Read-only mode active'
        : 'Connected to STAGING database';
      this.riskIndicatorItem.show();
    } else if (environment === 'development' || readOnlyMode) {
      if (readOnlyMode) {
        this.riskIndicatorItem.text = '$(shield) READ-ONLY';
        this.riskIndicatorItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        this.riskIndicatorItem.tooltip = 'Read-only mode active';
        this.riskIndicatorItem.show();
      } else {
        this.riskIndicatorItem.hide();
      }
    } else {
      this.riskIndicatorItem.hide();
    }
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

  /**
   * Updates the always-visible license tier indicator.
   * @param tier 'free' | 'sponsor' | 'singularity'
   * @param offline true when running on a cached entitlement (grace window).
   */
  public updateTier(tier: string, offline: boolean = false): void {
    if (tier === 'free') {
      this.tierItem.text = '$(unlock) PgStudio Free';
      this.tierItem.tooltip = 'Free tier — click to activate a license';
      this.tierItem.backgroundColor = undefined;
    } else {
      const label = tier[0].toUpperCase() + tier.slice(1);
      if (offline) {
        this.tierItem.text = `$(warning) ${label} (offline)`;
        this.tierItem.tooltip = `PgStudio ${label} — running on cached license (offline grace). Click to manage.`;
        this.tierItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        this.tierItem.text = `$(verified) PgStudio ${label}`;
        this.tierItem.tooltip = `PgStudio ${label} — license active. Click to manage.`;
        this.tierItem.backgroundColor = undefined;
      }
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
