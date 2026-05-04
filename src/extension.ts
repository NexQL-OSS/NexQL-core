import * as vscode from 'vscode';
import { ConnectionManager } from './services/ConnectionManager';
import { SecretStorageService } from './services/SecretStorageService';
import { ProfileManager } from './features/connections/ProfileManager';
import { SavedQueriesService } from './features/savedQueries/SavedQueriesService';
import { NotebookBuilder } from './commands/helper';
import { SessionRegistry } from './services/SessionRegistry';
import type { NotebookStatusBar } from './activation/statusBar';
import type { ChatViewProvider } from './providers/ChatViewProvider';
import { QueryHistoryService } from './services/QueryHistoryService';
import { QueryPerformanceService } from './services/QueryPerformanceService';
import { WorkspaceStateService } from './services/WorkspaceStateService';
import { MessageHandlerRegistry } from './services/MessageHandler';
import { TelemetryService } from './services/TelemetryService';
import { WEBVIEW_MESSAGE_TYPES } from './common/messageTypes';

export let outputChannel: vscode.OutputChannel;
export let extensionContext: vscode.ExtensionContext;
export let statusBar: NotebookStatusBar;

let chatViewProvider: ChatViewProvider | undefined;

function runDeferredStartupTask(taskName: string, task: () => Promise<void>): void {
  void (async () => {
    const start = Date.now();
    try {
      await task();
      outputChannel?.appendLine(`[startup/deferred] ${taskName} completed in ${Date.now() - start}ms`);
    } catch (error) {
      outputChannel?.appendLine(`[startup/deferred] ${taskName} failed: ${error}`);
    }
  })();
}

function isAzurePostgresHost(host?: string): boolean {
  if (!host) {
    return false;
  }

  const normalizedHost = host.toLowerCase();
  return normalizedHost.includes('postgres.database.azure.com');
}

function migrateLegacyAzureConnectionTimeouts(connections: any[]): { connections: any[]; migratedCount: number } {
  let migratedCount = 0;

  const migratedConnections = connections.map((connection) => {
    // Legacy Azure connections from v0.8.8 commonly carried a 5s default timeout.
    if (isAzurePostgresHost(connection.host) && connection.connectTimeout === 5) {
      migratedCount++;
      return { ...connection, connectTimeout: 15 };
    }

    return connection;
  });

  return { connections: migratedConnections, migratedCount };
}

export function getChatViewProvider(): ChatViewProvider | undefined {
  return chatViewProvider;
}

async function ensureRendererMessageHandlers(
  registry: MessageHandlerRegistry,
  chatView: ChatViewProvider,
  statusBarInstance: NotebookStatusBar,
  context: vscode.ExtensionContext
): Promise<void> {
  const [
    explainHandlersModule,
    coreHandlersModule,
    queryHandlersModule,
    cursorBannerModule,
  ] = await Promise.all([
    import('./services/handlers/ExplainHandlers'),
    import('./services/handlers/CoreHandlers'),
    import('./services/handlers/QueryHandlers'),
    import('./services/handlers/CursorStreamBannerHandler'),
  ]);

  // Explain & Chat Handlers
  registry.register('explainError', new explainHandlersModule.ExplainErrorHandler(chatView));
  registry.register('fixQuery', new explainHandlersModule.FixQueryHandler(chatView));
  registry.register('analyzeData', new explainHandlersModule.AnalyzeDataHandler(chatView));
  registry.register('optimizeQuery', new explainHandlersModule.OptimizeQueryHandler(chatView));
  registry.register('sendToChat', new explainHandlersModule.SendToChatHandler(chatView));
  registry.register('showExplainPlan', new explainHandlersModule.ShowExplainPlanHandler(context.extensionUri));
  registry.register('convertExplainToJson', new explainHandlersModule.ConvertExplainHandler(context));

  // Core Handlers
  registry.register('showConnectionSwitcher', new coreHandlersModule.ShowConnectionSwitcherHandler(statusBarInstance));
  registry.register('showDatabaseSwitcher', new coreHandlersModule.ShowDatabaseSwitcherHandler(statusBarInstance));
  registry.register(WEBVIEW_MESSAGE_TYPES.SHOW_ERROR_MESSAGE, new coreHandlersModule.ShowErrorMessageHandler());
  registry.register(WEBVIEW_MESSAGE_TYPES.EXPORT_REQUEST, new coreHandlersModule.ExportRequestHandler());
  registry.register(WEBVIEW_MESSAGE_TYPES.RUN_DERIVED_QUERY, new coreHandlersModule.RunDerivedQueryHandler());
  registry.register('retryCell', new coreHandlersModule.RetryCellHandler());
  registry.register('showConnectionInfo', new coreHandlersModule.ShowConnectionInfoHandler());
  registry.register(
    WEBVIEW_MESSAGE_TYPES.GRID_COMMIT_PREFERENCE,
    new coreHandlersModule.GridCommitPreferenceHandler(context),
  );
  registry.register('cursorStreamBannerDismiss', new cursorBannerModule.CursorStreamBannerDismissHandler(context));
  registry.register('cursorStreamBannerMute', new cursorBannerModule.CursorStreamBannerMuteHandler(context));

  // Query Execution Handlers
  registry.register('execute_update_background', new queryHandlersModule.ExecuteUpdateBackgroundHandler());
  registry.register('script_delete', new queryHandlersModule.ScriptDeleteHandler());
  registry.register('saveChanges', new queryHandlersModule.SaveChangesHandler());
}

