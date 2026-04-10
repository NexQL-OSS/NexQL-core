/**
 * InsertRowHandler.ts
 * Handles in-grid INSERT of a new row.
 * Executes the INSERT and returns the actual inserted row (with DB defaults applied).
 */

import { IMessageHandler } from '../MessageHandler';
import { ConnectionManager } from '../ConnectionManager';
import { PostgresMetadata, TableInfo } from '../../common/types';

interface InsertRowMessage {
  type: 'insertRow';
  tableInfo: TableInfo;
  values: Record<string, any>;
  tempId: string;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class InsertRowHandler implements IMessageHandler {
  async handle(message: InsertRowMessage, context: {
    editor?: any;
    webview?: any;
    postMessage?: (message: any) => Thenable<boolean>;
    [key: string]: any;
  }): Promise<void> {
    const { tableInfo, values, tempId } = message;
    const postMessage = context.postMessage;
    if (!postMessage) { return; }

    const editor = context.editor;
    if (!editor?.notebook?.metadata?.connectionId) {
      postMessage({ type: 'insertFailed', tempId, error: 'No active connection found' });
      return;
    }

    const metadata = editor.notebook.metadata as PostgresMetadata;
    let client: any;

    try {
      const connectionConfig = {
        id: metadata.connectionId,
        name: metadata.host,
        host: metadata.host,
        port: metadata.port,
        username: metadata.username,
        database: metadata.databaseName,
      };

      client = await ConnectionManager.getInstance().getPooledClient(connectionConfig);

      const schema = tableInfo.schema || 'public';
      const table = tableInfo.table;
      if (!table) {
        postMessage({ type: 'insertFailed', tempId, error: 'No table name in tableInfo' });
        return;
      }

      // Filter out null values for columns the user left empty
      // (let DB defaults apply)
      const filteredValues: Record<string, any> = {};
      for (const [col, val] of Object.entries(values)) {
        if (val !== '' && val !== undefined) {
          filteredValues[col] = val === '__NULL__' ? null : val;
        }
      }

      if (Object.keys(filteredValues).length === 0) {
        postMessage({ type: 'insertFailed', tempId, error: 'No values provided for INSERT' });
        return;
      }

      const columns = Object.keys(filteredValues);
      const paramValues = Object.values(filteredValues);
      const columnList = columns.map(quoteIdentifier).join(', ');
      const paramList = columns.map((_, i) => `$${i + 1}`).join(', ');
      const tableRef = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

      // Use RETURNING * to get the actual inserted row with DB defaults applied
      const sql = `INSERT INTO ${tableRef} (${columnList}) VALUES (${paramList}) RETURNING *`;
      const result = await client.query(sql, paramValues);

      if (result.rows.length > 0) {
        postMessage({ type: 'insertSuccess', tempId, actualRow: result.rows[0] });
      } else {
        postMessage({ type: 'insertFailed', tempId, error: 'INSERT did not return a row' });
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      postMessage({ type: 'insertFailed', tempId, error: errorMsg });
    } finally {
      if (client) { client.release(); }
    }
  }
}
