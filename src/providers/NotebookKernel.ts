import * as vscode from 'vscode';
import { debugLog } from '../common/logger';
import { CompletionProvider } from './kernel/CompletionProvider';
import { ParamCommentCodeActionProvider } from './kernel/ParamCommentCodeActionProvider';
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
import {
  ExportRequestHandler,
  ShowErrorMessageHandler,
  ImportRequestHandler,
  ImportPickFileHandler,
  OpenImportDataHandler,
  GridCommitPreferenceHandler,
  RunDerivedQueryHandler,
  NotebookOutputToolbarHandler,
} from '../services/handlers/CoreHandlers';

import { FkLookupHandler } from '../services/handlers/FkLookupHandler';
import { CursorWindowHandler } from '../services/handlers/CursorWindowHandler';
import { InsertRowHandler } from '../services/handlers/InsertRowHandler';
import { TelemetryService } from '../services/TelemetryService';
import { WEBVIEW_MESSAGE_TYPES } from '../common/messageTypes';
import { ConnectionUtils } from '../utils/connectionUtils';

export class PostgresKernel implements vscode.Disposable {
  readonly id = 'postgres-kernel';
  readonly label = 'PostgreSQL';
  readonly supportedLanguages = ['sql'];

  private static _languageProvidersRegistered = false;

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

    this._executor = new SqlExecutor(this._controller, this.messaging);

    // Register language providers once across all kernel instances
    if (!PostgresKernel._languageProvidersRegistered) {
      PostgresKernel._languageProvidersRegistered = true;

      context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
          { scheme: 'vscode-notebook-cell', language: 'sql' },
          new CompletionProvider(),
          ' ', '.', '"', '-' // - enables -- param comment suggestions
        )
      );

      context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
          { scheme: 'vscode-notebook-cell', language: 'sql' },
          new ParamCommentCodeActionProvider(),
          { providedCodeActionKinds: ParamCommentCodeActionProvider.providedKinds }
        )
      );
    }

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
    registry.register(WEBVIEW_MESSAGE_TYPES.EXPORT_REQUEST, new ExportRequestHandler());
    registry.register('import_request', new ImportRequestHandler());
    registry.register('import_pick_file', new ImportPickFileHandler());
    registry.register('openImportData', new OpenImportDataHandler());
    registry.register('delete_row', new DeleteRowsHandler());
    registry.register('delete_rows', new DeleteRowsHandler());


    registry.register('saveChanges', new SaveChangesHandler());
    registry.register(WEBVIEW_MESSAGE_TYPES.SHOW_ERROR_MESSAGE, new ShowErrorMessageHandler());
    registry.register(WEBVIEW_MESSAGE_TYPES.RUN_DERIVED_QUERY, new RunDerivedQueryHandler());
    registry.register('fkLookup', new FkLookupHandler());
    registry.register('resultCursorFetch', new CursorWindowHandler());
    registry.register('insertRow', new InsertRowHandler());
    registry.register(
      WEBVIEW_MESSAGE_TYPES.GRID_COMMIT_PREFERENCE,
      new GridCommitPreferenceHandler(context),
    );
    registry.register('notebookOutputToolbar', new NotebookOutputToolbarHandler());

    (this._controller as any).onDidReceiveMessage(async (event: any) => {
      // debugLog('[NotebookKernel] onDidReceiveMessage', event.message.type);
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
        await vscode.commands.executeCommand('postgres-explorer.showConnectionSafety');
        return;
      }

      if (msg.type === 'openImportData') {
        const notebook = event.editor?.notebook;
        if (!notebook) {
          return;
        }

        const metadata = notebook.metadata as any;
        if (!metadata?.connectionId) {
          vscode.window.showErrorMessage('No active connection found for this notebook.');
          return;
        }

        const targetItem = {
          label: msg.table,
          type: 'table',
          connectionId: metadata.connectionId,
          databaseName: metadata.databaseName,
          schema: msg.schema,
          tableName: msg.table,
        } as any;

        await vscode.commands.executeCommand('postgres-explorer.importData', targetItem);
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
    const telemetry = TelemetryService.getInstance();
    telemetry.trackEvent('notebook_executed', {
      cellCountBucket: cells.length < 5 ? 'lt_5' : cells.length < 20 ? '5_19' : 'gte_20',
    });
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
