import * as vscode from 'vscode';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { DatabaseTreeProvider, DatabaseDragAndDropController } from '../providers/DatabaseTreeProvider';
import { DatabaseTreeDocumentDropProvider } from '../providers/DatabaseTreeDocumentDropProvider';
import { PostgresNotebookProvider } from '../features/notebook/notebookProvider';
import { PostgresNotebookSerializer } from '../features/notebook/postgresNotebook';

import { ProfilesTreeProvider, SavedQueriesTreeProvider, SavedQueriesDragAndDropController } from '../providers/Phase7TreeProviders';
import { NotebooksTreeProvider, NotebooksDragAndDropController } from '../providers/NotebooksTreeProvider';
import { AutoRefreshService } from '../services/AutoRefreshService';
import { DdlViewerService } from '../services/DdlViewerService';
import { LicenseService } from '../services/LicenseService';
import { NotebookIndexService } from '../services/NotebookIndexService';
import { McpDefinitionProvider } from '../mcp/McpDefinitionProvider';
import { NexqlMcpServer } from '../mcp/NexqlMcpServer';

function runDeferredProviderTask(outputChannel: vscode.OutputChannel, taskName: string, task: () => Promise<void>) {
  setTimeout(() => {
    void (async () => {
      const start = Date.now();
      try {
        await task();
        outputChannel.appendLine(`[startup/deferred-provider] ${taskName} completed in ${Date.now() - start}ms`);
      } catch (error) {
        outputChannel.appendLine(`[startup/deferred-provider] ${taskName} failed: ${error}`);
      }
    })();
  }, 0);
}

