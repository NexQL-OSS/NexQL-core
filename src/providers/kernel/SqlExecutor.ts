
import * as vscode from 'vscode';
import { debugLog, debugWarn } from '../../common/logger';
import { NotebookCellOutput, NotebookCellOutputItem } from 'vscode';
import { ConnectionManager } from '../../services/ConnectionManager';
import { TelemetryService } from '../../services/TelemetryService';
import {
  NoticeLogEntry,
  PostgresMetadata,
  QueryResults,
  BYTEA_DISPLAY_DEFAULT,
  ByteaDisplayFormat,
} from '../../common/types';
import { getPgDataTypeName, deduplicateColumns } from '../../common/pgDataTypeNames';
import { SqlParser } from './SqlParser';
import { SecretStorageService } from '../../services/SecretStorageService';
import { ErrorService, getErrorExplanation } from '../../services/ErrorService';
import { QueryHistoryService } from '../../services/QueryHistoryService';
import { getTransactionManager } from '../../services/TransactionManager';
import { QueryAnalyzer } from '../../services/QueryAnalyzer';
import { QueryPerformanceService } from '../../services/QueryPerformanceService';
import { extensionContext } from '../../extension';
import {
  clearNotebookParameterValues,
  getNotebookParameterValues,
  rememberNotebookParameterValue,
} from '../../services/NotebookParameterBank';
import { QueryCodeLensProvider } from '../QueryCodeLensProvider';
import { updateNotebookTitle } from '../../utils/notebookTitle';
import { ResultCursorService } from '../../services/ResultCursorService';
import { CursorStreamBannerPolicy } from '../../services/CursorStreamBannerPolicy';
import { FullDatasetPreferenceService } from '../../services/FullDatasetPreferenceService';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { AuditLogService } from '../../features/audit/AuditLogService';
import { getSchemaCache } from '../../lib/schema-cache';

/** Streaming NOTICE feed during a single-statement cell run (replaced by final result output). */
const MIME_NOTICES_LIVE = 'application/vnd.postgres-notebook.notices-live';

/** Tracks result of a single statement execution */
interface StatementResult {
  stmtIndex: number;
  query: string;
  success: boolean;
  rowCount?: number | null;
  rows?: any[];
  columns?: string[];
  columnTypes?: Record<string, string>;
  command?: string;
  error?: string;
  errorCode?: string;
  executionTime: number;
}

/** Failure strategy for multi-statement execution */
type FailureStrategy = 'continue-on-error' | 'fail-on-error' | 'prompt-on-error';

interface NotebookParameterQuickPickItem extends vscode.QuickPickItem {
  value: string;
}

export class SqlExecutor {
  private static readonly REVIEW_COUNT_KEY = 'postgresExplorer.reviewPrompt.successCount';
  private static readonly REVIEW_SHOWN_KEY = 'postgresExplorer.reviewPrompt.shown';
  private static readonly REVIEW_THRESHOLD = 3;

  private readonly _messaging?: vscode.NotebookRendererMessaging;

  constructor(
    private readonly _controller: vscode.NotebookController,
    messaging?: vscode.NotebookRendererMessaging
  ) {
    this._messaging = messaging;
  }

  /**
   * Get the configured failure strategy from settings.
   * Default: 'continue-on-error' (best-effort execution)
   */
  private getFailureStrategy(): FailureStrategy {
    const config = vscode.workspace.getConfiguration('postgresExplorer.query');
    const strategy = config.get<FailureStrategy>('executionFailureStrategy', 'continue-on-error');
    return strategy;
  }

