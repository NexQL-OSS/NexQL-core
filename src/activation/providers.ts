import * as vscode from 'vscode';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { PostgresNotebookProvider } from '../features/notebook/notebookProvider';
import { PostgresNotebookSerializer } from '../features/notebook/postgresNotebook';

import { ProfilesTreeProvider, SavedQueriesTreeProvider } from '../providers/Phase7TreeProviders';
import { NotebooksTreeProvider } from '../providers/NotebooksTreeProvider';
import { AutoRefreshService } from '../services/AutoRefreshService';
import { DdlViewerService } from '../services/DdlViewerService';

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

  // Register tree data provider and create tree view
  const treeView = vscode.window.createTreeView('postgresExplorer', {
    treeDataProvider: databaseTreeProvider,
    showCollapseAll: true
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

  // Register notebook providers
  const notebookProvider = new PostgresNotebookProvider();
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('postgres-notebook', notebookProvider),
    vscode.workspace.registerNotebookSerializer('postgres-query', new PostgresNotebookSerializer())
  );

  // Register SQL completion provider, CodeLens, and query history lazily.
  runDeferredProviderTask(outputChannel, 'registerSqlCompletionProvider', async () => {
    const sqlCompletionModule = await import('../providers/SqlCompletionProvider');
    const sqlCompletionProvider = new sqlCompletionModule.SqlCompletionProvider();
    sqlCompletionModule.SqlCompletionProvider.setInstance(sqlCompletionProvider);

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
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('postgresExplorer.savedQueries', savedQueriesTreeProvider)
  );

  // Notebooks panel — browse all notebooks in globalStorage
  const notebooksTreeProvider = new NotebooksTreeProvider(context.globalStorageUri);
  const notebooksTreeView = vscode.window.createTreeView('postgresExplorer.notebooks', {
    treeDataProvider: notebooksTreeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(notebooksTreeView);

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
