import * as vscode from 'vscode';
import { ConnectionManager } from '../services/ConnectionManager';

interface TableInfo {
  schema: string;
  tableName: string;
}

interface ColumnInfo {
  schema: string;
  tableName: string;
  columnName: string;
  dataType: string;
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private tableCache: Map<string, TableInfo[]> = new Map();
  private columnCache: Map<string, ColumnInfo[]> = new Map();
  private lastCacheUpdate: Map<string, number> = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute cache

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    const completionItems: vscode.CompletionItem[] = [];

    try {
      // Get connection info from notebook metadata or active connection
      const connectionInfo = await this._getConnectionInfo(document);
      if (!connectionInfo) {
        return [];
      }

      const { connectionId, database } = connectionInfo;
      const cacheKey = `${connectionId}-${database}`;

      // Update cache if needed
      if (this._shouldUpdateCache(cacheKey)) {
        await this._updateCache(connectionId, database, cacheKey);
      }

      // Get current line and word being typed
      const lineText = document.lineAt(position).text;
      const wordRange = document.getWordRangeAtPosition(position);
      const currentWord = wordRange ? document.getText(wordRange) : '';

      // Parse query to find referenced tables
      const fullText = document.getText();
      const referencedTables = this._extractTableNames(fullText);

      // Add SQL keywords
      completionItems.push(...this._getSqlKeywords());

      // Add table suggestions with high priority
      const tables = this.tableCache.get(cacheKey) || [];
      completionItems.push(...this._getTableCompletions(tables, referencedTables));

      // Add column suggestions based on context
      const columns = this.columnCache.get(cacheKey) || [];
      completionItems.push(...this._getColumnCompletions(columns, referencedTables, lineText));

    } catch (error) {
      console.error('SQL completion error:', error);
    }