export function registerProviders(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
  // Create database tree provider instance
  const databaseTreeProvider = new DatabaseTreeProvider(context);

  // Refresh tree when license changes
  context.subscriptions.push(
    LicenseService.getInstance().onDidChangeLicense(() => {
      databaseTreeProvider.refresh();
    })
  );

  // Refresh tree when active color theme changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      try {
        const { clearIconCache } = require('../providers/tree/treeIconTheme');
        clearIconCache();
      } catch (err) {
        outputChannel.appendLine(`Failed to clear icon cache on theme change: ${err}`);
      }
      databaseTreeProvider.refresh();
    })
  );

  // Register tree data provider and create tree view
  const databaseDragAndDropController = new DatabaseDragAndDropController(databaseTreeProvider, context);
  const treeView = vscode.window.createTreeView('postgresExplorer', {
    treeDataProvider: databaseTreeProvider,
    showCollapseAll: true,
    dragAndDropController: databaseDragAndDropController
  });
  context.subscriptions.push(treeView);
  const ddlViewerService = new DdlViewerService(context, treeView);
  context.subscriptions.push(ddlViewerService);

  // Update context key when selection changes to enable Add/Remove favorites menu switching
  treeView.onDidChangeSelection(e => {
    if (e.selection.length > 0) {
      const item = e.selection[0];
      vscode.commands.executeCommand('setContext', 'postgresExplorer.isFavorite', item.isFavorite === true);
    } else {
      vscode.commands.executeCommand('setContext', 'postgresExplorer.isFavorite', false);
    }
  });

  // Register the chat view provider
  const chatViewProviderInstance = new ChatViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProviderInstance,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // MCP server: exposes NexQL's read-only DB tools to external agents (Claude Code,
  // Copilot, ...) over local Streamable HTTP with a per-session bearer token. Gated
  // behind a setting — off by default; the server binds lazily on first client attach.
  {
    const isMcpEnabled = () =>
      vscode.workspace.getConfiguration().get<boolean>('postgresExplorer.mcp.enabled', false);

    const mcpServer = new NexqlMcpServer(context);
    const mcpProvider = new McpDefinitionProvider(mcpServer, isMcpEnabled);
    context.subscriptions.push(mcpServer, mcpProvider);
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('postgresExplorer.mcpServerProvider', mcpProvider)
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('postgresExplorer.mcp.enabled')) {
          mcpProvider.refresh();
        }
      })
    );
  }

  // Register notebook providers
  const notebookProvider = new PostgresNotebookProvider();
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('postgres-notebook', notebookProvider),
    vscode.workspace.registerNotebookSerializer('postgres-query', new PostgresNotebookSerializer())
  );

  // Intercept drops from the DB explorer tree into notebook cell editors.
  const documentDropProvider = new DatabaseTreeDocumentDropProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentDropEditProvider(
      { scheme: 'vscode-notebook-cell', language: 'sql' },
      documentDropProvider
    ),
    vscode.languages.registerDocumentDropEditProvider(
      { scheme: 'vscode-notebook-cell', language: 'postgres' },
      documentDropProvider
    )
  );

  // Register SQL completion provider, CodeLens, and query history lazily.
  runDeferredProviderTask(outputChannel, 'registerSqlCompletionProvider', async () => {
    const sqlCompletionModule = await import('../providers/SqlCompletionProvider');
    const sqlSigModule = await import('../providers/SqlSignatureHelpProvider');
    const sqlCompletionProvider = new sqlCompletionModule.SqlCompletionProvider();
    sqlCompletionModule.SqlCompletionProvider.setInstance(sqlCompletionProvider);
    const sqlSignatureHelpProvider = new sqlSigModule.SqlSignatureHelpProvider();

    const warmSqlCompletionCache = (notebook: vscode.NotebookDocument) => {
      const meta = notebook.metadata as { connectionId?: string; databaseName?: string } | undefined;
      if (!meta?.connectionId) {
        return;
      }
      const nbType = notebook.notebookType;
      if (nbType !== 'postgres-notebook' && nbType !== 'postgres-query') {
        return;
      }
      const database = meta.databaseName || 'postgres';
      void sqlCompletionProvider.warmCache(meta.connectionId, database);
    };

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { scheme: 'vscode-notebook-cell', language: 'sql' },
        sqlCompletionProvider,
        '.', ' '
      ),
      vscode.languages.registerSignatureHelpProvider(
        { scheme: 'vscode-notebook-cell', language: 'sql' },
        sqlSignatureHelpProvider,
        '(', ','
      ),
      vscode.workspace.onDidOpenNotebookDocument(doc => {
        warmSqlCompletionCache(doc);
      })
    );

    for (const nb of vscode.workspace.notebookDocuments) {
      warmSqlCompletionCache(nb);
    }
  });

  runDeferredProviderTask(outputChannel, 'registerQueryCodeLensProvider', async () => {
    const queryCodeLensModule = await import('../providers/QueryCodeLensProvider');
    const queryCodeLensProvider = new queryCodeLensModule.QueryCodeLensProvider();
    queryCodeLensModule.QueryCodeLensProvider.setInstance(queryCodeLensProvider);

    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        { language: 'postgres', scheme: 'vscode-notebook-cell' },
        queryCodeLensProvider
      ),
      vscode.languages.registerCodeLensProvider(
        { language: 'sql', scheme: 'vscode-notebook-cell' },
        queryCodeLensProvider
      )
    );
    outputChannel.appendLine('QueryCodeLensProvider registered for EXPLAIN actions.');
  });

  runDeferredProviderTask(outputChannel, 'registerQueryHistoryProvider', async () => {
    const queryHistoryModule = await import('../providers/QueryHistoryProvider');
    const queryHistoryProvider = new queryHistoryModule.QueryHistoryProvider();

    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('postgresExplorer.history', queryHistoryProvider)
    );

    // Store query history provider instance for command access
    await context.workspaceState.update('queryHistoryProviderInstance', queryHistoryProvider);
  });

  // Phase 7: Register Saved Queries Tree Provider
  const savedQueriesTreeProvider = new SavedQueriesTreeProvider();
  const savedQueriesDragAndDropController = new SavedQueriesDragAndDropController();
  const savedQueriesTreeView = vscode.window.createTreeView('postgresExplorer.savedQueries', {
    treeDataProvider: savedQueriesTreeProvider,
    dragAndDropController: savedQueriesDragAndDropController
  });
  context.subscriptions.push(savedQueriesTreeView);

  // Notebooks panel — browse all notebooks in globalStorage
  const notebooksTreeProvider = new NotebooksTreeProvider(context.globalStorageUri, context);
  const notebooksDragAndDropController = new NotebooksDragAndDropController();
  const notebooksTreeView = vscode.window.createTreeView('postgresExplorer.notebooks', {
    treeDataProvider: notebooksTreeProvider,
    showCollapseAll: true,
    dragAndDropController: notebooksDragAndDropController
  });
  context.subscriptions.push(notebooksTreeView);

  // Initialize NotebookIndexService on startup
  const notebookIndexService = NotebookIndexService.initialize(context.globalStorageUri);
  notebookIndexService.ensureInitialized().then(() => {
    databaseTreeProvider.refresh();
    notebooksTreeProvider.refresh();
  });

  // Track MRU notebooks when notebook documents are opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(async doc => {
      const nbType = doc.notebookType;
      if (nbType === 'postgres-notebook' || nbType === 'postgres-query') {
        const uri = doc.uri;
        if (uri.scheme === 'file') {
          const mru = context.globalState.get<string[]>('postgresExplorer.mruNotebooks', []) || [];
          const updatedMru = [uri.fsPath, ...mru.filter(p => p !== uri.fsPath)].slice(0, 50);
          await context.globalState.update('postgresExplorer.mruNotebooks', updatedMru);
        }
      }
    })
  );

  // Auto-refresh service — keeps the explorer and notebooks panel in sync
  const autoRefreshService = new AutoRefreshService(
    databaseTreeProvider,
    notebooksTreeProvider,
    context.globalStorageUri,
    outputChannel
  );
  autoRefreshService.start();
  databaseTreeProvider.setAutoRefreshService(autoRefreshService);

  return {
    databaseTreeProvider,
    treeView,
    ddlViewerService,
    chatViewProviderInstance,
    queryHistoryProvider: undefined,
    savedQueriesTreeProvider,
    notebooksTreeProvider,
    autoRefreshService
  };
}
