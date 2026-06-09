import * as vscode from 'vscode';
import { IMessageHandler } from '../MessageHandler';
import { PostgresMetadata } from '../../common/types';
import { ConnectionManager } from '../../services/ConnectionManager';
import { ErrorHandlers } from '../../commands/helper';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { SqlExecutor } from '../../providers/kernel/SqlExecutor';
import { safelyPostMessage } from './messaging';
import { extensionContext } from '../../extension';
import { debugLog, debugWarn } from '../../common/logger';
export { FkLookupHandler } from './FkLookupHandler';

function quoteIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function buildWhereClause(
  keys: Record<string, any>,
  startParamIndex: number = 1
): { clause: string; params: any[]; nextParamIndex: number } {
  const params: any[] = [];
  const conditions: string[] = [];
  let paramIndex = startParamIndex;

  for (const [column, value] of Object.entries(keys)) {
    const quotedColumn = quoteIdentifier(column);
    if (value === null || value === undefined) {
      conditions.push(`${quotedColumn} IS NULL`);
    } else {
      conditions.push(`${quotedColumn} = $${paramIndex}`);
      params.push(value);
      paramIndex++;
    }
  }

  return {
    clause: conditions.join(' AND '),
    params,
    nextParamIndex: paramIndex
  };
}

export class ExecuteUpdateBackgroundHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    const { statements } = message;
    let client;
    try {
      const notebook = context.editor.notebook;
      const metadata = notebook.metadata as PostgresMetadata;
      if (!metadata?.connectionId) {
        throw new Error('No connection in notebook metadata');
      }

      const connection = ConnectionUtils.findConnection(metadata.connectionId);
      if (!connection) {
        throw new Error('Connection not found');
      }

      const notebookKey = `activeProfile-${notebook.uri.toString()}`;
      const activeProfileContext = extensionContext?.globalState.get<any>(notebookKey);

      const connectionConfig = {
        ...connection,
        database: metadata.databaseName || connection.database
      };

      // Apply profile overrides with floor protection
      let readOnlyMode = connection.readOnlyMode === true;
      if (metadata.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || metadata.readOnlyMode;
      }
      if (activeProfileContext?.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || activeProfileContext.readOnlyMode;
      }
      connectionConfig.readOnlyMode = readOnlyMode;

      if (connectionConfig.readOnlyMode) {
        throw new Error('Write operations are not allowed in read-only mode');
      }

      client = await ConnectionManager.getInstance().getPooledClient(connectionConfig);

      let successCount = 0;
      let errorCount = 0;
      for (const stmt of statements) {
        try {
          await client.query(stmt);
          successCount++;
        } catch (err: any) {
          errorCount++;
          await ErrorHandlers.handleCommandError(err, 'update statement');
        }
      }

      if (successCount > 0) {
        vscode.window.showInformationMessage(`Successfully updated ${successCount} row(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }
    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'background updates');
    } finally {
      if (client) client.release();
    }
  }
}

export class ExecuteUpdateHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    const { statements, cellIndex } = message;
    const notebook = context.editor.notebook;
    try {
      const query = statements.join('\n');
      await this.insertCell(notebook, cellIndex + 1, `-- Update statements generated\n${query}`);
      vscode.window.showInformationMessage(`Generated ${statements.length} UPDATE statement(s).`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to generate update script: ${err.message}`);
    }
  }

  private async insertCell(notebook: vscode.NotebookDocument, index: number, content: string) {
    const newCell = { kind: vscode.NotebookCellKind.Code, value: content, languageId: 'sql' } as vscode.NotebookCellData;
    const edit = vscode.NotebookEdit.insertCells(index, [newCell]);
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(notebook.uri, [edit]);
    await vscode.workspace.applyEdit(workspaceEdit);
  }
}

export class CancelQueryHandler implements IMessageHandler {
  async handle(message: any, context: { executor?: SqlExecutor }) {
    if (context.executor) {
      await context.executor.cancelQuery(message);
    } else {
      debugWarn('CancelQueryHandler: No executor provided in context');
    }
  }
}