    return completionItems;
  }

  private async _getConnectionInfo(document: vscode.TextDocument): Promise<{ connectionId: string; database: string } | null> {
    // For notebooks, get from metadata
    if (document.uri.scheme === 'vscode-notebook-cell') {
      const notebook = vscode.workspace.notebookDocuments.find(nb =>
        nb.getCells().some(cell => cell.document.uri.toString() === document.uri.toString())
      );

      if (notebook?.metadata) {
        const metadata = notebook.metadata;
        return {
          connectionId: metadata.connectionId,
          database: metadata.databaseName || 'postgres'
        };
      }
    }

    // For regular files, try to get from workspace state or recent connection
    // This is a fallback - ideally user should use notebooks for better context
    return null;
  }

  private _shouldUpdateCache(cacheKey: string): boolean {
    const lastUpdate = this.lastCacheUpdate.get(cacheKey);
    if (!lastUpdate) {
      return true;
    }
    return Date.now() - lastUpdate > this.CACHE_TTL;
  }

  private async _updateCache(connectionId: string, database: string, cacheKey: string): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration();
      const connections = config.get<any[]>('postgresExplorer.connections') || [];
      const connection = connections.find(c => c.id === connectionId);

      if (!connection) {
        return;
      }

      let client;
      try {
        client = await ConnectionManager.getInstance().getPooledClient({
          id: connection.id,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          database: database,
          name: connection.name
        });

        // Fetch tables
        const tablesQuery = `
                    SELECT schemaname as schema, tablename as table_name
                    FROM pg_tables
                    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY schemaname, tablename
                `;
        const tablesResult = await client.query(tablesQuery);
        const tables: TableInfo[] = this._dedupeTables(tablesResult.rows.map(row => ({
          schema: row.schema,
          tableName: row.table_name
        })));

        // Fetch columns
        const columnsQuery = `
                    SELECT 
                        table_schema as schema,
                        table_name,
                        column_name,
                        data_type
                    FROM information_schema.columns
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name, ordinal_position
                `;
        const columnsResult = await client.query(columnsQuery);
        const columns: ColumnInfo[] = this._dedupeColumns(columnsResult.rows.map(row => ({
          schema: row.schema,
          tableName: row.table_name,
          columnName: row.column_name,
          dataType: row.data_type
        })));

        this.tableCache.set(cacheKey, tables);
        this.columnCache.set(cacheKey, columns);
        this.lastCacheUpdate.set(cacheKey, Date.now());
      } finally {
        if (client) client.release();
      }
    } catch (error) {
      console.error('Cache update error:', error);
    }
  }

  private _extractTableNames(sqlText: string): Set<string> {
    const tables = new Set<string>();
    const text = sqlText.toLowerCase();

    // Match FROM clause
    const fromRegex = /from\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gi;
    let match;
    while ((match = fromRegex.exec(text)) !== null) {
      const tableName = match[1].split('.').pop() || match[1];
      tables.add(tableName);
    }

    // Match JOIN clauses
    const joinRegex = /join\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gi;
    while ((match = joinRegex.exec(text)) !== null) {
      const tableName = match[1].split('.').pop() || match[1];
      tables.add(tableName);
    }

    return tables;
  }

  private _getSqlKeywords(): vscode.CompletionItem[] {
    const keywords = [
      'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
      'ON', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL',
      'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
      'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
      'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
      'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
      'CASE', 'WHEN', 'THEN', 'ELSE', 'END'
    ];

    return keywords.map(keyword => {
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
      item.sortText = `3-${keyword}`; // Lower priority than tables and columns
      return item;
    });
  }

  private _getTableCompletions(tables: TableInfo[], referencedTables: Set<string>): vscode.CompletionItem[] {
    return tables.map(table => {
      const item = new vscode.CompletionItem(
        table.tableName,
        vscode.CompletionItemKind.Class
      );

      item.detail = `Table (${table.schema})`;
      item.documentation = new vscode.MarkdownString(`**Table:** \`${table.schema}.${table.tableName}\``);

      // Higher priority for already referenced tables
      if (referencedTables.has(table.tableName.toLowerCase())) {
        item.sortText = `0-${table.tableName}`;
      } else {
        item.sortText = `1-${table.tableName}`;
      }

      // Add schema prefix as insert text if needed
      item.insertText = table.tableName;
      item.filterText = `${table.schema}.${table.tableName} ${table.tableName}`;

      return item;
    });
  }

  private _getColumnCompletions(
    columns: ColumnInfo[],
    referencedTables: Set<string>,
    lineText: string
  ): vscode.CompletionItem[] {
    const completions: vscode.CompletionItem[] = [];

    // Filter columns by referenced tables
    const relevantColumns = columns.filter(col =>
      referencedTables.has(col.tableName.toLowerCase())
    );

    // Add all columns, but prioritize relevant ones
    const allColumns = relevantColumns.length > 0 ? relevantColumns : columns;

    for (const column of allColumns) {
      const item = new vscode.CompletionItem(
        column.columnName,
        vscode.CompletionItemKind.Field
      );

      item.detail = `${column.dataType} (${column.schema}.${column.tableName})`;
      item.documentation = new vscode.MarkdownString(
        `**Column:** \`${column.columnName}\`\n\n` +
        `**Type:** \`${column.dataType}\`\n\n` +
        `**Table:** \`${column.schema}.${column.tableName}\``
      );

      // Highest priority for columns from referenced tables
      if (referencedTables.has(column.tableName.toLowerCase())) {
        item.sortText = `0-${column.columnName}`;
      } else {
        item.sortText = `2-${column.columnName}`;
      }

      completions.push(item);
    }

    return completions;
  }

  private _dedupeTables(tables: TableInfo[]): TableInfo[] {
    const seen = new Set<string>();

    return tables.filter(table => {
      const key = `${table.schema}.${table.tableName}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  private _dedupeColumns(columns: ColumnInfo[]): ColumnInfo[] {
    const seen = new Set<string>();

    return columns.filter(column => {
      const key = `${column.schema}.${column.tableName}.${column.columnName}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }
}
