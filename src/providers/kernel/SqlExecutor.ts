
import * as vscode from 'vscode';
import { NotebookCellOutput, NotebookCellOutputItem } from 'vscode';
import { ConnectionManager } from '../../services/ConnectionManager';
import { TelemetryService, SpanNames } from '../../services/TelemetryService';
import { PostgresMetadata, QueryResults } from '../../common/types';
import { SqlParser } from './SqlParser';
import { SecretStorageService } from '../../services/SecretStorageService';
import { ErrorService, getErrorExplanation } from '../../services/ErrorService';
import { QueryHistoryService } from '../../services/QueryHistoryService';
import { getTransactionManager } from '../../services/TransactionManager';
import { QueryAnalyzer } from '../../services/QueryAnalyzer';
import { QueryPerformanceService } from '../../services/QueryPerformanceService';
import { extensionContext } from '../../extension';
import { QueryCodeLensProvider } from '../QueryCodeLensProvider';
import { updateNotebookTitle } from '../../utils/notebookTitle';

export class SqlExecutor {
  constructor(private readonly _controller: vscode.NotebookController) { }

  /**
   * Apply auto-LIMIT to SELECT queries that don't already have one
   * Respects both global settings and profile-level autoLimitSelectResults
   */
  private applyAutoLimit(query: string, connection: any, notebookMetadata?: any, profileContext?: any): string {
    // Check profile-level auto-limit first (takes precedence)
    let limit: number | null = null;

    // Try profile context first, then metadata
    if (profileContext?.autoLimitSelectResults !== undefined && profileContext.autoLimitSelectResults > 0) {
      limit = profileContext.autoLimitSelectResults;
    } else if (notebookMetadata?.autoLimitSelectResults !== undefined && notebookMetadata.autoLimitSelectResults > 0) {
      limit = notebookMetadata.autoLimitSelectResults;
    } else {
      // Fall back to global settings
      const autoLimitEnabled = vscode.workspace.getConfiguration()
        .get<boolean>('postgresExplorer.query.autoLimitEnabled', true);

      if (autoLimitEnabled || connection.readOnlyMode) {
        limit = vscode.workspace.getConfiguration()
          .get<number>('postgresExplorer.performance.defaultLimit', 1000);
      }
    }

    // If no limit determined, return query as-is
    if (!limit) {
      return query;
    }

    // Only apply to SELECT queries
    const trimmed = query.trim();
    // Strip comments to reliably detect SELECT
    const cleanQuery = query.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

    if (!/^\s*SELECT/i.test(cleanQuery)) {
      return query;
    }

    // Check if query already has LIMIT
    if (/\bLIMIT\s+\d+/i.test(query)) {
      return query;
    }

    // Check for semicolon at end
    const hasSemicolon = trimmed.endsWith(';');
    const baseQuery = hasSemicolon ? trimmed.slice(0, -1) : trimmed;

    // Apply LIMIT
    const limitedQuery = `${baseQuery} LIMIT ${limit}${hasSemicolon ? ';' : ''}`;
    return limitedQuery;
  }

