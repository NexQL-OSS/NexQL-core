import * as vscode from 'vscode';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { PostgresNotebookProvider } from '../notebookProvider';
import { PostgresNotebookSerializer } from '../postgresNotebook';

import { QueryCodeLensProvider } from '../providers/QueryCodeLensProvider';
import { QueryHistoryProvider } from '../providers/QueryHistoryProvider';
import { ProfilesTreeProvider, SavedQueriesTreeProvider } from '../providers/Phase7TreeProviders';

export function registerProviders(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
  // Create database tree provider instance
  const databaseTreeProvider = new DatabaseTreeProvider(context);

  // Register tree data provider and create tree view
  const treeView = vscode.window.createTreeView('postgresExplorer', {
    treeDataProvider: databaseTreeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

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

  // Register SQL completion provider
  const { SqlCompletionProvider } = require('../providers/SqlCompletionProvider');
  const sqlCompletionProvider = new SqlCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'sql' },
      sqlCompletionProvider,
      '.' // Trigger on dot for schema.table suggestions
    ),
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'vscode-notebook-cell', language: 'sql' },
      sqlCompletionProvider,
      '.'
    )
  );



  // Register Query CodeLens Provider for EXPLAIN actions
  const queryCodeLensProvider = new QueryCodeLensProvider();
  QueryCodeLensProvider.setInstance(queryCodeLensProvider);
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

  // Register Query History Provider
  const queryHistoryProvider = new QueryHistoryProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('postgresExplorer.history', queryHistoryProvider)
  );

  // Store query history provider instance for command access
  context.workspaceState.update('queryHistoryProviderInstance', queryHistoryProvider);

  // Phase 7: Register Saved Queries Tree Provider
  const savedQueriesTreeProvider = new SavedQueriesTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('postgresExplorer.savedQueries', savedQueriesTreeProvider)
  );

  return {
    databaseTreeProvider,
    treeView,
    chatViewProviderInstance,
    queryHistoryProvider,
    savedQueriesTreeProvider
  };
}
