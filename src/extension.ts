import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ConnectionManager } from './services/ConnectionManager';
import { SecretStorageService } from './services/SecretStorageService';
import { LicenseService } from './services/LicenseService';
import { requirePro, ProFeature } from './services/featureGates';
import { ProfileManager } from './features/connections/ProfileManager';
import { SavedQueriesService } from './features/savedQueries/SavedQueriesService';
import { NotebookBuilder } from './commands/helper';
import { SessionRegistry } from './services/SessionRegistry';
import type { NotebookStatusBar } from './activation/statusBar';
import type { ChatViewProvider } from './providers/ChatViewProvider';
import { QueryHistoryService } from './services/QueryHistoryService';
import { QueryPerformanceService } from './services/QueryPerformanceService';
import { WorkspaceStateService } from './services/WorkspaceStateService';
import { QuotaService } from './services/QuotaService';
import { invalidateAiUsageCache } from './services/aiUsage';
import { MessageHandlerRegistry } from './services/MessageHandler';
import { TelemetryService } from './services/TelemetryService';
import { WEBVIEW_MESSAGE_TYPES } from './common/messageTypes';
import { PlanStoreWorkspace } from './features/planStudio/PlanStoreWorkspace';
import { PlanStudioPanel } from './features/planStudio/PlanStudioPanel';
import { ConnectionConfig } from './common/types';