export async function activate(context: vscode.ExtensionContext) {
  const activationStart = Date.now();
  extensionContext = context;

  // Provide extension context to NotebookBuilder for persistent session support (Req 5.4)
  NotebookBuilder.setContext(context);

  // Clean up SessionRegistry when a scratch notebook is closed (Req 6.1, 6.2)
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((closedDoc) => {
      const closedUri = closedDoc.uri.toString();
      for (const [connectionId, doc] of SessionRegistry.entries()) {
        if (doc.uri.toString() === closedUri) {
          SessionRegistry.delete(connectionId);
          break;
        }
      }
    })
  );

  outputChannel = vscode.window.createOutputChannel('PgStudio');
  outputChannel.appendLine('Activating PgStudio extension');
  const telemetry = TelemetryService.getInstance();
  telemetry.initialize(context);
  telemetry.trackEvent('extension_activated', { version: context.extension.packageJSON.version });

  SecretStorageService.getInstance(context);
  ConnectionManager.getInstance();
  QueryHistoryService.initialize(context.workspaceState);
  QueryPerformanceService.initialize(context.globalState);

  WorkspaceStateService.getInstance().initialize(context);
  context.subscriptions.push({ dispose: () => WorkspaceStateService.getInstance().dispose() });

  // Migration: Ensure all connections have an ID (legacy connections might not)
  const config = vscode.workspace.getConfiguration();
  const connections = config.get<any[]>('postgresExplorer.connections') || [];
  let hasChanges = false;

  const migratedConnections = connections.map((conn, index) => {
    if (!conn.id) {
      hasChanges = true;
      // Generate a stable-ish ID for legacy connections
      return { ...conn, id: `${Date.now()}-${index}` };
    }
    return conn;
  });

  if (hasChanges) {
    // Before we write connections back to settings, migrate any inline
    // passwords into Secret Storage so users don't lose credentials.
    for (const conn of migratedConnections) {
      if (conn.password) {
        try {
          await SecretStorageService.getInstance(context).setPassword(conn.id, conn.password);
          delete conn.password;
        } catch (err) {
          console.error(`Failed to migrate inline password for connection ${conn.name || conn.id}:`, err);
        }
      }
    }

    await config.update('postgresExplorer.connections', migratedConnections, vscode.ConfigurationTarget.Global);
    console.log('Migrated legacy connections to include IDs and preserved inline passwords');
  }

  const azureTimeoutMigrationKey = 'postgresExplorer.migrations.azureConnectionTimeouts.v0_8_9';
  const azureTimeoutMigrationDone = context.globalState.get<boolean>(azureTimeoutMigrationKey, false);

  if (!azureTimeoutMigrationDone) {
    const timeoutMigration = migrateLegacyAzureConnectionTimeouts(migratedConnections);
    if (timeoutMigration.migratedCount > 0) {
      await config.update('postgresExplorer.connections', timeoutMigration.connections, vscode.ConfigurationTarget.Global);
      console.log(`Migrated ${timeoutMigration.migratedCount} Azure connection(s) to a 15 second timeout`);
    }

    await context.globalState.update(azureTimeoutMigrationKey, true);
  }

  // Phase 7: Initialize ProfileManager and SavedQueriesService
  ProfileManager.getInstance().initialize(context);
  SavedQueriesService.getInstance().initialize(context);

  // Non-blocking startup: default profile seeding can happen after activation completes.
  runDeferredStartupTask('initializeDefaultProfiles', async () => {
    await ProfileManager.getInstance().initializeDefaultProfiles();
  });

  // D3: Opt profile and favorites data into VS Code Settings Sync so users can
  // share their connection profiles and query library across machines.
  context.globalState.setKeysForSync([
    'postgres-explorer.connectionProfiles',
    'postgresExplorer.favorites',
  ]);

  const [providersModule, commandsModule, notebookKernelModule, whatsNewModule, statusBarModule] =
    await Promise.all([
      import('./activation/providers'),
      import('./activation/commands'),
      import('./providers/NotebookKernel'),
      import('./activation/WhatsNewManager'),
      import('./activation/statusBar'),
    ]);

  const { databaseTreeProvider, treeView, chatViewProviderInstance: chatView, savedQueriesTreeProvider, notebooksTreeProvider, autoRefreshService } = providersModule.registerProviders(context, outputChannel);
  context.subscriptions.push(autoRefreshService);
  chatViewProvider = chatView;

  // Store tree view instance for reveal functionality
  (databaseTreeProvider as any).setTreeView(treeView);

  const whatsNewManager = new whatsNewModule.WhatsNewManager(context, context.extensionUri);
  commandsModule.registerAllCommands(
    context,
    databaseTreeProvider,
    chatView,
    outputChannel,
    whatsNewManager,
    savedQueriesTreeProvider,
    notebooksTreeProvider
  );

  const { registerPgDumpTaskProvider } = await import('./features/backup/backupTaskProvider');
  registerPgDumpTaskProvider(context);

  const rendererMessaging = vscode.notebooks.createRendererMessaging('postgres-query-renderer');

  let kernelsInitialized = false;
  const ensureNotebookKernels = () => {
    if (kernelsInitialized) {
      return;
    }

    const notebookKernel = new notebookKernelModule.PostgresKernel(context, rendererMessaging, 'postgres-notebook', async (msg: { type: string; command: string; format?: string; content?: string; filename?: string }) => {
      if (msg.type === 'custom' && msg.command === 'export') {
        vscode.commands.executeCommand('postgres-explorer.exportData', {
          format: msg.format,
          content: msg.content,
          filename: msg.filename
        });
      }
    });

    const queryKernel = new notebookKernelModule.PostgresKernel(context, rendererMessaging, 'postgres-query');
    context.subscriptions.push(notebookKernel, queryKernel);
    kernelsInitialized = true;
    outputChannel.appendLine('[startup] notebook kernels initialized lazily');
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument((notebook) => {
      if (notebook.notebookType === 'postgres-notebook' || notebook.notebookType === 'postgres-query') {
        ensureNotebookKernels();
      }
    })
  );

  if (vscode.workspace.notebookDocuments.some((notebook) => notebook.notebookType === 'postgres-notebook' || notebook.notebookType === 'postgres-query')) {
    ensureNotebookKernels();
  }

  // SQL Formatter command + format-on-save listener
  context.subscriptions.push(
    vscode.commands.registerCommand('postgres-explorer.formatSql', async () => {
      const { formatSqlCommand } = await import('./commands/formatSql');
      await formatSqlCommand();
    })
  );

  runDeferredStartupTask('registerFormatOnSaveListener', async () => {
    const { createFormatOnSaveListener } = await import('./commands/formatSql');
    context.subscriptions.push(createFormatOnSaveListener());
  });

  // Auto-open once on install/update; manager tracks the last shown version in global state.
  runDeferredStartupTask('showWhatsNew', async () => {
    await whatsNewManager.checkAndShow(false);
  });

  // Status bar for connection/database display
  statusBar = new statusBarModule.NotebookStatusBar();
  context.subscriptions.push(statusBar);

  // Register Message Handlers
  const registry = MessageHandlerRegistry.getInstance();
  let handlersInitialized = false;

  rendererMessaging.onDidReceiveMessage(async (event) => {
    if (!handlersInitialized) {
      await ensureRendererMessageHandlers(registry, chatView, statusBar!, context);
      handlersInitialized = true;
    }

    await registry.handleMessage(event.message, {
      editor: event.editor,
      postMessage: (msg) => rendererMessaging.postMessage(msg, event.editor)
    });
  });

  // Auto-generate notebook title on open
  runDeferredStartupTask('registerNotebookTitleUpdater', async () => {
    const { updateNotebookTitle } = await import('./utils/notebookTitle');
    context.subscriptions.push(
      vscode.workspace.onDidOpenNotebookDocument(async (notebook) => {
        if (notebook.notebookType === 'postgres-notebook' || notebook.notebookType === 'postgres-query') {
          await updateNotebookTitle(notebook);
        }
      })
    );
  });

  runDeferredStartupTask('migrateExistingPasswords', async () => {
    const { migrateExistingPasswords } = await import('./services/SecretStorageService');
    await migrateExistingPasswords(context);
  });

  outputChannel.appendLine(`PgStudio activation completed in ${Date.now() - activationStart}ms`);
}

export async function deactivate() {
  outputChannel?.appendLine('Deactivating PgStudio extension - closing all connections');
  const telemetry = TelemetryService.getInstance();
  telemetry.trackExtensionDeactivate();

  try {
    // Close all database connections (pools and sessions)
    await ConnectionManager.getInstance().closeAll();
    outputChannel?.appendLine('All database connections closed successfully');
  } catch (err) {
    outputChannel?.appendLine(`Error closing connections during deactivation: ${err}`);
    console.error('Error during extension deactivation:', err);
  }

  // Flush after connection shutdown so close events are not dropped.
  await telemetry.flush();

  outputChannel?.appendLine('PgStudio extension deactivated');
}
