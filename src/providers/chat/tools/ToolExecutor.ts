import * as vscode from 'vscode';
import { IndexStore } from '../../../features/dbindex/IndexStore';
import { IndexQueryService } from '../../../features/dbindex/IndexQueryService';
import { findShortestJoinPath } from '../../../features/dbindex/joinPath';
import { ConnectionManager } from '../../../services/ConnectionManager';
import { ConnectionUtils } from '../../../utils/connectionUtils';
import { debugLog } from '../../../common/logger';

export class ToolExecutor {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private connectionId: string,
    private databaseName: string
  ) {}

  private quoteIdentifier(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
  }

  private quoteRef(ref: string): string {
    const parts = ref.split('.');
    if (parts.length === 2) {
      return `${this.quoteIdentifier(parts[0])}.${this.quoteIdentifier(parts[1])}`;
    }
    return this.quoteIdentifier(ref);
  }

  async executeTool(name: string, args: any): Promise<string> {
    console.log(`[ToolExecutor] executeTool: Executing tool "${name}" with args:`, args);
    debugLog(`[ToolExecutor] Executing tool ${name} with args:`, JSON.stringify(args));
    try {
      let result: string;
      switch (name) {
        case 'select_connection_context':
          result = await this.selectConnectionContext(args.reason);
          break;
        case 'search_schema':
          result = await this.searchSchema(args.query);
          break;
        case 'describe_object':
          result = await this.describeObject(args.ref);
          break;
        case 'get_join_path':
          result = await this.getJoinPath(args.a, args.b);
          break;
        case 'sample_values':
          result = await this.sampleValues(args.ref, args.col);
          break;
        case 'run_select':
          result = await this.runSelect(args.sql);
          break;
        case 'explain_query':
          result = await this.explainQuery(args.sql);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      console.log(`[ToolExecutor] executeTool: Tool "${name}" finished. Result length: ${result.length} characters.`);
      return result;
    } catch (err: any) {
      console.error(`[ToolExecutor] executeTool: Tool "${name}" failed with error:`, err);
      debugLog(`[ToolExecutor] Error executing tool ${name}:`, err.message || err);
      return JSON.stringify({ error: err.message || String(err) });
    }
  }

  private async searchSchema(query: string): Promise<string> {
    if (!query || !query.trim()) {
      return JSON.stringify([]);
    }
    console.log(`[ToolExecutor] searchSchema: Querying schema index for "${query}"...`);
    const store = new IndexStore(this.context.globalStorageUri);
    const queryService = new IndexQueryService(store);
    const hits = await queryService.search(this.connectionId, this.databaseName, query, 10, { semantic: true });
    console.log(`[ToolExecutor] searchSchema: Found ${hits.length} hits. Top hits:`, hits.slice(0, 3));
    return JSON.stringify(hits, null, 2);
  }

  private async describeObject(ref: string): Promise<string> {
    if (!ref) {
      throw new Error('Ref parameter is required');
    }
    const store = new IndexStore(this.context.globalStorageUri);
    const queryService = new IndexQueryService(store);
    const entry = await queryService.describe(this.connectionId, this.databaseName, ref);
    if (!entry) {
      return JSON.stringify({ error: `Object "${ref}" not found in index.` });
    }
    return JSON.stringify(entry, null, 2);
  }

  private async getJoinPath(a: string, b: string): Promise<string> {
    if (!a || !b) {
      throw new Error('Parameters "a" and "b" are required');
    }
    const store = new IndexStore(this.context.globalStorageUri);
    const baseDir = store.getBaseDir(this.connectionId, this.databaseName);
    const manifest = await store.readManifest(baseDir);
    if (!manifest) {
      throw new Error(`Index manifest not found for database "${this.databaseName}"`);
    }
    const joinGraph = await store.readJoinGraph(baseDir, manifest);
    if (!joinGraph) {
      throw new Error(`Join graph not found for database "${this.databaseName}"`);
    }
    const path = findShortestJoinPath(a, b, joinGraph);
    if (!path) {
      return JSON.stringify({ message: `No join path found between "${a}" and "${b}" within 3 hops.` });
    }
    return JSON.stringify(path, null, 2);
  }

  private async sampleValues(ref: string, col: string): Promise<string> {
    if (!ref || !col) {
      throw new Error('Parameters "ref" and "col" are required');
    }
    const connConfig = ConnectionUtils.findConnection(this.connectionId);
    if (!connConfig) {
      throw new Error(`Database connection not found for connectionId: ${this.connectionId}`);
    }

    const store = new IndexStore(this.context.globalStorageUri);
    const baseDir = store.getBaseDir(this.connectionId, this.databaseName);
    const overrides = await store.readOverrides(baseDir);
    if (overrides?.objects?.[ref]?.excluded) {
      throw new Error(`Access Denied: Object "${ref}" is excluded from curation and grounding.`);
    }
    if (overrides?.objects?.[ref]?.columns?.[col]?.pii) {
      throw new Error(`Access Denied: Column "${col}" on "${ref}" is flagged as PII.`);
    }

    const quotedTable = this.quoteRef(ref);
    const quotedCol = this.quoteIdentifier(col);
    const sql = `SELECT DISTINCT ${quotedCol} FROM ${quotedTable} WHERE ${quotedCol} IS NOT NULL LIMIT 10`;

    return await this.runSelectInternal(connConfig, sql);
  }

  private async runSelect(sql: string): Promise<string> {
    if (!sql || !sql.trim()) {
      throw new Error('SQL parameter is required');
    }
    const connConfig = ConnectionUtils.findConnection(this.connectionId);
    if (!connConfig) {
      throw new Error(`Database connection not found for connectionId: ${this.connectionId}`);
    }

    // Strict validation: Only SELECT or WITH queries allowed.
    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith('select') && !trimmed.startsWith('with') && !trimmed.startsWith('explain')) {
      throw new Error('Security Error: Only read-only SELECT, WITH, or EXPLAIN statements are permitted.');
    }

    return await this.runSelectInternal(connConfig, sql);
  }

  private async explainQuery(sql: string): Promise<string> {
    if (!sql || !sql.trim()) {
      throw new Error('SQL parameter is required');
    }
    const connConfig = ConnectionUtils.findConnection(this.connectionId);
    if (!connConfig) {
      throw new Error(`Database connection not found for connectionId: ${this.connectionId}`);
    }

    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith('select') && !trimmed.startsWith('with') && !trimmed.startsWith('explain')) {
      throw new Error('Security Error: Only SELECT, WITH, or EXPLAIN statements can be analyzed.');
    }

    // Clean up query if it already has EXPLAIN
    const cleanSql = trimmed.startsWith('explain') ? sql : `EXPLAIN ${sql}`;
    return await this.runSelectInternal(connConfig, cleanSql);
  }

  private async runSelectInternal(connConfig: any, sql: string): Promise<string> {
    const client = await ConnectionManager.getInstance().getPooledClient({
      ...connConfig,
      database: this.databaseName
    });

    try {
      // Force read-only transaction mode for maximum safety
      await client.query('SET default_transaction_read_only = ON').catch(() => {});
      const res = await client.query(sql);
      return JSON.stringify(res.rows, null, 2);
    } finally {
      try {
        client.release();
      } catch {}
    }
  }

  private async selectConnectionContext(reason: string): Promise<string> {
    console.log(`[ToolExecutor] selectConnectionContext: Prompting user with showQuickPick for connection. Reason: "${reason}"`);
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    if (connections.length === 0) {
      return JSON.stringify({ error: "No connections configured. Please add a connection first." });
    }

    const items = connections.map(conn => ({
      label: conn.name || conn.host || 'Unnamed Connection',
      description: `${conn.host}:${conn.port || 5432}${conn.database ? '/' + conn.database : ''}`,
      connectionId: conn.id,
      database: conn.database || 'postgres'
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select connection: ${reason}`,
      ignoreFocusOut: true
    });

    if (!selected) {
      console.log(`[ToolExecutor] selectConnectionContext: User cancelled connection quick pick.`);
      return JSON.stringify({ error: "User cancelled connection selection." });
    }

    this.connectionId = selected.connectionId;
    this.databaseName = selected.database;
    console.log(`[ToolExecutor] selectConnectionContext: Switched context to connectionId="${this.connectionId}", database="${this.databaseName}"`);

    // Sync back to ChatViewProvider
    try {
      const { getChatViewProvider } = require('../../../extension');
      const chatProvider = getChatViewProvider();
      if (chatProvider) {
        chatProvider.setConnectionContext(this.connectionId, this.databaseName);
      }
    } catch (e) {
      console.error(`[ToolExecutor] selectConnectionContext: Failed to sync connection context to ChatViewProvider`, e);
    }

    return JSON.stringify({
      message: "Connection context switched successfully.",
      connectionName: selected.label,
      connectionId: this.connectionId,
      database: this.databaseName
    });
  }
}