export class DeleteRowsHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    debugLog('[DeleteRowsHandler] Called', message);
    const { tableInfo, rows, row } = message; // Support both 'rows' (array) and legacy 'row' (single)
    const targets = rows || (row ? [row] : []);

    if (targets.length === 0) return;

    const { schema, table, primaryKeys } = tableInfo || message;

    if (!primaryKeys || primaryKeys.length === 0) {
      vscode.window.showErrorMessage('Cannot delete: No primary keys defined for this table.');
      return;
    }

    const notebook = context.editor.notebook;
    const metadata = notebook.metadata as PostgresMetadata;
    if (!metadata?.connectionId) return;

    let client: any;
    let hasOpenTransaction = false;

    try {
      const connection = ConnectionUtils.findConnection(metadata.connectionId);
      if (!connection) throw new Error('Connection not found');

      const notebookKey = `activeProfile-${notebook.uri.toString()}`;
      const activeProfileContext = extensionContext?.globalState.get<any>(notebookKey);

      const config = {
        ...connection,
        database: metadata.databaseName || connection.database
      };

      // Apply profile overrides with floor protection
      let readOnlyMode = connection.readOnlyMode === true;
      if (metadata.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || metadata.readOnlyMode;
      }
      if (activeProfileContext?.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || activeProfileContext.readOnlyMode;
      }
      config.readOnlyMode = readOnlyMode;

      if (config.readOnlyMode) {
        throw new Error('Write operations are not allowed in read-only mode');
      }

      client = await ConnectionManager.getInstance().getSessionClient(config, notebook.uri.toString());

      const quotedSchema = quoteIdentifier(schema);
      const quotedTable = quoteIdentifier(table);
      let deletedRows = 0;

      await client.query('BEGIN');
      hasOpenTransaction = true;
      for (const targetRow of targets) {
        const keyValues = primaryKeys.reduce((acc: Record<string, any>, pk: string) => {
          acc[pk] = targetRow[pk];
          return acc;
        }, {});

        const { clause, params } = buildWhereClause(keyValues);
        const result = await client.query(
          `DELETE FROM ${quotedSchema}.${quotedTable} WHERE ${clause}`,
          params
        );
        deletedRows += result.rowCount || 0;
      }
      await client.query('COMMIT');
      hasOpenTransaction = false;

      vscode.window.showInformationMessage(`Deleted ${deletedRows} row(s) from ${schema}.${table}`);

      if (context.editor.selection) {
        const range = context.editor.selection;
        await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [range], document: context.editor.notebook.uri });
      }

    } catch (err: any) {
      if (client && hasOpenTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Best effort rollback for active transaction.
        }
      }
      vscode.window.showErrorMessage(`Failed to delete rows: ${err.message}`);
    }
  }
}

export class ScriptDeleteHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    const { schema, table, primaryKeys, rows, cellIndex } = message;
    const notebook = context.editor.notebook;

    try {
      // Construct DELETE query
      let query = '';
      for (const row of rows) {
        const conditions: string[] = [];

        for (const pk of primaryKeys) {
          const val = row[pk];
          const valStr = typeof val === 'string' ? `'${val.replace(/'/g, "''")}'` : val;
          conditions.push(`"${pk}" = ${valStr}`);
        }
        query += `DELETE FROM "${schema}"."${table}" WHERE ${conditions.join(' AND ')};\n`;
      }

      // Insert new cell with the query
      const targetIndex = cellIndex + 1;
      const newCell = { kind: vscode.NotebookCellKind.Code, value: query, languageId: 'sql' } as vscode.NotebookCellData;

      const edit = vscode.NotebookEdit.insertCells(targetIndex, [newCell]);

      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(notebook.uri, [edit]);
      await vscode.workspace.applyEdit(workspaceEdit);
    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'generate delete script');
    }
  }
}