export let outputChannel: vscode.OutputChannel;
export let extensionContext: vscode.ExtensionContext;
export let statusBar: NotebookStatusBar;
export let sentinelContextService: import('./features/sentinel').SentinelContextService | undefined;
export let sentinelThemeSwapService: import('./features/sentinel').SentinelThemeSwapService | undefined;

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
  context: vscode.ExtensionContext,
  planStore: PlanStoreWorkspace
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
  registry.register('showExplainPlan', new explainHandlersModule.ShowExplainPlanHandler(context.extensionUri, planStore));
  registry.register('convertExplainToJson', new explainHandlersModule.ConvertExplainHandler(context, planStore));
  registry.register('openPlanStudio', new explainHandlersModule.OpenPlanStudioHandler(context.extensionUri, planStore));
  registry.register('syncPlanStudioFromRun', new explainHandlersModule.SyncPlanStudioFromRunHandler(context.extensionUri, planStore));

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

  outputChannel = vscode.window.createOutputChannel('NexQL');
  outputChannel.appendLine('Activating NexQL extension');

  const { OpencodeServeManager } = await import('./features/aiAssistant/opencode');
  OpencodeServeManager.getInstance().init(context);
  const telemetry = TelemetryService.getInstance();
  telemetry.initialize(context);
  telemetry.trackEvent('extension_activated', {});
  telemetry.trackDailyActiveUser();

  SecretStorageService.getInstance(context);
  LicenseService.getInstance(context);
  const { AiCredentialsService } = await import('./features/aiAssistant/AiCredentialsService');
  AiCredentialsService.getInstance(context);
  const { AiModelCatalogService } = await import('./features/aiAssistant/AiModelCatalogService');
  AiModelCatalogService.getInstance(context);
  ConnectionManager.getInstance();
  QueryHistoryService.initialize(context.workspaceState);
  QueryPerformanceService.initialize(context.globalState);

  WorkspaceStateService.getInstance().initialize(context);
  context.subscriptions.push({ dispose: () => WorkspaceStateService.getInstance().dispose() });

  // Freemium usage metering (per-feature daily/weekly free quotas).
  QuotaService.getInstance().initialize(context);
  // PROD DDL audit trail (Singularity feature).
  const { AuditLogService } = await import('./features/audit/AuditLogService');
  AuditLogService.getInstance().initialize(context);
  const planStore = new PlanStoreWorkspace(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('postgres-explorer.rerunPlanQuery', async (args?: { planId?: string; withAnalyze?: boolean }) => {
      const planId = args?.planId;
      if (!planId) {
        vscode.window.showErrorMessage('Missing plan id for re-run.');
        return;
      }

      const plan = planStore.getPlanById(planId);
      if (!plan) {
        vscode.window.showErrorMessage('Plan not found in workspace history.');
        return;
      }
      if (!plan.query?.trim()) {
        vscode.window.showErrorMessage('Plan has no query to re-run.');
        return;
      }

      let resolvedConnectionId = plan.connectionId;
      let resolvedDatabaseName = plan.databaseName;
      if ((!resolvedConnectionId || !resolvedDatabaseName) && plan.notebookUri) {
        try {
          const notebookUri = vscode.Uri.parse(plan.notebookUri);
          const notebook =
            vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === notebookUri.toString()) ??
            await vscode.workspace.openNotebookDocument(notebookUri);
          const metadata = notebook.metadata as {
            connectionId?: string;
            databaseName?: string;
            database?: string;
          };
          resolvedConnectionId = resolvedConnectionId ?? metadata.connectionId;
          resolvedDatabaseName = resolvedDatabaseName ?? metadata.databaseName ?? metadata.database;
        } catch (error) {
          outputChannel.appendLine(`[plan-studio] failed notebook context recovery for ${planId}: ${String(error)}`);
        }
      }
      if (!resolvedConnectionId || !resolvedDatabaseName) {
        vscode.window.showErrorMessage('Plan is missing connection/database context.');
        return;
      }

      const configuredConnections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const configuredConnection = configuredConnections.find((item) => item.id === resolvedConnectionId);
      if (!configuredConnection) {
        vscode.window.showErrorMessage('Connection not found in current settings.');
        return;
      }

      const connection: ConnectionConfig = {
        id: configuredConnection.id,
        name: configuredConnection.name,
        host: configuredConnection.host,
        port: configuredConnection.port,
        username: configuredConnection.username,
        database: resolvedDatabaseName,
        sslmode: configuredConnection.sslmode,
        connectTimeout: configuredConnection.connectTimeout,
      };

      const extractInnerQuery = (sql: string): string => {
        const src = sql.trim();
        const explainPrefix = src.match(/^EXPLAIN\b/i);
        if (!explainPrefix) {
          return src;
        }

        let i = explainPrefix[0].length;
        const len = src.length;
        const skipWs = () => {
          while (i < len && /\s/.test(src[i])) {
            i++;
          }
        };

        skipWs();
        if (src[i] === '(') {
          let depth = 0;
          while (i < len) {
            const ch = src[i];
            if (ch === '(') {
              depth++;
            }
            if (ch === ')') {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            }
            i++;
          }
        } else {
          const optionTokens = new Set([
            'ANALYZE',
            'ANALYSE',
            'VERBOSE',
            'COSTS',
            'SETTINGS',
            'BUFFERS',
            'WAL',
            'TIMING',
            'SUMMARY',
            'FORMAT',
            'TRUE',
            'FALSE',
            'TEXT',
            'XML',
            'JSON',
            'YAML',
            'ON',
            'OFF',
          ]);
          while (i < len) {
            skipWs();
            const tokenMatch = src.slice(i).match(/^([A-Za-z_]+)/);
            if (!tokenMatch) {
              break;
            }
            const token = tokenMatch[1].toUpperCase();
            if (!optionTokens.has(token)) {
              break;
            }
            i += tokenMatch[1].length;
          }
        }

        skipWs();
        return src.slice(i).trim();
      };

      const innerQuery = extractInnerQuery(plan.query);
      const withAnalyze = args?.withAnalyze === true;
      const explainSql = withAnalyze
        ? `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS, VERBOSE)\n${innerQuery}`
        : `EXPLAIN (FORMAT JSON)\n${innerQuery}`;

      let client: any;
      try {
        client = await ConnectionManager.getInstance().getPooledClient(connection);
        const result = await client.query(explainSql);
        const planCell = result.rows?.[0]?.['QUERY PLAN'] ?? result.rows?.[0]?.query_plan;
        if (!planCell) {
          vscode.window.showErrorMessage('Re-run succeeded but returned no plan payload.');
          return;
        }

        const explainPlan = typeof planCell === 'string' ? JSON.parse(planCell) : planCell;
        if (!(await requirePro(ProFeature.ExplainStudio, context))) return;
        PlanStudioPanel.show(context.extensionUri, planStore, {
          plan: explainPlan,
          query: plan.query,
          connectionId: resolvedConnectionId,
          databaseName: resolvedDatabaseName,
          source: plan.source,
          sourceCellIndex: plan.sourceCellIndex,
          performanceAnalysis: plan.performanceAnalysis,
          notebookUri: plan.notebookUri,
        });
      } catch (error: any) {
        const message = error?.message || String(error);
        vscode.window.showErrorMessage(`Failed to re-run plan query: ${message}`);
        outputChannel.appendLine(`[plan-studio] re-run failed for ${planId}: ${message}`);
      } finally {
        client?.release?.();
      }
    }),
    vscode.commands.registerCommand('postgres-explorer.openPlanSourceCell', async (args?: { planId?: string }) => {
      const planId = args?.planId;
      if (!planId) {
        vscode.window.showErrorMessage('Missing plan id.');
        return;
      }

      const plan = planStore.getPlanById(planId);
      if (!plan) {
        vscode.window.showErrorMessage('Plan not found in workspace history.');
        return;
      }
      if (!plan.notebookUri || typeof plan.sourceCellIndex !== 'number') {
        vscode.window.showInformationMessage('This plan is not linked to a source notebook cell.');
        return;
      }

      try {
        const notebookUri = vscode.Uri.parse(plan.notebookUri);
        const notebook = await vscode.workspace.openNotebookDocument(notebookUri);
        const editor = await vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
        const index = Math.max(0, Math.min(plan.sourceCellIndex, notebook.cellCount - 1));
        editor.selections = [new vscode.NotebookRange(index, index + 1)];
        editor.revealRange(new vscode.NotebookRange(index, index + 1), vscode.NotebookEditorRevealType.AtTop);
      } catch (error: any) {
        const message = error?.message || String(error);
        vscode.window.showErrorMessage(`Failed to open source cell: ${message}`);
      }
    })
  );

  // Migration: Ensure all connections have an ID (legacy connections might not)
  const config = vscode.workspace.getConfiguration();
  const connections = config.get<any[]>('postgresExplorer.connections') || [];
  let hasChanges = false;

  const migratedConnections = connections.map((conn) => {
    if (!conn.id) {
      hasChanges = true;
      const fp = `${conn.host ?? ''}:${conn.port ?? 5432}:${conn.username ?? conn.user ?? ''}:${conn.database ?? conn.dbname ?? ''}`;
      return { ...conn, id: `legacy-${crypto.createHash('sha256').update(fp).digest('hex').slice(0, 16)}` };
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

  const {
    SentinelAccentService,
    SentinelContextService,
    NotebookContextStripService,
    SentinelThemeSwapService,
    SentinelTabDecorationProvider,
    registerSentinelCommands,
  } = await import('./features/sentinel');
  const sentinelAccent = new SentinelAccentService(context);
  const sentinelThemeSwap = new SentinelThemeSwapService(context);
  sentinelThemeSwapService = sentinelThemeSwap;
  const sentinelStrip = new NotebookContextStripService(rendererMessaging);
  sentinelContextService = new SentinelContextService(context, sentinelAccent, sentinelThemeSwap, sentinelStrip);
  sentinelContextService.attachStatusBar(statusBar);
  const tabDecorations = new SentinelTabDecorationProvider();
  sentinelContextService.attachTabDecorations(tabDecorations);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(tabDecorations),
    sentinelAccent,
    sentinelThemeSwap,
    sentinelContextService,
  );
  registerSentinelCommands(context, () => sentinelContextService);

  if (chatView) {
    const pushChatSentinel = () => chatView.syncSentinelContext(sentinelContextService!.getChatContext());
    context.subscriptions.push(
      sentinelContextService.onDidChangeContext(() => pushChatSentinel()),
    );
    pushChatSentinel();
  }

  const { SyncController } = await import('./features/sync/SyncController');
  const syncController = SyncController.getInstance(context, outputChannel);
  const syncStatusBar = new statusBarModule.SyncStatusBar();
  context.subscriptions.push(syncStatusBar);
  syncController.initialize(syncStatusBar);
  context.subscriptions.push(syncController);
  context.subscriptions.push(
    syncController.onDidCompleteSync(() => {
      databaseTreeProvider?.refresh();
      notebooksTreeProvider?.refresh();
      savedQueriesTreeProvider?.refresh();
    }),
  );

  // License tier indicator
  const license = LicenseService.getInstance();
  const reflectTier = () => {
    const s = license.getStatus();
    statusBar.updateTier(s.tier, s.offline);
    invalidateAiUsageCache();
  };
  reflectTier();
  context.subscriptions.push(
    license.onDidChangeLicense(() => reflectTier()),
    // Auto-index scan once the real tier is known (license.initialize() fires
    // this event), and again on mid-session license activation/upgrade.
    license.onDidChangeLicense(() => {
      void import('./features/dbindex/AutoIndexService').then(m =>
        m.AutoIndexService.initialize(context.globalStorageUri, outputChannel).ensureAll()
      ).catch(err => outputChannel.appendLine(`[AutoIndex] Activation scan failed: ${err}`));
    }),
    {
      dispose: () => {
        void import('./features/dbindex/AutoIndexService')
          .then(m => m.AutoIndexService.getInstance()?.dispose())
          .catch(() => { /* never loaded */ });
      },
    },
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        license.onWindowFocused();
      }
    }),
    { dispose: () => license.dispose() },
    vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        if (uri.path === '/activate') {
          const key = new URLSearchParams(uri.query).get('key');
          if (key) {
            await vscode.commands.executeCommand('postgres-explorer.license.activate', key);
          }
        }
      },
    }),
  );
  runDeferredStartupTask('initializeLicense', async () => {
    await license.initialize();
    reflectTier();
  });

  // Register Message Handlers
  const registry = MessageHandlerRegistry.getInstance();
  let handlersInitialized = false;

  rendererMessaging.onDidReceiveMessage(async (event) => {
    if (!handlersInitialized) {
      await ensureRendererMessageHandlers(registry, chatView, statusBar!, context, planStore);
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

  runDeferredStartupTask('migrateAiCredentialsAndSettings', async () => {
    const { migrateAiCredentialsAndSettings } = await import('./features/aiAssistant/AiCredentialsService');
    await migrateAiCredentialsAndSettings(context);
  });

  outputChannel.appendLine(`NexQL activation completed in ${Date.now() - activationStart}ms`);
}

export async function deactivate() {
  outputChannel?.appendLine('Deactivating NexQL extension - closing all connections');
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

  try {
    const { OpencodeServeManager } = await import('./features/aiAssistant/opencode');
    OpencodeServeManager.getInstance().dispose();
  } catch {
    // ignore if module unavailable
  }

  outputChannel?.appendLine('NexQL extension deactivated');
}