  /**
   * Generate summary markdown for multi-statement execution results.
   * Shows which statements succeeded and which failed.
   */
  private generateSummaryMarkdown(results: StatementResult[]): string {
    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    let markdown = '## Execution Summary\n\n';

    if (succeeded.length > 0) {
      markdown += `✅ **${succeeded.length} statement${succeeded.length === 1 ? '' : 's'} succeeded**\n\n`;
      for (const result of succeeded) {
        const rowInfo = result.rowCount !== null && result.rowCount !== undefined ? ` (${result.rowCount} rows)` : '';
        markdown += `- Statement ${result.stmtIndex + 1}: ${result.command}${rowInfo}\n`;
      }
      markdown += '\n';
    }

    if (failed.length > 0) {
      markdown += `❌ **${failed.length} statement${failed.length === 1 ? '' : 's'} failed**\n\n`;
      for (const result of failed) {
        markdown += `- Statement ${result.stmtIndex + 1}: ${result.error}${result.errorCode ? ` (${result.errorCode})` : ''}\n`;
      }
      markdown += '\n';
    }

    if (succeeded.length > 0 && failed.length > 0) {
      markdown += '💡 **Tip**: Review the changes above. If in a transaction, you can still COMMIT or ROLLBACK.\n';
    }

    return markdown;
  }

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
      'Enjoying NexQL? A quick VS Code Marketplace review helps other PostgreSQL users discover it.',
      leaveReview,
      maybeLater
    );

    await extensionContext.globalState.update(SqlExecutor.REVIEW_SHOWN_KEY, true);

    if (selection === leaveReview) {
      await vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer&ssr=false#review-details'));
    }
  }

  /**
   * Prompts for each `:name` value in order; persists last-used values per notebook.
   * Returns `undefined` if the user cancels any prompt.
   */
  private async promptForNotebookParameterValue(options: {
    notebookUri: string;
    parameterKey: string;
    title: string;
    prompt: string;
    placeHolder?: string;
    initialValue?: string;
    allowNullChoice?: boolean;
  }): Promise<string | null | undefined> {
    const paramsConfig = vscode.workspace.getConfiguration('postgresExplorer.parameters');
    const cacheLastValues = paramsConfig.get<boolean>('cacheLastValues', true);
    const nullSentinel = paramsConfig.get<string>('nullSentinel', 'NULL');
    const workspaceState = extensionContext?.workspaceState;
    const rememberedValues = cacheLastValues && workspaceState
      ? getNotebookParameterValues(workspaceState, options.notebookUri, options.parameterKey)
      : [];

    const chooseExistingValue = async (): Promise<string | null | undefined> => {
      const quickPickItems: NotebookParameterQuickPickItem[] = rememberedValues.map((value) => ({
        label: this.formatNotebookParameterValueLabel(value),
        description: 'Previous value in this notebook',
        value,
      }));

      quickPickItems.push({
        label: '$(edit) Enter new value...',
        description: options.initialValue ? `Current default: ${this.formatNotebookParameterValueLabel(options.initialValue)}` : undefined,
        value: '__new__',
      });

      if (options.allowNullChoice && nullSentinel) {
        quickPickItems.push({
          label: `$(dash) Use ${nullSentinel}`,
          description: 'Send SQL NULL for this parameter',
          value: '__null__',
        });
      }

      quickPickItems.push({
        label: '$(trash) Clear saved values for this notebook parameter',
        description: 'Remove the notebook-local value bank for this parameter',
        value: '__clear__',
      });

      const selection = await vscode.window.showQuickPick(quickPickItems, {
        title: options.title,
        placeHolder: options.prompt,
        ignoreFocusOut: true,
      });

      if (!selection) {
        return undefined;
      }

      if (selection.value === '__clear__') {
        await clearNotebookParameterValues(workspaceState, options.notebookUri, options.parameterKey);
        return undefined;
      }

      if (selection.value === '__null__') {
        return null;
      }

      if (selection.value !== '__new__') {
        if (cacheLastValues && workspaceState) {
          await rememberNotebookParameterValue(workspaceState, options.notebookUri, options.parameterKey, selection.value);
        }
        return selection.value;
      }

      return undefined;
    };

    if (rememberedValues.length > 0) {
      const selection = await chooseExistingValue();
      if (selection !== undefined) {
        return selection;
      }
    }

    const input = await vscode.window.showInputBox({
      title: options.title,
      prompt: options.prompt,
      placeHolder: options.placeHolder,
      value: options.initialValue ?? rememberedValues[0] ?? '',
      ignoreFocusOut: true,
    });

    if (input === undefined) {
      return undefined;
    }

    const isNull = Boolean(nullSentinel && input.toLowerCase() === nullSentinel.toLowerCase());
    if (cacheLastValues && workspaceState && !isNull) {
      await rememberNotebookParameterValue(workspaceState, options.notebookUri, options.parameterKey, input);
    }

    return isNull ? null : input;
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

  private formatNotebookParameterValueLabel(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '(empty string)';
    }
    return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
  }

  private makeNotebookParameterKey(kind: 'named' | 'positional' | 'quoted', value: string): string {
    return `${kind}:${value}`;
  }

  private async promptForPositionalParameterValues(
    notebookUri: string,
    indices: number[],
    sql: string,
    commentValues?: Map<number, string | null>
  ): Promise<unknown[] | undefined> {
    const values: unknown[] = [];

    for (const parameterIndex of indices) {
      if (commentValues?.has(parameterIndex)) {
        values.push(commentValues.get(parameterIndex) ?? null);
        continue;
      }
      const contextSnippet = this.getSqlParameterContextSnippet(sql, parameterIndex);
      const input = await this.promptForNotebookParameterValue({
        notebookUri,
        parameterKey: this.makeNotebookParameterKey('positional', String(parameterIndex)),
        title: `SQL parameter $${parameterIndex}`,
        prompt: `Enter the raw value for $${parameterIndex}${contextSnippet ? ` - ${contextSnippet}` : ''} (do not add quotes; NexQL sends the parameter value directly)`,
        placeHolder: contextSnippet,
        allowNullChoice: true,
      });
      if (input === undefined) {
        return undefined;
      }

      values.push(input);
    }

    return values;
  }

  private async promptForQuotedPsqlValues(
    notebookUri: string,
    tokens: { name: string; kind: 'literal' | 'identifier' }[]
  ): Promise<Record<string, string> | undefined> {
    const values: Record<string, string> = {};

    for (const token of tokens) {
      if (Object.prototype.hasOwnProperty.call(values, token.name)) {
        continue;
      }
      const tokenLabel = token.kind === 'literal' ? `:'${token.name}'` : `:"${token.name}"`;
      const input = await this.promptForNotebookParameterValue({
        notebookUri,
        parameterKey: this.makeNotebookParameterKey('quoted', `${token.kind}:${token.name}`),
        title: `SQL variable ${tokenLabel}`,
        prompt: `Value for ${tokenLabel}`,
        allowNullChoice: false,
      });
      if (input === undefined) {
        return undefined;
      }

      values[token.name] = input ?? '';
    }

    return values;
  }

  /**
   * Prompts for each `:name` value in order; persists last-used values per notebook.
   * Returns `undefined` if the user cancels any prompt.
   */
  private async promptForNamedParameterValues(
    notebookUri: string,
    paramNames: string[],
    commentValues?: Map<string, string | null>
  ): Promise<unknown[] | undefined> {
    const values: unknown[] = [];

    for (const name of paramNames) {
      if (commentValues?.has(name)) {
        values.push(commentValues.get(name) ?? null);
        continue;
      }
      const input = await this.promptForNotebookParameterValue({
        notebookUri,
        parameterKey: this.makeNotebookParameterKey('named', name),
        title: `SQL parameter :${name}`,
        prompt: `Enter the raw value for :${name} (do not add quotes; NexQL sends the parameter value directly)`,
        allowNullChoice: true,
      });

      if (input === undefined) {
        return undefined;
      }

      values.push(input);
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

  /**
   * Build a consolidated warning message for multiple dangerous operations in a cell.
   * Groups operations by type, shows counts, and provides transaction guidance.
   */
  private buildConsolidatedWarningMessage(
    dangerousOpsWithAnalysis: Array<{ stmt: string; analysis: any }>,
    connection: any
  ): string {
    // Aggregate all operations by type
    const operationCounts: Record<string, number> = {};

    for (const { analysis } of dangerousOpsWithAnalysis) {
      for (const op of analysis.operations) {
        operationCounts[op.type] = (operationCounts[op.type] || 0) + 1;
      }
    }

    const envPrefix =
      connection?.environment === 'production'
        ? '⚠️ PRODUCTION DATABASE ⚠️\n\n'
        : connection?.environment === 'staging'
          ? '⚠️ STAGING DATABASE ⚠️\n\n'
          : '';

    // Build summary of operation counts
    const operationSummary = Object.entries(operationCounts)
      .map(([type, count]) => {
        const plural = count === 1 ? '' : 's';
        return `• ${count} ${type}${plural}`;
      })
      .join('\n');

    const totalCount = Object.values(operationCounts).reduce((a, b) => a + b, 0);

    const message =
      envPrefix +
      `This cell contains ${totalCount} dangerous SQL command${totalCount === 1 ? '' : 's'}:\n\n` +
      operationSummary +
      '\n\n' +
      '💡 Using a transaction block reduces risk:\n' +
      'Choose "Execute in Transaction" to wrap all commands in BEGIN...COMMIT.\n' +
      'This allows you to review changes before committing, or run ROLLBACK to undo if needed.\n\n' +
      'Are you sure you want to proceed?';

    return message;
  }

  private async insertTransactionControlCell(cell: vscode.NotebookCell): Promise<void> {
    const notebook = cell.notebook;
    if (!notebook) {
      return;
    }

    const controlCellContent = [
      '-- Transaction controls',
      '-- COMMIT;   applies all changes in this transaction permanently.',
      '-- ROLLBACK; undoes all changes made since BEGIN.',
      '',
      '-- Review the results above, then choose one command to run:',
      'COMMIT;',
      '-- ROLLBACK;'
    ].join('\n');

    const insertionIndex = Math.min(notebook.cellCount, cell.index + 1);
    const newCell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, controlCellContent, 'sql');
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertionIndex, [newCell])]);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showWarningMessage('Transaction started, but NexQL could not insert the follow-up COMMIT/ROLLBACK cell.');
    }
  }

  private async persistPromptedParamComments(
    cell: vscode.NotebookCell,
    keys: (number | string)[],
    vals: unknown[],
    commentDefined: Map<number | string, string | null>,
    kind: 'positional' | 'named'
  ): Promise<void> {
    const lines: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if ((commentDefined as Map<any, any>).has(key)) { continue; }
      const v = vals[i];
      const valStr = v === null ? 'NULL' : String(v);
      lines.push(kind === 'positional' ? `-- $${key}=${valStr}` : `-- :${key}=${valStr}`);
    }
    if (lines.length === 0) { return; }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(cell.document.uri, new vscode.Position(0, 0), lines.join('\n') + '\n');
    await vscode.workspace.applyEdit(edit);
  }

  /**
   * Optional execution directives embedded as SQL comments at top-level.
   * - nexql:full-dataset => disable streaming + disable auto-limit for this statement.
   * - nexql:no-stream    => disable streaming + disable auto-limit for this statement.
   */
  private consumeExecutionDirectives(query: string): {
    query: string;
    disableStreaming: boolean;
    disableAutoLimit: boolean;
  } {
    const hasFullDataset = /\bnexql:(?:full-dataset|no-stream)\b/i.test(query);
    const stripped = query
      .replace(/^\s*--\s*nexql:(?:full-dataset|no-stream)\s*$/gim, '')
      .replace(/\/\*\s*nexql:(?:full-dataset|no-stream)\s*\*\//gim, '')
      .trim();
    return {
      query: stripped,
      disableStreaming: hasFullDataset,
      disableAutoLimit: hasFullDataset,
    };
  }

  public async executeCell(cell: vscode.NotebookCell) {
    debugLog(`SqlExecutor: Starting cell execution. Controller ID: ${this._controller.id}`);
    const execution = this._controller.createNotebookCellExecution(cell);
    const startTime = Date.now();
    execution.start(startTime);
    await execution.clearOutput();

    try {
      let metadata = ConnectionUtils.getEffectiveMetadata(cell.notebook.metadata) as PostgresMetadata;
      if (!metadata) {
        throw new Error('No connection metadata found');
      }

      // Fetch active profile context from globalState
      // This allows different notebooks to have different active profiles
      const notebookKey = `activeProfile-${cell.notebook.uri.toString()}`;
      const activeProfileContext = extensionContext?.globalState.get<any>(notebookKey);

      // Get connection info using robust fallback
      const connection = ConnectionUtils.findConnectionWithFallback(metadata.connectionId, cell.notebook.metadata);
      if (!connection) {
        throw new Error('Connection not found');
      }

      // If we matched the connection via fallback, correct the metadata in the notebook
      if (metadata.connectionId !== connection.id) {
        metadata = {
          ...metadata,
          connectionId: connection.id
        };
        try {
          const persisted = await ConnectionUtils.updateNotebookMetadata(cell.notebook, {
            connectionId: connection.id,
          });
          if (!persisted) {
            debugWarn(
              'Notebook metadata connectionId corrected in memory only; workspace edit was not applied.',
            );
          }
        } catch (err) {
          debugWarn('Failed to update notebook metadata with correct connection ID:', err);
        }
      }

      // Apply profile settings with floor protection (connection level readOnly cannot be downgraded)
      let readOnlyMode = connection.readOnlyMode === true;
      if (metadata.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || metadata.readOnlyMode;
      }
      if (activeProfileContext?.readOnlyMode !== undefined) {
        readOnlyMode = readOnlyMode || activeProfileContext.readOnlyMode;
      }
      connection.readOnlyMode = readOnlyMode;

      const client = await ConnectionManager.getInstance().getSessionClient({
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        database: metadata.databaseName || connection.database,
        name: connection.name
      }, cell.notebook.uri.toString());

      debugLog('SqlExecutor: Connected to database');

      // Get PostgreSQL backend PID for query cancellation
      let backendPid: number | null = null;
      try {
        const pidResult = await client.query('SELECT pg_backend_pid()');
        backendPid = pidResult.rows[0]?.pg_backend_pid || null;
        debugLog('SqlExecutor: Backend PID:', backendPid);
      } catch (err) {
        debugWarn('Failed to get backend PID:', err);
      }

      const queryText = cell.document.getText();
      const statements = SqlParser.splitSqlStatements(queryText);
      const allowLiveNotices = statements.length === 1;

      // Capture PostgreSQL NOTICE messages (timestamp = client receive time, log-style)
      const notices: NoticeLogEntry[] = [];
      let liveNoticesActive = false;
      const pushNotice = (message: string) => {
        notices.push({ message, receivedAt: new Date().toISOString() });
      };
      const emitLiveNoticesIfNeeded = () => {
        if (!allowLiveNotices || notices.length === 0) {
          return;
        }
        liveNoticesActive = true;
        void (async () => {
          try {
            const payload = { streaming: true as const, notices: [...notices] };
            await execution.replaceOutput([
              new NotebookCellOutput([
                new NotebookCellOutputItem(
                  Buffer.from(JSON.stringify(payload), 'utf8'),
                  MIME_NOTICES_LIVE,
                ),
              ]),
            ]);
          } catch (e) {
            console.error('SqlExecutor: live notice output failed', e);
          }
        })();
      };
      const noticeListener = (msg: any) => {
        const message = msg.message || msg.toString();
        pushNotice(message);
        emitLiveNoticesIfNeeded();
      };
      client.on('notice', noticeListener);

      debugLog('SqlExecutor: Executing', statements.length, 'statement(s)');

      // Safety check: Pre-analyze all queries for dangerous operations
      const queryAnalyzer = QueryAnalyzer.getInstance();
      let userConfirmedDangerousOps: 'Execute' | 'Execute in Transaction' | 'Cancelled' | null = null;

      // Resolve autoApplySafetyCheck (activeProfileContext has precedence over notebook metadata)
      let autoApplySafetyCheck = true;
      if (activeProfileContext?.autoApplySafetyCheck !== undefined) {
        autoApplySafetyCheck = !!activeProfileContext.autoApplySafetyCheck;
      } else if (metadata?.autoApplySafetyCheck !== undefined) {
        autoApplySafetyCheck = !!metadata.autoApplySafetyCheck;
      }

      // Collect all dangerous operations and perform read-only checks
      const allDangerousOps: Array<{ stmt: string; analysis: any }> = [];
      for (const stmt of statements) {
        // Check read-only mode
        if (connection.readOnlyMode && !queryAnalyzer.isReadOnlyQuery(stmt)) {
          throw new Error('Write operations are not allowed in read-only mode');
        }

        // Analyze for dangerous operations
        const analysis = queryAnalyzer.analyzeQuery(stmt, connection);
        if (analysis.requiresConfirmation && autoApplySafetyCheck) {
          allDangerousOps.push({ stmt, analysis });
        }
      }

      // If there are dangerous operations, show ONE consolidated confirmation
      if (allDangerousOps.length > 0) {
        const consolidatedMessage = this.buildConsolidatedWarningMessage(
          allDangerousOps,
          connection
        );
        const action = await vscode.window.showWarningMessage(
          consolidatedMessage,
          { modal: true },
          'Execute',
          'Execute in Transaction'
        );

        if (!action) {
          throw new Error('Query execution cancelled by user');
        }

        userConfirmedDangerousOps = action as 'Execute' | 'Execute in Transaction';

        // If user chose "Execute in Transaction", start one now
        if (userConfirmedDangerousOps === 'Execute in Transaction') {
          const txManager = getTransactionManager();
          const sessionId = cell.notebook.uri.toString();
          const txInfo = txManager.getTransactionInfo(sessionId);

          if (!txInfo || !txInfo.isActive) {
            await client.query('BEGIN');
            if (!txInfo) {
              txManager.initializeSession(sessionId, true);
            }
            pushNotice(
              'Transaction started automatically for safety. Run COMMIT or ROLLBACK when done.',
            );
            emitLiveNoticesIfNeeded();
          }

          await this.insertTransactionControlCell(cell);
        }
      }

      // Audit trail (Singularity): record DDL/destructive statements on PROD-tagged connections.
      void AuditLogService.getInstance().record(
        {
          connectionName: connection.name || connection.id,
          host: connection.host,
          database: metadata.databaseName || connection.database || '',
          environment: connection.environment || '',
        },
        statements,
      );

      // Execute each statement
      const statementsResults: StatementResult[] = [];
      const failureStrategy = this.getFailureStrategy();
      for (let stmtIndex = 0; stmtIndex < statements.length; stmtIndex++) {
        ResultCursorService.closeSessionsForCellUri(cell.document.uri.toString());
        liveNoticesActive = false;
        let query = statements[stmtIndex];
        const stmtStartTime = Date.now();
        const notebookUri = cell.notebook.uri.toString();

        const params = SqlParser.detectParameters(query);
        const hasPositional = params.positional.length > 0;
        const hasNamed = params.named.length > 0;

        if (hasPositional && hasNamed) {
          throw new Error('Mixing $N and :name parameters in the same statement is not supported. Use one style per query.');
        }

        const commentParams = SqlParser.parseCommentParameters(query);
        let pgParamValues: unknown[] | undefined;

        if (params.quoted.length > 0) {
          const quotedVals = await this.promptForQuotedPsqlValues(notebookUri, params.quoted);
          if (!quotedVals) {
            client.removeListener('notice', noticeListener);
            execution.end(false, Date.now());
            return;
          }
          query = SqlParser.substituteQuotedPsqlVariables(query, quotedVals).text;
        }

        if (hasNamed) {
          const named = SqlParser.substituteNamedParametersWithPgPlaceholders(query);
          const vals = await this.promptForNamedParameterValues(notebookUri, named.paramNames, commentParams.named);
          if (vals === undefined) {
            client.removeListener('notice', noticeListener);
            execution.end(false, Date.now());
            return;
          }
          query = named.text;
          pgParamValues = vals;
          await this.persistPromptedParamComments(cell, named.paramNames, vals, commentParams.named, 'named');
        } else if (hasPositional) {
          const indices = Array.from({ length: Math.max(...params.positional) }, (_, i) => i + 1);
          const vals = await this.promptForPositionalParameterValues(
            notebookUri,
            indices,
            query,
            commentParams.positional
          );
          if (vals === undefined) {
            client.removeListener('notice', noticeListener);
            execution.end(false, Date.now());
            return;
          }
          pgParamValues = vals;
          await this.persistPromptedParamComments(cell, indices, vals, commentParams.positional, 'positional');
        }

        const directives = this.consumeExecutionDirectives(query);
        query = directives.query;
        if (!query.trim()) {
          continue;
        }

        const fullDatasetPref = FullDatasetPreferenceService.isEnabled(cell.document.uri.toString());
        const useFullDataset = directives.disableStreaming || fullDatasetPref;

        const originalQuery = query;
        let queryForExecution = query;
        let autoLimitApplied = false;
        let usedSlidingWindow = false;
        let slidingPayload: QueryResults['slidingWindow'];
        let openedSession: Awaited<ReturnType<typeof ResultCursorService.tryOpenSession>> = null;

        const windowSize = ResultCursorService.getWindowSizeCap();
        const trySliding =
          !useFullDataset &&
          ResultCursorService.isGloballyEnabled() &&
          pgParamValues === undefined &&
          ResultCursorService.isEligibleQuery(query);

        if (trySliding) {
          const txInfo = getTransactionManager().getTransactionInfo(cell.notebook.uri.toString());
          openedSession = await ResultCursorService.tryOpenSession({
            client,
            notebookUri: cell.notebook.uri.toString(),
            cellUri: cell.document.uri.toString(),
            sql: query,
            inTransaction: !!txInfo?.isActive,
            windowSize,
          });
          if (openedSession) {
            usedSlidingWindow = true;
            slidingPayload = openedSession.payload;
          }
        }

        if (!usedSlidingWindow && !useFullDataset) {
          queryForExecution = this.applyAutoLimit(query, connection, metadata, activeProfileContext);
          autoLimitApplied = queryForExecution !== originalQuery;
        }

        debugLog(`SqlExecutor: Executing statement ${stmtIndex + 1}/${statements.length}:`, queryForExecution.substring(0, 100));

        let result;
        const telemetry = TelemetryService.getInstance();
        try {
          if (usedSlidingWindow && openedSession) {
            result = {
              rows: openedSession.rows,
              fields: openedSession.fields as any,
              rowCount: null,
              command: 'SELECT',
            };
          } else {
            result =
              pgParamValues !== undefined
                ? await client.query({ text: queryForExecution, values: pgParamValues, rowMode: 'array' })
                : await client.query({ text: queryForExecution, rowMode: 'array' });
          }

          const stmtEndTime = Date.now();
          const executionTime = (stmtEndTime - stmtStartTime) / 1000;
          const durationMs = executionTime * 1000;

          // ... (auto-limit notice)

          const success = true;
          const slowThresholdMs = vscode.workspace.getConfiguration().get<number>('postgresExplorer.performance.slowQueryThresholdMs', 2000);
          const isSlow = durationMs >= slowThresholdMs;

          // Performance Tracking
          const queryAnalyzer = QueryAnalyzer.getInstance();
          const queryHash = queryAnalyzer.getQueryHash(queryForExecution);
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

          debugLog('[Performance] Hash:', queryHash);
          debugLog('[Performance] Baseline:', JSON.stringify(baseline));
          debugLog('[Performance] Duration:', durationMs);
          debugLog('[Performance] Analysis:', JSON.stringify(performanceAnalysis));

          // Build output data
          const tableInfo = await this.getTableInfo(client, result, queryForExecution);
          let autoLimitValue: number | undefined;
          if (autoLimitApplied) {
            const lim = queryForExecution.match(/\bLIMIT\s+(\d+)/i);
            autoLimitValue = lim ? parseInt(lim[1], 10) : undefined;
          }

          const uniqueColumns = deduplicateColumns(result.fields?.map((f: any) => f.name) || []);

          if (result.fields) {
            result.fields.forEach((f: any, idx: number) => {
              f.name = uniqueColumns[idx];
            });
          }

          const rawRows = result.rows || [];
          const rows = rawRows.map((rowArray: any) => {
            if (Array.isArray(rowArray)) {
              const rowObj: Record<string, any> = {};
              uniqueColumns.forEach((colName, index) => {
                rowObj[colName] = rowArray[index];
              });
              return rowObj;
            }
            return rowArray;
          });

          telemetry.trackEvent('query_executed', {
            success: true,
            durationBucket: telemetry.durationBucket(durationMs),
            resultSizeBucket: rows.length === 0 ? '0' : rows.length < 10 ? '1_9' : rows.length < 100 ? '10_99' : rows.length < 1000 ? '100_999' : 'gte_1000',
          });
          let columns = uniqueColumns;
          if (columns.length === 0 && rows.length > 0) {
            columns = Object.keys(rows[0]);
          }
          const columnTypes: Record<string, string> = {};
          if (result.fields) {
            result.fields.forEach((f: any, idx: number) => {
              columnTypes[f.name] = getPgDataTypeName(f.dataTypeID);
            });
          }
          for (const c of columns) {
            if (columnTypes[c] === undefined) {
              columnTypes[c] = 'text';
            }
          }

          const rawByteaFmt = vscode.workspace
            .getConfiguration('postgresExplorer')
            .get<string>('query.byteaDisplayFormat');
          const byteaDisplayFormat: ByteaDisplayFormat =
            rawByteaFmt === 'hex0x' || rawByteaFmt === 'postgresql' || rawByteaFmt === 'json'
              ? rawByteaFmt
              : BYTEA_DISPLAY_DEFAULT;

          let showSlidingCursorBanner = false;
          if (slidingPayload && extensionContext) {
            const slidingCount = CursorStreamBannerPolicy.incrementSlidingExecCount(
              extensionContext.workspaceState,
            );
            showSlidingCursorBanner = CursorStreamBannerPolicy.shouldShowBanner(
              extensionContext.globalState,
              extensionContext.workspaceState,
              slidingCount,
            );
          }

          const outputData: QueryResults = {
            success,
            rowCount: result.rowCount,
            rows,
            columns,
            columnTypes,
            command: result.command,
            query: queryForExecution,
            exportQuery: originalQuery,
            byteaDisplayFormat,
            notices: [...notices], // Copy current notices
            executionTime,
            backendPid,
            tableInfo,
            explainPlan,
            performanceAnalysis, // Pass analysis to frontend
            slowQuery: isSlow,
            autoLimitApplied,
            autoLimitValue,
            ...(slidingPayload
              ? {
                  slidingWindow: slidingPayload,
                  ...(showSlidingCursorBanner ? { showSlidingCursorBanner: true } : {}),
                }
              : {}),
            breadcrumb: {
              connectionId: connection.id,
              connectionName: connection.name || connection.host,
              database: metadata.databaseName || connection.database,
              schema: tableInfo?.schema,
              object: tableInfo?.table ? { name: tableInfo.table, type: 'table' } : undefined
            },
            sourceCellIndex: cell.index,
          };

          if (rows && rows.length > 50000 && this._messaging) {
            const resultId = `result-${Date.now()}-${Math.random()}`;
            try {
              const jsonStr = JSON.stringify(rows);
              const encoder = new TextEncoder();
              const encoded = encoder.encode(jsonStr);
              const sab = new SharedArrayBuffer(encoded.byteLength);
              const sabView = new Uint8Array(sab);
              sabView.set(encoded);

              this._messaging.postMessage({
                type: 'largeResultRows',
                resultId,
                sharedBuffer: sab,
              });

              (outputData as any).resultId = resultId;
              outputData.rows = [];
            } catch (sabError) {
              // Some renderer/runtime configurations can reject SAB usage.
              // Fall back to inline rows so result rendering still succeeds.
              debugWarn('SqlExecutor: SharedArrayBuffer transport unavailable, using inline rows.', sabError);
            }
          }

          // Clear notices for next statement
          notices.length = 0;

          const successOutput = new NotebookCellOutput([
            new NotebookCellOutputItem(
              Buffer.from(JSON.stringify(outputData), 'utf8'),
              'application/vnd.postgres-notebook.result',
            ),
          ]);
          if (allowLiveNotices && liveNoticesActive) {
            await execution.replaceOutput(successOutput);
          } else {
            await execution.appendOutput(successOutput);
          }

          // Update execution time pill in CodeLens bar
          QueryCodeLensProvider.getInstance()?.updatePill(cell.document.uri.toString(), {
            success: true,
            elapsedSeconds: executionTime,
            rowCount: result.rowCount ?? rows.length
          });

          // Log to history
          QueryHistoryService.getInstance().add({
            query: queryForExecution,
            success: true,
            duration: executionTime,
            durationMs,
            slow: isSlow,
            rowCount: result.rowCount ?? rows.length,
            connectionName: connection.name,
            connectionId: connection.id,
            databaseName: metadata.databaseName || connection.database
          });

          // Collect successful result
          statementsResults.push({
            stmtIndex,
            query: queryForExecution,
            success: true,
            rowCount: result.rowCount,
            rows: rows,
            columns: columns,
            columnTypes: columnTypes,
            command: result.command,
            executionTime,
          });

          const qa = QueryAnalyzer.getInstance();
          if (qa.isCatalogInvalidatingSql(statements[stmtIndex]) || qa.isSearchPathChangingSql(statements[stmtIndex])) {
            const dbName = metadata.databaseName || connection.database || 'postgres';
            // Invalidate autocomplete cache so next completion triggers a fresh catalog fetch.
            void import('../SqlCompletionProvider').then(mod => {
              mod.SqlCompletionProvider.getInstance()?.invalidate(connection.id, dbName);
            });
            // Also invalidate the explorer SchemaCache so the sidebar tree reflects DDL changes
            // immediately instead of waiting for the next background poller tick.
            getSchemaCache().invalidateDatabase(connection.id, dbName);
            void vscode.commands.executeCommand('postgres-explorer.refresh').then(
              undefined,
              () => { /* refresh command may not be registered during early activation */ }
            );
          }

        } catch (err: any) {
          const stmtEndTime = Date.now();
          const executionTime = (stmtEndTime - stmtStartTime) / 1000;
          const durationMs = executionTime * 1000;
          telemetry.trackEvent('query_executed', {
            success: false,
            durationBucket: telemetry.durationBucket(durationMs),
            resultSizeBucket: '0',
          });

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
            errorExplanation: pgErrorCode ? getErrorExplanation(pgErrorCode) : undefined,
            sourceCellIndex: cell.index,
            breadcrumb: {
              connectionId: connection.id,
              connectionName: connection.name || connection.host,
              database: metadata.databaseName || connection.database,
            },
          };

          const errorOutput = new NotebookCellOutput([
            new NotebookCellOutputItem(
              Buffer.from(JSON.stringify(errorData), 'utf8'),
              'application/vnd.postgres-notebook.error',
            ),
          ]);
          if (allowLiveNotices && liveNoticesActive) {
            await execution.replaceOutput(errorOutput);
          } else {
            await execution.appendOutput(errorOutput);
          }

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
            connectionName: connection.name,
            connectionId: connection.id,
            databaseName: metadata.databaseName || connection.database
          });

          // Collect error result
          statementsResults.push({
            stmtIndex,
            query,
            success: false,
            error: err.message,
            errorCode: pgErrorCode,
            executionTime,
          });

          // Handle failure strategy
          if (failureStrategy === 'fail-on-error') {
            // Stop execution on error (current behavior)
            break;
          } else if (failureStrategy === 'prompt-on-error') {
            // Ask user whether to continue
            const choice = await vscode.window.showErrorMessage(
              `Statement ${stmtIndex + 1} failed: ${err.message}\n\nContinue executing remaining statements?`,
              { modal: true },
              'Continue',
              'Stop'
            );
            if (!choice || choice === 'Stop') {
              break;
            }
            // Otherwise continue to next statement
          }
          // If 'continue-on-error', just continue without breaking
        }
      }

      // If multi-statement with mixed results, append summary
      if (statements.length > 1 && statementsResults.length > 0) {
        const succeeded = statementsResults.filter(r => r.success);
        const failed = statementsResults.filter(r => !r.success);
        
        if (succeeded.length > 0 && failed.length > 0) {
          const summaryMarkdown = this.generateSummaryMarkdown(statementsResults);
          const summaryOutput = new NotebookCellOutput([
            new NotebookCellOutputItem(
              Buffer.from(summaryMarkdown, 'utf8'),
              'text/markdown',
            ),
          ]);
          await execution.appendOutput(summaryOutput);
        }
      }

      client.removeListener('notice', noticeListener);
      execution.end(true, Date.now());
      void this.maybePromptForReview();
      // Update notebook title after successful cell execution
      updateNotebookTitle(cell.notebook).catch(err => debugWarn('Failed to update notebook title:', err));

    } catch (err: any) {
      console.error('SqlExecutor: Execution failed:', err);
      const pgErrorCode: string | undefined = err.code;

      let breadcrumb: any = undefined;
      try {
        const metadata = ConnectionUtils.getEffectiveMetadata(cell.notebook.metadata);
        if (metadata) {
          const connection = ConnectionUtils.findConnectionWithFallback(metadata.connectionId, cell.notebook.metadata);
          if (connection) {
            breadcrumb = {
              connectionId: connection.id,
              connectionName: connection.name || connection.host,
              database: metadata.databaseName || connection.database,
            };
          }
        }
      } catch {
        // Ignore
      }

      const errorData = {
        success: false,
        error: err.message || String(err),
        query: cell.document.getText(),
        executionTime: 0,
        slowQuery: false,
        canExplain: false,
        errorCode: pgErrorCode,
        errorExplanation: pgErrorCode ? getErrorExplanation(pgErrorCode) : undefined,
        sourceCellIndex: cell.index,
        ...(breadcrumb ? { breadcrumb } : {}),
      };

      await execution.replaceOutput(new NotebookCellOutput([
        new NotebookCellOutputItem(
          Buffer.from(JSON.stringify(errorData), 'utf8'),
          'application/vnd.postgres-notebook.error',
        ),
      ]));

      // Update execution time pill in CodeLens bar (failure)
      QueryCodeLensProvider.getInstance()?.updatePill(cell.document.uri.toString(), {
        success: false
      });

      execution.end(false, Date.now());
      // Update notebook title even after failed execution (cell content may have changed)
      updateNotebookTitle(cell.notebook).catch(err => debugWarn('Failed to update notebook title:', err));
    }
  }

  // --- Helpers ---

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
      let metadata = ConnectionUtils.getEffectiveMetadata(notebook.metadata) as PostgresMetadata;
      if (!metadata) throw new Error('No connection found');

      const connection = ConnectionUtils.findConnectionWithFallback(metadata.connectionId, notebook.metadata);
      if (!connection) throw new Error('Connection not found');

      // If we matched the connection via fallback, correct the metadata in the notebook
      if (metadata.connectionId !== connection.id) {
        metadata = {
          ...metadata,
          connectionId: connection.id
        };
        try {
          const persisted = await ConnectionUtils.updateNotebookMetadata(notebook, {
            connectionId: connection.id,
          });
          if (!persisted) {
            debugWarn(
              'Notebook metadata connectionId corrected in memory only; workspace edit was not applied.',
            );
          }
        } catch (err) {
          debugWarn('Failed to update notebook metadata with correct connection ID:', err);
        }
      }

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