export class SaveChangesHandler implements IMessageHandler {
  async handle(message: any, context: { editor: vscode.NotebookEditor; postMessage?: (msg: any) => Thenable<boolean> }) {
    if (!context.editor) return;

    const { updates, deletions, tableInfo } = message;
    const { schema, table } = tableInfo;
    let client;
    let hasOpenTransaction = false;
    let successCount = 0;
    let errorCount = 0;
    let deletedCount = 0;

    try {
      const notebook = context.editor.notebook;
      const metadata = notebook.metadata as PostgresMetadata;
      if (!metadata?.connectionId) {
        vscode.window.showErrorMessage('Cannot save changes: No connection in notebook metadata');
        return;
      }

      // Use ConnectionManager to get a pooled client
      const connection = ConnectionUtils.findConnection(metadata.connectionId);
      if (!connection) throw new Error('Connection not found');

      const notebookKey = `activeProfile-${notebook.uri.toString()}`;
      const activeProfileContext = extensionContext?.globalState.get<any>(notebookKey);

      const connectionConfig = {
        ...connection,
        database: metadata.databaseName || connection.database
      };

      // Apply profile overrides with floor protection
      let readOnlyMode = connection.readOnlyMode === true;
      if (metadata.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || metadata.readOnlyMode;
      }
      if (activeProfileContext?.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || activeProfileContext.readOnlyMode;
      }
      connectionConfig.readOnlyMode = readOnlyMode;

      if (connectionConfig.readOnlyMode) {
        throw new Error('Write operations are not allowed in read-only mode');
      }

      client = await ConnectionManager.getInstance().getPooledClient(connectionConfig);

      const quotedSchema = quoteIdentifier(schema);
      const quotedTable = quoteIdentifier(table);

      await client.query('BEGIN');
      hasOpenTransaction = true;

      for (const update of updates) {
        const { keys, column, value } = update;
        const quotedColumn = quoteIdentifier(column);
        const { clause, params } = buildWhereClause(keys, 2);
        await client.query(
          `UPDATE ${quotedSchema}.${quotedTable} SET ${quotedColumn} = $1 WHERE ${clause}`,
          [value, ...params]
        );
        successCount++;
      }

      // Process DELETE queries
      for (const deletion of deletions || []) {
        const { keys } = deletion;
        const { clause, params } = buildWhereClause(keys);
        await client.query(`DELETE FROM ${quotedSchema}.${quotedTable} WHERE ${clause}`, params);
        deletedCount++;
        successCount++;
      }

      await client.query('COMMIT');
      hasOpenTransaction = false;

      if (successCount > 0) {
        const parts = [];
        const updateCount = (updates?.length || 0);
        if (updateCount > 0) parts.push(`${updateCount} edit(s)`);
        if (deletedCount > 0) parts.push(`${deletedCount} deletion(s)`);

        vscode.window.showInformationMessage(`✅ Successfully saved ${parts.join(', ')}${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
        // Notify renderer to clear modified cells and remove deleted rows
        if (context.postMessage) {
          await safelyPostMessage(
            context.postMessage,
            { type: 'saveSuccess', successCount, errorCount, deletedCount },
            {
              contextLabel: 'Save Changes',
              notifyOnFailure: true,
            },
          );
        }
      } else if (errorCount > 0) {
        vscode.window.showErrorMessage(`Failed to save changes: ${errorCount} error(s)`);
      }
    } catch (err: any) {
      errorCount++;
      if (client && hasOpenTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failures and surface original error.
        }
      }
      vscode.window.showErrorMessage(`Failed to save changes: ${err.message}`);
      // Notify renderer to restore the save button
      if (context.postMessage) {
        await safelyPostMessage(
          context.postMessage,
          { type: 'saveFailed' },
          {
            contextLabel: 'Save Changes',
            notifyOnFailure: true,
          },
        );
      }
    } finally {
      if (client) client.release();
    }
  }
}
