import * as vscode from 'vscode';
import { PostgresMetadata } from '../common/types';
import { extensionContext } from '../extension';
import { ProfileManager } from '../services/ProfileManager';
import { getTransactionManager } from '../services/TransactionManager';

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

    this.disposables.push(
      this.connectionItem,
      this.databaseItem,
      this.riskIndicatorItem,
      this.profileItem,
      this.transactionItem,
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
      this.hide();
      return;
    }

    const metadata = editor!.notebook.metadata as PostgresMetadata;
    const connection = this.getConnection(metadata?.connectionId);

    if (!metadata?.connectionId) {
      this.showNoConnection();
      return;
    }

    this.showConnection(connection, metadata);
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

  private hide(): void {
    this.connectionItem.hide();
    this.databaseItem.hide();
    this.riskIndicatorItem.hide();
    this.profileItem.hide();
    this.transactionItem.hide();
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

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