  public async executeCell(cell: vscode.NotebookCell) {
    console.log(`SqlExecutor: Starting cell execution. Controller ID: ${this._controller.id}`);
    const execution = this._controller.createNotebookCellExecution(cell);
    const startTime = Date.now();
    execution.start(startTime);
    await execution.clearOutput();

    try {
      const metadata = cell.notebook.metadata as PostgresMetadata;
      if (!metadata || !metadata.connectionId) {
        throw new Error('No connection metadata found');
      }

      // Fetch active profile context from globalState
      // This allows different notebooks to have different active profiles
      const notebookKey = `activeProfile-${cell.notebook.uri.toString()}`;
      const activeProfileContext = extensionContext?.globalState.get<any>(notebookKey);

      // Get connection info
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const connection = connections.find(c => c.id === metadata.connectionId);
      if (!connection) {
        throw new Error('Connection not found');
      }

      // Apply profile settings from metadata to connection (metadata takes precedence)
      if (metadata.readOnlyMode !== undefined) {
        connection.readOnlyMode = metadata.readOnlyMode;
      }

      // Apply profile settings from globalState if available
      if (activeProfileContext) {
        if (activeProfileContext.readOnlyMode !== undefined) {
          connection.readOnlyMode = activeProfileContext.readOnlyMode;
        }
      }

      const client = await ConnectionManager.getInstance().getSessionClient({
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        database: metadata.databaseName || connection.database,
        name: connection.name
      }, cell.notebook.uri.toString());

      console.log('SqlExecutor: Connected to database');

      // Get PostgreSQL backend PID for query cancellation
      let backendPid: number | null = null;
      try {
        const pidResult = await client.query('SELECT pg_backend_pid()');
        backendPid = pidResult.rows[0]?.pg_backend_pid || null;
        console.log('SqlExecutor: Backend PID:', backendPid);
      } catch (err) {
        console.warn('Failed to get backend PID:', err);
      }

      // Capture PostgreSQL NOTICE messages
      const notices: string[] = [];
      const noticeListener = (msg: any) => {
        const message = msg.message || msg.toString();
        notices.push(message);
      };
      client.on('notice', noticeListener);

      const queryText = cell.document.getText();
      const statements = SqlParser.splitSqlStatements(queryText);

      console.log('SqlExecutor: Executing', statements.length, 'statement(s)');

      // Safety check: Analyze queries for dangerous operations
      const queryAnalyzer = QueryAnalyzer.getInstance();
      for (const stmt of statements) {
        // Check read-only mode
        if (connection.readOnlyMode && !queryAnalyzer.isReadOnlyQuery(stmt)) {
          throw new Error('Write operations are not allowed in read-only mode');
        }

        // Analyze for dangerous operations
        const analysis = queryAnalyzer.analyzeQuery(stmt, connection);
        if (analysis.requiresConfirmation && analysis.warningMessage) {
          const action = await vscode.window.showWarningMessage(
            analysis.warningMessage,
            { modal: true },
            'Execute',
            'Execute in Transaction'
          );

          if (!action) {
            throw new Error('Query execution cancelled by user');
          } else if (action === 'Execute in Transaction') {
            // Wrap in transaction if not already in one
            const txManager = getTransactionManager();
            const sessionId = cell.notebook.uri.toString();
            const txInfo = txManager.getTransactionInfo(sessionId);

            if (!txInfo || !txInfo.isActive) {
              await client.query('BEGIN');
              if (!txInfo) {
                txManager.initializeSession(sessionId, true);
              }
              notices.push('Transaction started automatically for safety. Run COMMIT or ROLLBACK when done.');
            }
          }
        }
      }

      // Execute each statement
      for (let stmtIndex = 0; stmtIndex < statements.length; stmtIndex++) {
        let query = statements[stmtIndex];
        const stmtStartTime = Date.now();

        // Apply auto-LIMIT if applicable (pass notebook metadata and profile context for settings)
        const originalQuery = query;
        query = this.applyAutoLimit(query, connection, metadata, activeProfileContext);
        const autoLimitApplied = query !== originalQuery;

        console.log(`SqlExecutor: Executing statement ${stmtIndex + 1}/${statements.length}:`, query.substring(0, 100));

        let result;
        try {
          const telemetry = TelemetryService.getInstance();
          const spanId = telemetry.startSpan(SpanNames.QUERY_EXECUTE, {
            statementIndex: stmtIndex + 1,
            statementCount: statements.length
          });

          result = await client.query(query);


          const stmtEndTime = Date.now();
          const executionTime = (stmtEndTime - stmtStartTime) / 1000;
          const durationMs = executionTime * 1000;

          // ... (auto-limit notice)

          const success = true;
          const slowThresholdMs = vscode.workspace.getConfiguration().get<number>('postgresExplorer.performance.slowQueryThresholdMs', 2000);
          const isSlow = durationMs >= slowThresholdMs;

          // Performance Tracking
          const queryAnalyzer = QueryAnalyzer.getInstance();
          const queryHash = queryAnalyzer.getQueryHash(query);
          const performanceService = QueryPerformanceService.getInstance();

          // Record this execution
          // We record *before* fetching baseline for next time? 
          // Or fetch baseline *before* recording simple current execution?
          // Logic: Compare against *historical* baseline (excluding current).
          const baseline = performanceService.getBaseline(queryHash);

          // Async record (fire and forget)
          performanceService.recordExecution(queryHash, durationMs).catch(err => console.error('Failed to record performance:', err));

          // Extract EXPLAIN (FORMAT JSON) plan if available
          let explainPlan: any | undefined;
          let performanceAnalysis: any | undefined;

          if (result.command === 'EXPLAIN' && result.rows?.length) {
            const planCell = result.rows[0]['QUERY PLAN'] ?? result.rows[0]['query_plan'];
            if (planCell) {
              try {
                explainPlan = typeof planCell === 'string' ? JSON.parse(planCell) : planCell;
              } catch {
                explainPlan = planCell;
              }
            }
          }

          // Always analyze performance against baseline (even if no plan)
          performanceAnalysis = queryAnalyzer.analyzePerformanceAgainstBaseline(
            durationMs,
            baseline,
            explainPlan
          );

          console.log('[Performance] Hash:', queryHash);
          console.log('[Performance] Baseline:', JSON.stringify(baseline));
          console.log('[Performance] Duration:', durationMs);
          console.log('[Performance] Analysis:', JSON.stringify(performanceAnalysis));

          // Build output data
          const tableInfo = await this.getTableInfo(client, result, query);
          const outputData: QueryResults = {
            success,
            rowCount: result.rowCount,
            rows: result.rows,
            columns: result.fields?.map((f: any) => f.name) || [],
            columnTypes: result.fields?.reduce((acc: any, f: any) => {
              // Approximate type mapping or use OID if available
              acc[f.name] = this.getTypeName(f.dataTypeID);
              return acc;
            }, {}),
            command: result.command,
            query: query,
            notices: [...notices], // Copy current notices
            executionTime,
            backendPid,
            tableInfo,
            explainPlan,
            performanceAnalysis, // Pass analysis to frontend
            slowQuery: isSlow,
            breadcrumb: {
              connectionId: connection.id,
              connectionName: connection.name || connection.host,
              database: metadata.databaseName || connection.database,
              schema: tableInfo?.schema,
              object: tableInfo?.table ? { name: tableInfo.table, type: 'table' } : undefined
            }
          };

          telemetry.endSpan(spanId, { success: 'true', rowCount: result.rowCount ?? 0 });

          // Clear notices for next statement
          notices.length = 0;

          await execution.appendOutput(new NotebookCellOutput([
            new NotebookCellOutputItem(Buffer.from(JSON.stringify(outputData), 'utf8'), 'application/vnd.postgres-notebook.result')
          ]));

          // Update execution time pill in CodeLens bar
          QueryCodeLensProvider.getInstance()?.updatePill(cell.document.uri.toString(), {
            success: true,
            elapsedSeconds: executionTime,
            rowCount: result.rowCount ?? 0
          });

          // Log to history
          QueryHistoryService.getInstance().add({
            query: query,
            success: true,
            duration: executionTime,
            durationMs,
            slow: isSlow,
            rowCount: result.rowCount || 0,
            connectionName: connection.name
          });

        } catch (err: any) {
          const stmtEndTime = Date.now();
          const executionTime = (stmtEndTime - stmtStartTime) / 1000;

          console.error('SqlExecutor: Query error:', err);

          // Handle transaction auto-rollback on error
          const sessionId = cell.notebook.uri.toString();
          const txManager = getTransactionManager();
          try {
            await txManager.handleCellError(client, sessionId, err);
          } catch (txErr) {
            console.error('SqlExecutor: Transaction error handling failed:', txErr);
          }

          const slowThresholdMs = vscode.workspace.getConfiguration().get<number>('postgresExplorer.performance.slowQueryThresholdMs', 2000);
          const durationMs = executionTime * 1000;
          const isSlow = durationMs >= slowThresholdMs;

          const pgErrorCode: string | undefined = err.code;
          const errorData = {
            success: false,
            error: err.message,
            query: query,
            executionTime,
            slowQuery: isSlow,
            canExplain: true,
            errorCode: pgErrorCode,
            errorExplanation: pgErrorCode ? getErrorExplanation(pgErrorCode) : undefined
          };

          await execution.appendOutput(new NotebookCellOutput([
            new NotebookCellOutputItem(Buffer.from(JSON.stringify(errorData), 'utf8'), 'application/vnd.postgres-notebook.error')
          ]));

          // Update execution time pill in CodeLens bar (failure)
          QueryCodeLensProvider.getInstance()?.updatePill(cell.document.uri.toString(), {
            success: false
          });

          // Log to history
          QueryHistoryService.getInstance().add({
            query: query,
            success: false,
            duration: executionTime,
            durationMs,
            slow: isSlow,
            connectionName: connection.name
          });

          // Stop execution on error
          break;
        }
      }

      client.removeListener('notice', noticeListener);
      execution.end(true, Date.now());
      // Update notebook title after successful cell execution
      updateNotebookTitle(cell.notebook).catch(err => console.warn('Failed to update notebook title:', err));

    } catch (err: any) {
      console.error('SqlExecutor: Execution failed:', err);
      await execution.replaceOutput(new NotebookCellOutput([
        new NotebookCellOutputItem(Buffer.from(String(err), 'utf8'), 'application/vnd.code.notebook.error')
      ]));
      execution.end(false, Date.now());
      // Update notebook title even after failed execution (cell content may have changed)
      updateNotebookTitle(cell.notebook).catch(err => console.warn('Failed to update notebook title:', err));
    }
  }

