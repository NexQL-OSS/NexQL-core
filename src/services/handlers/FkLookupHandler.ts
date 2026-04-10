/**
 * FkLookupHandler.ts
 * Handles FK lookup requests from the data grid.
 * Queries the referenced table and returns matching rows for the FK dropdown.
 */

import * as vscode from 'vscode';
import { IMessageHandler } from '../MessageHandler';
import { ConnectionManager } from '../ConnectionManager';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { PostgresMetadata, FkLookupRequest } from '../../common/types';

export class FkLookupHandler implements IMessageHandler {
  async handle(message: FkLookupRequest, context: {
    editor?: any;
    webview?: any;
    postMessage?: (message: any) => Thenable<boolean>;
    [key: string]: any;
  }): Promise<void> {
    const { requestId, fkSchema, fkTable, fkColumn, searchText, limit } = message;
    const postMessage = context.postMessage;
    if (!postMessage) { return; }

    const editor = context.editor;
    if (!editor) {
      return;
    }

    let client: any;
    try {
      // Get the connection from the notebook metadata
      const metadata = editor.notebook?.metadata as PostgresMetadata | undefined;
      if (!metadata?.connectionId) {
        return;
      }

      const connectionConfig = ConnectionUtils.findConnection(metadata.connectionId);
      if (!connectionConfig) {
        throw new Error('Connection not found');
      }

      client = await ConnectionManager.getInstance().getPooledClient(connectionConfig);

      const quotedSchema = `"${fkSchema.replace(/"/g, '""')}"`;
      const quotedTable = `"${fkTable.replace(/"/g, '""')}"`;
      const quotedColumn = `"${fkColumn.replace(/"/g, '""')}"`;
      const trimmedSearchText = searchText.trim();
      const clampedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

      let query: string;
      let params: any[];

      if (trimmedSearchText) {
        query = `
          SELECT ${quotedColumn}
          FROM ${quotedSchema}.${quotedTable}
          WHERE ${quotedColumn} = $1 OR ${quotedColumn}::text ILIKE $2
          ORDER BY ${quotedColumn}
          LIMIT $3
        `;
        params = [trimmedSearchText, `%${trimmedSearchText}%`, clampedLimit];
      } else {
        query = `
          SELECT ${quotedColumn}
          FROM ${quotedSchema}.${quotedTable}
          ORDER BY ${quotedColumn}
          LIMIT $1
        `;
        params = [clampedLimit];
      }

      const result = await client.query(query, params);
      const columns = Array.isArray(result.fields) && result.fields.length > 0
        ? result.fields.map((field: any) => field.name)
        : Object.keys(result.rows?.[0] || {});

      postMessage({
        type: 'fkLookupResponse',
        requestId,
        rows: result.rows,
        columns,
      });
    } catch (err) {
      console.error('FkLookupHandler error:', err);
      const message = err instanceof Error ? err.message : String(err);
      await vscode.window.showErrorMessage(`FK lookup failed: ${message}`);
      await postMessage({ type: 'fkLookupResponse', requestId, rows: [], columns: [] });
    } finally {
      if (client) { client.release(); }
    }
  }
}
