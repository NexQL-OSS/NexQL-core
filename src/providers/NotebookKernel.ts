import * as vscode from 'vscode';
import { CompletionProvider } from './kernel/CompletionProvider';
import { SqlExecutor } from './kernel/SqlExecutor';
import { getTransactionManager } from '../services/TransactionManager';
import { MessageHandlerRegistry } from '../services/MessageHandler';
import {
  TransactionBeginHandler, TransactionCommitHandler, TransactionRollbackHandler,
  SavepointCreateHandler, SavepointReleaseHandler, SavepointRollbackHandler
} from '../services/handlers/TransactionHandlers';
import {
  ExecuteUpdateBackgroundHandler, ScriptDeleteHandler, ExecuteUpdateHandler,
  CancelQueryHandler, DeleteRowsHandler, SaveChangesHandler
} from '../services/handlers/QueryHandlers';
import { ExportRequestHandler, ShowErrorMessageHandler, ImportRequestHandler, ImportPickFileHandler } from '../services/handlers/CoreHandlers';
import { SendToChatHandler } from '../services/handlers/ExplainHandlers';

export class PostgresKernel implements vscode.Disposable {
  readonly id = 'postgres-kernel';
  readonly label = 'PostgreSQL';
  readonly supportedLanguages = ['sql'];

  private readonly _controller: vscode.NotebookController;
  private readonly _executor: SqlExecutor;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly messaging: vscode.NotebookRendererMessaging,
    viewType: string = 'postgres-notebook',
    messageHandler?: (message: any) => void
  ) {
    this._controller = vscode.notebooks.createNotebookController(
      this.id + '-' + viewType,
      viewType,
      this.label
    );

    // this._controller.supportedLanguages = this.supportedLanguages; // Support all languages to avoid issues with detection
    this._controller.supportsExecutionOrder = true;
    this._controller.executeHandler = this._executeAll.bind(this);

    this._executor = new SqlExecutor(this._controller);

    // Register completion provider
    const completionProvider = new CompletionProvider();
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { scheme: 'vscode-notebook-cell', language: 'sql' },
        completionProvider,
        ' ', '.', '"' // Trigger characters
      )
    );

    // Handle messages from renderer
    const registry = MessageHandlerRegistry.getInstance();

    // Register Handlers
    registry.register('transaction_begin', new TransactionBeginHandler());
    registry.register('transaction_commit', new TransactionCommitHandler());
    registry.register('transaction_rollback', new TransactionRollbackHandler());
    registry.register('savepoint_create', new SavepointCreateHandler());
    registry.register('savepoint_release', new SavepointReleaseHandler());
    registry.register('savepoint_rollback', new SavepointRollbackHandler());

    // Renderer-side camelCase aliases for commit/rollback (posted by TransactionBanner)
    registry.register('commitTransaction', new TransactionCommitHandler());
    registry.register('rollbackTransaction', new TransactionRollbackHandler());

    registry.register('cancel_query', new CancelQueryHandler());
    registry.register('execute_update_background', new ExecuteUpdateBackgroundHandler());
    registry.register('script_delete', new ScriptDeleteHandler());
    registry.register('execute_update', new ExecuteUpdateHandler());
    registry.register('export_request', new ExportRequestHandler());
    registry.register('import_request', new ImportRequestHandler());
    registry.register('import_pick_file', new ImportPickFileHandler());
    registry.register('delete_row', new DeleteRowsHandler());
    registry.register('delete_rows', new DeleteRowsHandler());
    registry.register('sendToChat', new SendToChatHandler(undefined));

    registry.register('saveChanges', new SaveChangesHandler());
    registry.register('showErrorMessage', new ShowErrorMessageHandler());

    (this._controller as any).onDidReceiveMessage(async (event: any) => {
      // console.log('[NotebookKernel] onDidReceiveMessage', event.message.type);
      const msg = event.message;

      // Handle notebook-level TopBar actions
      if (msg.type === 'runAll') {
        const notebook = event.editor?.notebook;
        if (notebook) {
          await vscode.commands.executeCommand('notebook.execute', notebook.uri);
        }
        return;
      }
      if (msg.type === 'clearOutputs') {
        const notebook = event.editor?.notebook;
        if (notebook) {
          await vscode.commands.executeCommand('notebook.clearAllCellsOutputs', notebook.uri);
        }
        return;
      }
      if (msg.type === 'addCodeCell') {
        await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
        return;
      }
      if (msg.type === 'addMarkdownCell') {
        await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
        return;
      }
      if (msg.type === 'showConnectionInfo') {
        const notebook = event.editor?.notebook;
        if (notebook) {
          const metadata = notebook.metadata as any;
          const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
          const conn = connections.find(c => c.id === metadata?.connectionId);
          if (conn) {
            vscode.window.showInformationMessage(
              `Connection: ${conn.name || conn.host} | Host: ${conn.host}:${conn.port} | Database: ${metadata?.databaseName || conn.database}`
            );
          } else {
            vscode.window.showInformationMessage('No active connection for this notebook.');
          }
        }
        return;
      }

      await registry.handleMessage(msg, {
        editor: event.editor,
        executor: this._executor,
        postMessage: (msg) => this.messaging.postMessage(msg, event.editor)
      });
    });
  }

  private async _executeAll(cells: vscode.NotebookCell[], _notebook: vscode.NotebookDocument, _controller: vscode.NotebookController): Promise<void> {
    for (const cell of cells) {
      await this._executor.executeCell(cell);
    }
  }

  dispose() {
    // getTransactionManager() call kept for consistency with previous code if it has side effects, though it seems unused.
    getTransactionManager();
    this._controller.dispose();
  }
}
