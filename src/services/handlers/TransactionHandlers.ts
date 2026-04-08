import * as vscode from 'vscode';
import { IMessageHandler } from '../MessageHandler';
import { getTransactionManager, IsolationLevel } from '../../services/TransactionManager';
import { ConnectionManager } from '../../services/ConnectionManager';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { PostgresMetadata } from '../../common/types';
import { statusBar } from '../../extension';

async function getSessionClient(notebook: vscode.NotebookDocument): Promise<any> {
  const metadata = notebook.metadata as PostgresMetadata;
  if (!metadata?.connectionId) throw new Error('No connection found');

  const connection = ConnectionUtils.findConnection(metadata.connectionId);
  if (!connection) throw new Error('Connection not found');

  return await ConnectionManager.getInstance().getSessionClient({
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    database: metadata.databaseName || connection.database,
    name: connection.name
  }, notebook.uri.toString());
}

export class TransactionBeginHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;
    try {
      const notebook = context.editor.notebook;
      const client = await getSessionClient(notebook);
      const sessionId = notebook.uri.toString();
      const txManager = getTransactionManager();
      const { isolationLevel = 'READ COMMITTED', readOnly = false, deferrable = false } = message;

      await txManager.beginTransaction(client, sessionId, isolationLevel as IsolationLevel, readOnly, deferrable);

      const summary = txManager.getTransactionSummary(sessionId);
      vscode.window.showInformationMessage(summary);
      statusBar?.updateTransactionState(sessionId);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to begin transaction: ${err.message}`);
    }
  }
}

export class TransactionCommitHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;
    try {
      const notebook = context.editor.notebook;
      const client = await getSessionClient(notebook);
      const sessionId = notebook.uri.toString();
      const txManager = getTransactionManager();

      await txManager.commitTransaction(client, sessionId);
      vscode.window.showInformationMessage('✅ Transaction committed');
      statusBar?.updateTransactionState(sessionId);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to commit transaction: ${err.message}`);
    }
  }
}

export class TransactionRollbackHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;
    try {
      const notebook = context.editor.notebook;
      const client = await getSessionClient(notebook);
      const sessionId = notebook.uri.toString();
      const txManager = getTransactionManager();

      await txManager.rollbackTransaction(client, sessionId);
      vscode.window.showInformationMessage('⏮️ Transaction rolled back');
      statusBar?.updateTransactionState(sessionId);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to rollback transaction: ${err.message}`);
    }
  }
}

export class SavepointCreateHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;
    try {
      const notebook = context.editor.notebook;
      const client = await getSessionClient(notebook);
      const sessionId = notebook.uri.toString();
      const txManager = getTransactionManager();

      const savepointName = await txManager.createSavepoint(client, sessionId);
      vscode.window.showInformationMessage(`📍 Savepoint created: ${savepointName}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to create savepoint: ${err.message}`);
    }
  }
}

export class SavepointReleaseHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;
    try {
      const notebook = context.editor.notebook;
      const client = await getSessionClient(notebook);
      const sessionId = notebook.uri.toString();
      const txManager = getTransactionManager();
      const { savepointName } = message;

      await txManager.releaseSavepoint(client, sessionId, savepointName);
      vscode.window.showInformationMessage(`✓ Savepoint released: ${savepointName || 'latest'}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to release savepoint: ${err.message}`);
    }
  }
}

export class SavepointRollbackHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;
    try {
      const notebook = context.editor.notebook;
      const client = await getSessionClient(notebook);
      const sessionId = notebook.uri.toString();
      const txManager = getTransactionManager();
      const { savepointName } = message;

      await txManager.rollbackToSavepoint(client, sessionId, savepointName);
      vscode.window.showInformationMessage(`⏮️ Rolled back to savepoint: ${savepointName || 'latest'}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to rollback savepoint: ${err.message}`);
    }
  }
}