  // --- Helpers ---

  private getTypeName(oid: number): string {
    // Basic mapping, in a real app this would use a proper TypeRegistry
    const types: Record<number, string> = {
      16: 'bool',
      17: 'bytea',
      20: 'int8',
      21: 'int2',
      23: 'int4',
      25: 'text',
      114: 'json',
      1043: 'varchar',
      1082: 'date',
      1114: 'timestamp',
      1184: 'timestamptz',
      1700: 'numeric'
    };
    return types[oid] || 'string'; // Default to string
  }

  private async getTableInfo(client: any, result: any, query: string): Promise<any> {
    // Attempt to deduce table from query for basic primary key support
    // This is a heuristic. For better support, we'd parse the query structure.
    const fromMatch = query.match(/FROM\s+["']?([a-zA-Z0-9_.]+)["']?/i);
    if (!fromMatch) return undefined;

    const tableNameFull = fromMatch[1];
    const parts = tableNameFull.split('.');
    const table = parts.length > 1 ? parts[1] : parts[0];
    const schema = parts.length > 1 ? parts[0] : 'public';

    // Fetch PKs
    try {
      const pkResult = await client.query(`
        SELECT a.attname
        FROM   pg_index i
        JOIN   pg_attribute a ON a.attrelid = i.indrelid
                             AND a.attnum = ANY(i.indkey)
        WHERE  i.indrelid = '${schema}.${table}'::regclass
        AND    i.indisprimary
      `);
      return {
        schema,
        table,
        primaryKeys: pkResult.rows.map((r: any) => r.attname)
      };
    } catch (e) {
      // Ignore errors if we can't get PKs (e.g. view or complex query)
      return undefined;
    }
  }

  // --- Message Handlers for Execution (Cancel, Updates) ---

  public async cancelQuery(message: any) {
    const { backendPid, connectionId, databaseName } = message;
    try {
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const connection = connections.find(c => c.id === connectionId);
      if (!connection) throw new Error('Connection not found');

      let cancelClient;
      try {
        cancelClient = await ConnectionManager.getInstance().getPooledClient({
          id: connection.id,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          database: databaseName || connection.database,
          name: connection.name
        });
        await cancelClient.query('SELECT pg_cancel_backend($1)', [backendPid]);
        vscode.window.showInformationMessage(`Query cancelled (PID: ${backendPid})`);
      } finally {
        if (cancelClient) cancelClient.release();
      }
    } catch (err: any) {
      await ErrorService.getInstance().handleCommandError(err, 'cancel query');
    }
  }

  public async executeBatch(batch: { text: string; params: any[] }[], notebook: vscode.NotebookDocument) {
    let client: any = null;
    let done: any = null;

    try {
      const metadata = notebook.metadata as PostgresMetadata;
      if (!metadata?.connectionId) throw new Error('No connection found');

      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const connection = connections.find(c => c.id === metadata.connectionId);
      if (!connection) throw new Error('Connection not found');

      // We need a dedicated client for the transaction, not a pooled one that might be shared if we're not careful,
      // though getSessionClient typically returns a pool client. 
      // For transactions, we must ensure we hold the client for the duration.
      // ConnectionManager.getSessionClient returns a persistent client for the session (notebook).
      // However, that client might be busy. 
      // Let's use getPooledClient directly to get a fresh client for this background operation, 
      // to avoid interfering with any running query in the notebook interface (though usually single-threaded there).
      // ACTUALLY, sticking to getSessionClient is safer for consistency with the session's state if we had temp tables, 
      // but for updates, a fresh pooled client is often cleaner. 
      // Let's use getSessionClient as before to minimize connection usage, but we need to ensure we don't interleave.
      // Since VS Code notebooks are generally serial, it's fine.

      client = await ConnectionManager.getInstance().getSessionClient({
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        database: metadata.databaseName || connection.database,
        name: connection.name
      }, notebook.uri.toString());

      await client.query('BEGIN');

      for (const item of batch) {
        await client.query(item.text, item.params);
      }

      await client.query('COMMIT');
      vscode.window.showInformationMessage(`✅ Successfully saved ${batch.length} change(s).`);

    } catch (err: any) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Failed to rollback transaction:', rollbackErr);
        }
      }
      await ErrorService.getInstance().handleCommandError(err, 'save changes');
    }
  }
}
