import { Client } from 'pg';
import * as vscode from 'vscode';
import { PostgresMetadata } from './common/types';
import { PostgresKernel } from './providers/NotebookKernel';
import { ConnectionManager } from './services/ConnectionManager';
import { SecretStorageService } from './services/SecretStorageService';
import { ProfileManager } from './services/ProfileManager';
import { SavedQueriesService } from './services/SavedQueriesService';
import { ErrorHandlers } from './commands/helper';
import { registerProviders } from './activation/providers';
import { registerAllCommands } from './activation/commands';
import { NotebookStatusBar } from './activation/statusBar';
import { WhatsNewManager } from './activation/WhatsNewManager';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { QueryHistoryService } from './services/QueryHistoryService';
import { QueryPerformanceService } from './services/QueryPerformanceService';
import { ConnectionUtils } from './utils/connectionUtils';
import { ExplainProvider } from './providers/ExplainProvider';
import { MessageHandlerRegistry } from './services/MessageHandler';
import {
  ExplainErrorHandler, FixQueryHandler, AnalyzeDataHandler, OptimizeQueryHandler,
  SendToChatHandler, ShowExplainPlanHandler, ConvertExplainHandler
} from './services/handlers/ExplainHandlers';
import { ShowConnectionSwitcherHandler, ShowDatabaseSwitcherHandler, ShowErrorMessageHandler, ExportRequestHandler, RetryCellHandler, ShowConnectionInfoHandler } from './services/handlers/CoreHandlers';
import { ExecuteUpdateBackgroundHandler, ScriptDeleteHandler, SaveChangesHandler } from './services/handlers/QueryHandlers';

export let outputChannel: vscode.OutputChannel;
export let extensionContext: vscode.ExtensionContext;
export let statusBar: NotebookStatusBar;

let chatViewProvider: ChatViewProvider | undefined;

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

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('PgStudio');
  outputChannel.appendLine('Activating PgStudio extension');

  SecretStorageService.getInstance(context);
  ConnectionManager.getInstance();
  QueryHistoryService.initialize(context.workspaceState);
  QueryPerformanceService.initialize(context.globalState);

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
    await config.update('postgresExplorer.connections', migratedConnections, vscode.ConfigurationTarget.Global);
    console.log('Migrated legacy connections to include IDs');
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
  await ProfileManager.getInstance().initializeDefaultProfiles();

  const { databaseTreeProvider, treeView, chatViewProviderInstance: chatView, savedQueriesTreeProvider } = registerProviders(context, outputChannel);
  chatViewProvider = chatView;

  // Store tree view instance for reveal functionality
  (databaseTreeProvider as any).setTreeView(treeView);

  registerAllCommands(context, databaseTreeProvider, chatView, outputChannel, savedQueriesTreeProvider);

  // Kernel initialization
  const rendererMessaging = vscode.notebooks.createRendererMessaging('postgres-query-renderer');

  const kernel = new PostgresKernel(context, rendererMessaging, 'postgres-notebook', async (msg: { type: string; command: string; format?: string; content?: string; filename?: string }) => {
    if (msg.type === 'custom' && msg.command === 'export') {
      vscode.commands.executeCommand('postgres-explorer.exportData', {
        format: msg.format,
        content: msg.content,
        filename: msg.filename
      });
    }
  });
  context.subscriptions.push(kernel);

  // What's New / Welcome Screen
  const whatsNewManager = new WhatsNewManager(context, context.extensionUri);
  context.subscriptions.push(
    vscode.commands.registerCommand('postgres-explorer.showWhatsNew', () => {
      void whatsNewManager.checkAndShow(true);
    })
  );

  const queryKernel = new PostgresKernel(context, rendererMessaging, 'postgres-query');

  // Status bar for connection/database display
  statusBar = new NotebookStatusBar();
  context.subscriptions.push(statusBar);

  // Register Message Handlers
  const registry = MessageHandlerRegistry.getInstance();

  // Explain & Chat Handlers
  registry.register('explainError', new ExplainErrorHandler(chatView));
  registry.register('fixQuery', new FixQueryHandler(chatView));
  registry.register('analyzeData', new AnalyzeDataHandler(chatView));
  registry.register('optimizeQuery', new OptimizeQueryHandler(chatView));
  registry.register('sendToChat', new SendToChatHandler(chatView));
  registry.register('showExplainPlan', new ShowExplainPlanHandler(context.extensionUri));
  registry.register('convertExplainToJson', new ConvertExplainHandler(context));

  // Core Handlers
  registry.register('showConnectionSwitcher', new ShowConnectionSwitcherHandler(statusBar));
  registry.register('showDatabaseSwitcher', new ShowDatabaseSwitcherHandler(statusBar));
  registry.register('showErrorMessage', new ShowErrorMessageHandler());
  registry.register('export_request', new ExportRequestHandler());
  registry.register('retryCell', new RetryCellHandler());
  registry.register('showConnectionInfo', new ShowConnectionInfoHandler());

  // Query Execution Handlers
  registry.register('execute_update_background', new ExecuteUpdateBackgroundHandler());
  registry.register('script_delete', new ScriptDeleteHandler());
  registry.register('saveChanges', new SaveChangesHandler());

  rendererMessaging.onDidReceiveMessage(async (event) => {
    await registry.handleMessage(event.message, {
      editor: event.editor,
      postMessage: (msg) => rendererMessaging.postMessage(msg, event.editor)
    });
  });

  // Auto-generate notebook title on open
  const { updateNotebookTitle } = await import('./utils/notebookTitle');
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(async (notebook) => {
      if (notebook.notebookType === 'postgres-notebook' || notebook.notebookType === 'postgres-query') {
        await updateNotebookTitle(notebook);
      }
    })
  );

  const { migrateExistingPasswords } = await import('./services/SecretStorageService');
  await migrateExistingPasswords(context);
}

export async function deactivate() {
  outputChannel?.appendLine('Deactivating PgStudio extension - closing all connections');

  try {
    // Close all database connections (pools and sessions)
    await ConnectionManager.getInstance().closeAll();
    outputChannel?.appendLine('All database connections closed successfully');
  } catch (err) {
    outputChannel?.appendLine(`Error closing connections during deactivation: ${err}`);
    console.error('Error during extension deactivation:', err);
  }

  outputChannel?.appendLine('PgStudio extension deactivated');
}
