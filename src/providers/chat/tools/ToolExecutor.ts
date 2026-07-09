import * as vscode from 'vscode';
import { IndexStore } from '../../../features/dbindex/IndexStore';
import { IndexQueryService } from '../../../features/dbindex/IndexQueryService';
import { findShortestJoinPath } from '../../../features/dbindex/joinPath';
import { ConnectionManager } from '../../../services/ConnectionManager';
import { ConnectionUtils } from '../../../utils/connectionUtils';
import { debugLog } from '../../../common/logger';
import * as ProfileSQL from '../../../commands/sql/profile';
import * as MonitoringSQL from '../../../commands/sql/monitoring';
import { QueryBuilder } from '../../../commands/sql/helper';
import { QueryAnalyzer } from '../../../services/QueryAnalyzer';

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
        case 'list_connections':
          result = await this.listConnections();
          break;
        case 'list_databases':
          result = await this.listDatabases(args.connectionId);
          break;
        case 'list_schemas':
          result = await this.listSchemas();
          break;
        case 'list_objects':
          result = await this.listObjects(args.schema, args.kind);
          break;
        case 'get_current_context':
          result = await this.getCurrentContext();
          break;
        case 'table_stats':
          result = await this.tableStats(args.ref);
          break;
        case 'index_usage':
          result = await this.indexUsage(args.ref);
          break;
        case 'list_running_queries':
          result = await this.listRunningQueries();
          break;
        case 'find_blocking_locks':
          result = await this.findBlockingLocks();
          break;
        case 'slow_queries':
          result = await this.slowQueries(args.limit);
          break;
        case 'db_health_check':
          result = await this.dbHealthCheck();
          break;
        case 'get_ddl':
          result = await this.getDdl(args.ref, args.kind);
          break;
        case 'explain_analyze':
          result = await this.explainAnalyze(args.sql);
          break;
        case 'analyze_query_plan':
          result = await this.analyzeQueryPlan(args.sql, args.analyze);
          break;
        case 'switch_connection':
          result = await this.switchConnection(args.connectionId, args.databaseName);
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

    // EXPLAIN output is small and must not be LIMIT-wrapped.
    if (trimmed.startsWith('explain')) {
      return await this.runSelectInternal(connConfig, sql);
    }
    return await this.runSelectInternal(connConfig, sql, this.getMaxRows());
  }

  private getMaxRows(): number {
    const value = vscode.workspace
      .getConfiguration()
      .get<number>('postgresExplorer.mcp.maxRows', 500);
    return Math.min(Math.max(Math.floor(value) || 500, 1), 10000);
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

  private async runSelectInternal(connConfig: any, sql: string, maxRows?: number): Promise<string> {
    const client = await ConnectionManager.getInstance().getPooledClient({
      ...connConfig,
      database: this.databaseName
    });

    try {
      // Force read-only transaction mode for maximum safety
      try {
        await client.query('SET default_transaction_read_only = ON');
      } catch (err: any) {
        throw new Error(`Security Error: Failed to set transaction read-only mode: ${err.message || err}`);
      }

      // Force statement timeout to prevent query DoS
      try {
        await client.query("SET statement_timeout = '30s'");
      } catch (err: any) {
        throw new Error(`Security Error: Failed to set statement timeout: ${err.message || err}`);
      }

      if (maxRows === undefined) {
        const res = await client.query(sql);
        return JSON.stringify(res.rows, null, 2);
      }

      // Cap result size at the database: LIMIT-wrap the query, fetching one
      // extra row to detect truncation. Queries the wrapper can't parse
      // (rare — e.g. trailing SQL comments) fall back to a client-side slice.
      const wrapped = `SELECT * FROM (${sql.trim().replace(/;+\s*$/, '')}) AS nexql_limited LIMIT ${maxRows + 1}`;
      let rows: any[];
      try {
        rows = (await client.query(wrapped)).rows;
      } catch {
        rows = (await client.query(sql)).rows.slice(0, maxRows + 1);
      }
      if (rows.length > maxRows) {
        return JSON.stringify({ rows: rows.slice(0, maxRows), truncated: true, maxRows }, null, 2);
      }
      return JSON.stringify(rows, null, 2);
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

  private async listConnections(): Promise<string> {
    const connections = ConnectionUtils.getConnections();
    const result = connections.map(conn => ({
      id: conn.id,
      name: conn.name,
      host: conn.host,
      port: conn.port,
      database: conn.database,
      environment: conn.environment || 'development'
    }));
    return JSON.stringify(result, null, 2);
  }

  private async listDatabases(connectionId: string): Promise<string> {
    if (!connectionId) {
      throw new Error('connectionId parameter is required');
    }
    const connection = ConnectionUtils.findConnection(connectionId);
    if (!connection) {
      throw new Error(`Connection not found for ID: ${connectionId}`);
    }
    const databases = await ConnectionUtils.listDatabases(connection);
    return JSON.stringify(databases, null, 2);
  }

  private async listSchemas(): Promise<string> {
    const connConfig = ConnectionUtils.findConnection(this.connectionId);
    if (!connConfig) {
      throw new Error(`Database connection not found for connectionId: ${this.connectionId}`);
    }
    const sql = `
      SELECT nspname AS schema_name
      FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND nspname NOT LIKE 'pg_%'
      ORDER BY nspname
    `;
    return await this.runSelectInternal(connConfig, sql);
  }

  private async listObjects(schema: string = 'public', kind?: string): Promise<string> {
    const connConfig = ConnectionUtils.findConnection(this.connectionId);
    if (!connConfig) {
      throw new Error(`Database connection not found for connectionId: ${this.connectionId}`);
    }

    if (!schema || !/^[a-zA-Z0-9_-]+$/.test(schema)) {
      throw new Error('Invalid or missing schema name format');
    }

    const queries: string[] = [];

    const getRelQuery = (relkinds: string[], kindLabel: string) => `
      SELECT 
        n.nspname AS schema,
        c.relname AS name,
        '${kindLabel}' AS kind,
        d.description AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
      WHERE n.nspname = '${schema}'
        AND c.relkind IN (${relkinds.map(k => `'${k}'`).join(',')})
    `;

    if (!kind || kind === 'table') {
      queries.push(getRelQuery(['r', 'f', 'p'], 'table'));
    }
    if (!kind || kind === 'view') {
      queries.push(getRelQuery(['v'], 'view'));
    }
    if (!kind || kind === 'matview') {
      queries.push(getRelQuery(['m'], 'matview'));
    }
    if (!kind || kind === 'sequence') {
      queries.push(getRelQuery(['S'], 'sequence'));
    }
    if (!kind || kind === 'function') {
      queries.push(`
        SELECT 
          n.nspname AS schema,
          p.proname AS name,
          'function' AS kind,
          d.description AS comment
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        LEFT JOIN pg_description d ON d.objoid = p.oid
        WHERE n.nspname = '${schema}'
      `);
    }
    if (!kind || kind === 'enum') {
      queries.push(`
        SELECT DISTINCT
          n.nspname AS schema,
          t.typname AS name,
          'enum' AS kind,
          NULL::text AS comment
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = '${schema}'
      `);
    }
    if (!kind || kind === 'domain') {
      queries.push(`
        SELECT 
          n.nspname AS schema,
          t.typname AS name,
          'domain' AS kind,
          NULL::text AS comment
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = '${schema}'
          AND t.typtype = 'd'
      `);
    }

    if (queries.length === 0) {
      return JSON.stringify([]);
    }

    const sql = queries.join('\nUNION ALL\n') + '\nORDER BY kind, name';
    return await this.runSelectInternal(connConfig, sql);
  }

  private async getCurrentContext(): Promise<string> {
    const connConfig = ConnectionUtils.findConnection(this.connectionId);
    return JSON.stringify({
      connectionId: this.connectionId,
      connectionName: connConfig?.name || connConfig?.host || 'Unknown',
      database: this.databaseName,
      host: connConfig?.host,
      port: connConfig?.port
    }, null, 2);
  }

  private async switchConnection(connectionId: string, databaseName?: string): Promise<string> {
    if (!connectionId) {
      throw new Error('connectionId parameter is required');
    }
    const connection = ConnectionUtils.findConnection(connectionId);
    if (!connection) {
      throw new Error(`Connection not found for ID: ${connectionId}`);
    }

    this.connectionId = connectionId;
    this.databaseName = databaseName || connection.database || 'postgres';

    try {
      const { getChatViewProvider } = require('../../../extension');
      const chatProvider = getChatViewProvider();
      if (chatProvider) {
        chatProvider.setConnectionContext(this.connectionId, this.databaseName);
      }
    } catch (e) {
      console.error(`[ToolExecutor] switchConnection: Failed to sync connection context to ChatViewProvider`, e);
    }

    return JSON.stringify({
      message: "Connection context switched programmatically.",
      connectionName: connection.name || connection.host,
      connectionId: this.connectionId,
      database: this.databaseName
    }, null, 2);
  }

  // ── Monitoring / performance tools ────────────────────────────────────

  private getConnConfig(): any {
    const connConfig = ConnectionUtils.findConnection(this.connectionId);
    if (!connConfig) {
      throw new Error(`Database connection not found for connectionId: ${this.connectionId}`);
    }
    return connConfig;
  }

  /** Splits "schema.name" and validates both parts as safe identifiers. */
  private parseRef(ref: string): { schema: string; name: string } {
    if (!ref) {
      throw new Error('Ref parameter is required');
    }
    const parts = ref.split('.');
    const [schema, name] = parts.length === 2 ? parts : ['public', parts[0]];
    const identPattern = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;
    if (!identPattern.test(schema) || !identPattern.test(name)) {
      throw new Error(`Invalid object reference "${ref}". Expected format "schema.name" with plain identifiers.`);
    }
    return { schema, name };
  }

  private async tableStats(ref: string): Promise<string> {
    const { schema, name } = this.parseRef(ref);
    const connConfig = this.getConnConfig();
    const [stats, activity, columns] = await Promise.all([
      this.runSelectInternal(connConfig, ProfileSQL.tableStats(schema, name)),
      this.runSelectInternal(connConfig, ProfileSQL.tableActivity(schema, name)),
      this.runSelectInternal(connConfig, ProfileSQL.columnStats(schema, name))
    ]);
    return JSON.stringify({
      size: JSON.parse(stats)[0] ?? null,
      activity: JSON.parse(activity)[0] ?? null,
      columns: JSON.parse(columns)
    }, null, 2);
  }

  private async indexUsage(ref: string): Promise<string> {
    const { schema, name } = this.parseRef(ref);
    return await this.runSelectInternal(this.getConnConfig(), ProfileSQL.indexUsage(schema, name));
  }

  private async listRunningQueries(): Promise<string> {
    return await this.runSelectInternal(this.getConnConfig(), MonitoringSQL.runningQueries());
  }

  private async findBlockingLocks(): Promise<string> {
    const result = await this.runSelectInternal(this.getConnConfig(), MonitoringSQL.blockingLocks());
    const rows = JSON.parse(result);
    if (Array.isArray(rows) && rows.length === 0) {
      return JSON.stringify({ message: 'No blocking locks found.', locks: [] });
    }
    return result;
  }

  private async slowQueries(limit?: number): Promise<string> {
    try {
      return await this.runSelectInternal(this.getConnConfig(), MonitoringSQL.slowQueries(limit ?? 10));
    } catch (err: any) {
      const message = String(err?.message || err);
      if (/pg_stat_statements/.test(message) && /does not exist/.test(message)) {
        return JSON.stringify({
          error: 'The pg_stat_statements extension is not installed in this database.',
          hint: 'An administrator can enable it with: CREATE EXTENSION pg_stat_statements; (requires shared_preload_libraries configuration).'
        });
      }
      throw err;
    }
  }

  private async dbHealthCheck(): Promise<string> {
    const connConfig = this.getConnConfig();
    const sections: Array<{ key: string; sql: string }> = [
      { key: 'overview', sql: QueryBuilder.databaseStats() },
      { key: 'cache', sql: MonitoringSQL.cacheHitRatio() },
      { key: 'dead_tuples', sql: QueryBuilder.databaseMaintenanceStats() },
      { key: 'connection_states', sql: MonitoringSQL.connectionStates() },
      { key: 'blocking_locks', sql: MonitoringSQL.blockingLocks() }
    ];
    const report: Record<string, unknown> = {};
    for (const section of sections) {
      try {
        report[section.key] = JSON.parse(await this.runSelectInternal(connConfig, section.sql));
      } catch (err: any) {
        report[section.key] = { error: String(err?.message || err) };
      }
    }
    const locks = report['blocking_locks'];
    report['blocking_lock_count'] = Array.isArray(locks) ? locks.length : null;
    return JSON.stringify(report, null, 2);
  }

  private async getDdl(ref: string, kind: string = 'table'): Promise<string> {
    const { schema, name } = this.parseRef(ref);
    const connConfig = this.getConnConfig();
    // Identifiers are regex-validated above, so embedding them in literals is safe.
    const regclass = `'${this.quoteRef(`${schema}.${name}`)}'::regclass`;

    switch (kind) {
      case 'view':
      case 'matview':
        return await this.runSelectInternal(
          connConfig,
          `SELECT pg_get_viewdef(${regclass}, true) AS definition`
        );
      case 'function':
        return await this.runSelectInternal(
          connConfig,
          `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = '${schema}' AND p.proname = '${name}'`
        );
      case 'index':
        return await this.runSelectInternal(
          connConfig,
          `SELECT pg_get_indexdef(${regclass}) AS definition`
        );
      case 'table': {
        const [columns, constraints, indexes] = await Promise.all([
          this.runSelectInternal(connConfig, ProfileSQL.columnDetails(schema, name)),
          this.runSelectInternal(
            connConfig,
            `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint WHERE conrelid = ${regclass} ORDER BY conname`
          ),
          this.runSelectInternal(
            connConfig,
            `SELECT indexname AS name, indexdef AS definition
             FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = '${name}' ORDER BY indexname`
          )
        ]);
        return JSON.stringify({
          table: `${schema}.${name}`,
          columns: JSON.parse(columns),
          constraints: JSON.parse(constraints),
          indexes: JSON.parse(indexes)
        }, null, 2);
      }
      default:
        throw new Error(`Unsupported DDL kind "${kind}". Use table, view, matview, function, or index.`);
    }
  }

  private validateReadOnlySelect(sql: string): void {
    const trimmed = (sql || '').trim().toLowerCase();
    if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
      throw new Error('Security Error: Only SELECT or WITH statements can be analyzed.');
    }
  }

  private async explainAnalyze(sql: string): Promise<string> {
    this.validateReadOnlySelect(sql);
    return await this.runExplainInTransaction(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  }

  private async analyzeQueryPlan(sql: string, analyze?: boolean): Promise<string> {
    this.validateReadOnlySelect(sql);
    const options = analyze ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';
    const raw = await this.runExplainInTransaction(`EXPLAIN (${options}) ${sql}`);
    const rows = JSON.parse(raw);
    const plan = rows?.[0]?.['QUERY PLAN'];
    const metrics = QueryAnalyzer.getInstance().extractPlanMetrics(plan);
    return JSON.stringify({
      metrics,
      recommendations: metrics?.recommendations ?? [],
      plan
    }, null, 2);
  }

  /**
   * EXPLAIN ANALYZE executes the query, so it runs inside an explicit
   * read-only transaction that is always rolled back — belt-and-braces on
   * top of `default_transaction_read_only`.
   */
  private async runExplainInTransaction(explainSql: string): Promise<string> {
    const connConfig = this.getConnConfig();
    const client = await ConnectionManager.getInstance().getPooledClient({
      ...connConfig,
      database: this.databaseName
    });
    try {
      await client.query("SET statement_timeout = '30s'");
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ ONLY');
      const res = await client.query(explainSql);
      return JSON.stringify(res.rows, null, 2);
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {}
      try {
        client.release();
      } catch {}
    }
  }
}
