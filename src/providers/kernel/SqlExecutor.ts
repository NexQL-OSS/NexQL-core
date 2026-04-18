
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
  private static readonly REVIEW_COUNT_KEY = 'postgresExplorer.reviewPrompt.successCount';
  private static readonly REVIEW_SHOWN_KEY = 'postgresExplorer.reviewPrompt.shown';
  private static readonly REVIEW_THRESHOLD = 3;
  /** Workspace memento: last-used values for `:name` SQL parameters (keyed by parameter name). */
  private static readonly NAMED_PARAM_DEFAULTS_KEY = 'pgstudio.namedParamDefaults.v1';
  /** Workspace memento: last-used values for `$N` SQL parameters (keyed by sqlHash -> parameter index). */
  private static readonly POSITIONAL_PARAM_DEFAULTS_KEY = 'pgstudio.positionalParamDefaults.v1';

  constructor(private readonly _controller: vscode.NotebookController) { }

  private async maybePromptForReview(): Promise<void> {
    if (!extensionContext) {
      return;
    }

    const shown = extensionContext.globalState.get<boolean>(SqlExecutor.REVIEW_SHOWN_KEY, false);
    if (shown) {
      return;
    }

    const currentCount = extensionContext.globalState.get<number>(SqlExecutor.REVIEW_COUNT_KEY, 0);
    const nextCount = currentCount + 1;
    await extensionContext.globalState.update(SqlExecutor.REVIEW_COUNT_KEY, nextCount);

    if (nextCount < SqlExecutor.REVIEW_THRESHOLD) {
      return;
    }

    const leaveReview = 'Leave a Review';
    const maybeLater = 'Maybe Later';
    const selection = await vscode.window.showInformationMessage(
      'Enjoying PgStudio? A quick VS Code Marketplace review helps other PostgreSQL users discover it.',
      leaveReview,
      maybeLater
    );

    await extensionContext.globalState.update(SqlExecutor.REVIEW_SHOWN_KEY, true);

    if (selection === leaveReview) {
      await vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer&ssr=false#review-details'));
    }
  }

  /**
   * Prompts for each `:name` value in order; persists last-used values per workspace.
   * Returns `undefined` if the user cancels any prompt.
   */
  private async promptForNamedParameterValues(paramNames: string[]): Promise<unknown[] | undefined> {
    const paramsConfig = vscode.workspace.getConfiguration('postgresExplorer.parameters');
    const cacheLastValues = paramsConfig.get<boolean>('cacheLastValues', true);
    const nullSentinel = paramsConfig.get<string>('nullSentinel', 'NULL');
    const cache =
      cacheLastValues
        ? extensionContext?.workspaceState.get<Record<string, string>>(SqlExecutor.NAMED_PARAM_DEFAULTS_KEY, {}) ?? {}
        : {};
    const next: Record<string, string> = { ...cache };
    const values: unknown[] = [];

    for (const name of paramNames) {
      const existing = next[name] ?? '';
      const input = await vscode.window.showInputBox({
        title: `SQL parameter :${name}`,
        prompt: `Value for :${name} (${nullSentinel ? `type ${nullSentinel} to send SQL NULL` : 'sent to PostgreSQL as text; casts in SQL still apply'})`,
        value: existing,
        ignoreFocusOut: true
      });
      if (input === undefined) {
        return undefined;
      }
      values.push(nullSentinel && input === nullSentinel ? null : input);
      if (cacheLastValues) {
        next[name] = input;
      }
    }

    if (cacheLastValues && extensionContext) {
      await extensionContext.workspaceState.update(SqlExecutor.NAMED_PARAM_DEFAULTS_KEY, next);
    }
    return values;
  }

  private getSqlParameterContextSnippet(sql: string, parameterIndex: number): string | undefined {
    const token = `$${parameterIndex}`;
    const pattern = new RegExp(`\\$${parameterIndex}(?!\\d)`);
    const match = pattern.exec(sql);
    if (!match || match.index < 0) {
      return undefined;
    }

    const around = 20;
    const start = Math.max(0, match.index - around);
    const end = Math.min(sql.length, match.index + token.length + around);
    const snippet = sql.slice(start, end).replace(/\s+/g, ' ').trim();
    return snippet || undefined;
  }

  private async promptForPositionalParameterValues(
    indices: number[],
    sqlHash: string,
    sql: string
  ): Promise<unknown[] | undefined> {
    const paramsConfig = vscode.workspace.getConfiguration('postgresExplorer.parameters');
    const cacheLastValues = paramsConfig.get<boolean>('cacheLastValues', true);
    const nullSentinel = paramsConfig.get<string>('nullSentinel', 'NULL');
    const cache =
      cacheLastValues
        ? extensionContext?.workspaceState.get<Record<string, Record<string, string>>>(
          SqlExecutor.POSITIONAL_PARAM_DEFAULTS_KEY,
          {}
        ) ?? {}
        : {};

    const statementDefaults = { ...(cache[sqlHash] ?? {}) };
    const values: unknown[] = [];

    for (const parameterIndex of indices) {
      const key = String(parameterIndex);
      const contextSnippet = this.getSqlParameterContextSnippet(sql, parameterIndex);
      const input = await vscode.window.showInputBox({
        title: `SQL parameter $${parameterIndex}`,
        prompt: `Value for $${parameterIndex}${nullSentinel ? `  (type ${nullSentinel} to send SQL NULL)` : ''}`,
        placeHolder: contextSnippet,
        value: statementDefaults[key] ?? '',
        ignoreFocusOut: true
      });
      if (input === undefined) {
        return undefined;
      }

      values.push(nullSentinel && input === nullSentinel ? null : input);
      if (cacheLastValues) {
        statementDefaults[key] = input;
      }
    }

    if (cacheLastValues && extensionContext) {
      await extensionContext.workspaceState.update(SqlExecutor.POSITIONAL_PARAM_DEFAULTS_KEY, {
        ...cache,
        [sqlHash]: statementDefaults
      });
    }

    return values;
  }

  private async promptForQuotedPsqlValues(
    tokens: { name: string; kind: 'literal' | 'identifier' }[]
  ): Promise<Record<string, string> | undefined> {
    const cache =
      extensionContext?.workspaceState.get<Record<string, string>>(SqlExecutor.NAMED_PARAM_DEFAULTS_KEY, {}) ?? {};
    const next: Record<string, string> = { ...cache };
    const values: Record<string, string> = {};

    for (const token of tokens) {
      if (Object.prototype.hasOwnProperty.call(values, token.name)) {
        continue;
      }
      const tokenLabel = token.kind === 'literal' ? `:'${token.name}'` : `:"${token.name}"`;
      const input = await vscode.window.showInputBox({
        title: `SQL variable ${tokenLabel}`,
        prompt: `Value for ${tokenLabel}`,
        value: next[token.name] ?? '',
        ignoreFocusOut: true
      });
      if (input === undefined) {
        return undefined;
      }

      values[token.name] = input;
      next[token.name] = input;
    }

    if (extensionContext) {
      await extensionContext.workspaceState.update(SqlExecutor.NAMED_PARAM_DEFAULTS_KEY, next);
    }

    return values;
  }

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

        const params = SqlParser.detectParameters(query);
        const hasPositional = params.positional.length > 0;
        const hasNamed = params.named.length > 0;

        if (hasPositional && hasNamed) {
          throw new Error('Mixing $N and :name parameters in the same statement is not supported. Use one style per query.');
        }

        let pgParamValues: unknown[] | undefined;

        if (params.quoted.length > 0) {
          const quotedVals = await this.promptForQuotedPsqlValues(params.quoted);
          if (!quotedVals) {
            client.removeListener('notice', noticeListener);
            execution.end(false, Date.now());
            return;
          }
          query = SqlParser.substituteQuotedPsqlVariables(query, quotedVals).text;
        }

        if (hasNamed) {
          const named = SqlParser.substituteNamedParametersWithPgPlaceholders(query);
          const vals = await this.promptForNamedParameterValues(named.paramNames);
          if (vals === undefined) {
            client.removeListener('notice', noticeListener);
            execution.end(false, Date.now());
            return;
          }
          query = named.text;
          pgParamValues = vals;
        } else if (hasPositional) {
          const maxN = Math.max(...params.positional);
          const vals = await this.promptForPositionalParameterValues(
            Array.from({ length: maxN }, (_, i) => i + 1),
            QueryAnalyzer.getInstance().getQueryHash(query),
            query
          );
          if (vals === undefined) {
            client.removeListener('notice', noticeListener);
            execution.end(false, Date.now());
            return;
          }
          pgParamValues = vals;
        }

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

          result =
            pgParamValues !== undefined ? await client.query(query, pgParamValues) : await client.query(query);


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
                const parsed = typeof planCell === 'string' ? JSON.parse(planCell) : planCell;

                const hasPlanNode = (value: any): boolean => {
                  if (!value) return false;
                  if (Array.isArray(value)) {
                    const first = value[0];
                    return Boolean(first && typeof first === 'object' && first.Plan);
                  }
                  return Boolean(typeof value === 'object' && (value.Plan || value['Node Type']));
                };

                // Keep visual explain payload limited to JSON plans only.
                // Text EXPLAIN output remains in table view and can be converted via the UI action.
                if (hasPlanNode(parsed)) {
                  explainPlan = parsed;
                }
              } catch {
                // Ignore non-JSON EXPLAIN text output for explainPlan.
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
          let autoLimitValue: number | undefined;
          if (autoLimitApplied) {
            const lim = query.match(/\bLIMIT\s+(\d+)/i);
            autoLimitValue = lim ? parseInt(lim[1], 10) : undefined;
          }

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
            autoLimitApplied,
            autoLimitValue,
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

          await this.maybePromptForReview();

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
