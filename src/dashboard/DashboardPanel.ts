import { Client, PoolClient } from 'pg';
import * as vscode from 'vscode';
import { fetchStats, DashboardStats } from './DashboardData';
import { DASHBOARD_LOADING_SHELL_MARKER, getErrorHtml, getHtmlForWebview, getLoadingHtml } from './DashboardHtml';
import { ConnectionManager } from '../services/ConnectionManager';
import { ConnectionConfig } from '../common/types';
import { createMetadata, createAndShowNotebook } from '../commands/connection';
import { AiService } from '../providers/chat/AiService';
import { ChatMessage } from '../providers/chat/types';
import { TelemetryService } from '../services/TelemetryService';
import { disposePooledOwner, WebviewPool } from '../utils/WebviewPool';

export class DashboardPanel {
  private static panels: Map<string, DashboardPanel> = new Map();
  public readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  public _panelKey: string;
  private _aiService: AiService | null = null;
  private _lastStats: DashboardStats | null = null;
  private _autoNotifyEnabled = false;
  private _lastHealthCritical = false;
  private _conversationMessages: ChatMessage[] = [];
  private _lastSuccessfulRefreshAt = 0;
  private _staleWarningShown = false;
  private _isDisposed = false;
  /** Bumped on recycle / param change so in-flight async work cannot post stale state. */
  private _sessionGeneration = 0;

  private _config: ConnectionConfig;
  private _dbName: string;

  private constructor(
    panel: vscode.WebviewPanel,
    config: ConnectionConfig,
    dbName: string,
    panelKey: string,
    private readonly extensionUri: vscode.Uri,
  ) {
    this._panel = panel;
    this._config = config;
    this._dbName = dbName;
    this._panelKey = panelKey;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = getLoadingHtml();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'refresh':
            await this._update();
            break;
          case 'showDetails':
            await this._showDetails(message.type);
            break;
          case 'explainQuery':
            // Open a new notebook with the query, prefixed with EXPLAIN ANALYZE
            // and connected to the current database
            const metadata = createMetadata(this._config, this._dbName);
            const cell = new vscode.NotebookCellData(
              vscode.NotebookCellKind.Code,
              'EXPLAIN ANALYZE ' + message.query,
              'sql'
            );
            await createAndShowNotebook([cell], metadata);
            break;
          case 'terminateQuery':
            const termAns = await vscode.window.showWarningMessage(
              `Are you sure you want to terminate query ${message.pid}?`,
              { modal: true },
              'Yes', 'No'
            );
            if (termAns === 'Yes') {
              await this._terminateQuery(message.pid);
            }
            break;
          case 'cancelQuery':
            const cancelAns = await vscode.window.showWarningMessage(
              `Are you sure you want to cancel query ${message.pid}?`,
              { modal: true },
              'Yes', 'No'
            );
            if (cancelAns === 'Yes') {
              await this._cancelQuery(message.pid);
            }
            break;
          case 'askAI':
            await this._handleAskAI(message.question, message.context);
            break;
          case 'executeQueryForAI':
            await this._executeQueryForAI(message.sql, message.question);
            break;
          case 'toggleAutoNotify':
            this._autoNotifyEnabled = Boolean(message.enabled);
            break;
          case 'clearConversation':
            this._conversationMessages = [];
            break;
          case 'downloadCsv':
            await this._downloadCsv(message.csv, message.filename);
            break;
        }
      },
      null,
      this._disposables
    );

    this._update();
  }

  public updateParams(config: ConnectionConfig, dbName: string, panelKey: string) {
    this._resetSessionState();
    this._config = config;
    this._dbName = dbName;
    this._panelKey = panelKey;
    this._panel.webview.html = getLoadingHtml();
    this._update();
  }

  /** Invalidate in-flight work and clear session-scoped state (pool recycle / DB switch). */
  private _resetSessionState(): void {
    this._sessionGeneration += 1;
    this._conversationMessages = [];
    this._lastStats = null;
    this._autoNotifyEnabled = false;
    this._lastHealthCritical = false;
    this._lastSuccessfulRefreshAt = 0;
    this._staleWarningShown = false;
    this._aiService = null;
  }

  private _isSessionCurrent(generation: number): boolean {
    return generation === this._sessionGeneration;
  }

  public static async show(extensionUri: vscode.Uri, config: ConnectionConfig, dbName: string, connectionId?: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // Track dashboard opened
    TelemetryService.getInstance().trackDashboardOpened();

    // Create unique key for this dashboard (connection + database)
    const connId = connectionId || 'default';
    const panelKey = `${connId}-${dbName}`;

    // If an existing panel map already has this exact panelKey, reveal it
    const existing = DashboardPanel.panels.get(panelKey);
    if (existing) {
      existing._panel.reveal(column || vscode.ViewColumn.One);
      return;
    }

    const { panel, isNew, commit } = WebviewPool.getInstance().getOrCreate(
      'postgresDashboard',
      panelKey,
      `Dashboard: ${dbName}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      },
      {
        onDispose: () => {
          disposePooledOwner(DashboardPanel.panels, panel, false);
        },
        onRecycle: (recycled) => {
          disposePooledOwner(DashboardPanel.panels, recycled.panel, true);
        },
      }
    );

    if (isNew) {
      const dashboardPanel = new DashboardPanel(panel, config, dbName, panelKey, extensionUri);
      DashboardPanel.panels.set(panelKey, dashboardPanel);
      (panel as any).owner = dashboardPanel;
    } else {
      // Recycled! Update params on the owner of the recycled panel
      const oldOwner = (panel as any).owner as DashboardPanel;
      if (oldOwner) {
        // Delete old panelKey from the panels map
        DashboardPanel.panels.delete(oldOwner._panelKey);

        // Update its params for the new db
        oldOwner.updateParams(config, dbName, panelKey);

        // Set new key in map
        DashboardPanel.panels.set(panelKey, oldOwner);
      } else {
        const dashboardPanel = new DashboardPanel(panel, config, dbName, panelKey, extensionUri);
        DashboardPanel.panels.set(panelKey, dashboardPanel);
        (panel as any).owner = dashboardPanel;
      }
    }
    commit?.();
  }

  public dispose(isRecycling = false): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    DashboardPanel.panels.delete(this._panelKey);
    if (!isRecycling) {
      this._panel.dispose();
    }
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private async getClient(): Promise<PoolClient> {
    return await ConnectionManager.getInstance().getPooledClient(this._config);
  }

  private async _terminateQuery(pid: number) {
    const generation = this._sessionGeneration;
    let client;
    try {
      client = await this.getClient();
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      await client.query('SELECT pg_terminate_backend($1)', [pid]);
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      vscode.window.showInformationMessage(`Terminated query with PID ${pid}`);
      this._update();
    } catch (error: any) {
      if (this._isSessionCurrent(generation)) {
        vscode.window.showErrorMessage(`Failed to terminate query: ${error.message}`);
      }
    } finally {
      if (client) client.release();
    }
  }

  private async _cancelQuery(pid: number) {
    const generation = this._sessionGeneration;
    let client;
    try {
      client = await this.getClient();
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      await client.query('SELECT pg_cancel_backend($1)', [pid]);
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      vscode.window.showInformationMessage(`Cancelled query with PID ${pid}`);
      this._update();
    } catch (error: any) {
      if (this._isSessionCurrent(generation)) {
        vscode.window.showErrorMessage(`Failed to cancel query: ${error.message}`);
      }
    } finally {
      if (client) client.release();
    }
  }



  private async _handleAskAI(question: string, context: string) {
    const generation = this._sessionGeneration;
    if (!this._aiService) {
      this._aiService = new AiService();
    }
    this._panel.webview.postMessage({ command: 'aiLoading', loading: true });
    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const { readAiScopeSettings } = await import('../features/aiAssistant/aiConfig');
      const notebookSettings = readAiScopeSettings(config, 'notebook');
      const provider = notebookSettings.provider;

      // Refresh system prompt with latest stats context each turn
      const systemPrompt = this._buildDashboardSystemPrompt(context);

      // Pass conversation history so the AI has multi-turn context
      this._aiService.setMessages(this._conversationMessages);

      const result = await this._aiService.callProvider(provider, question, config, systemPrompt, 'notebook');

      if (!this._isSessionCurrent(generation)) {
        return;
      }

      // Persist this turn so follow-up questions have context
      this._conversationMessages.push({ role: 'user', content: question });
      this._conversationMessages.push({ role: 'assistant', content: result.text });
      // Cap history at 20 messages (10 turns) to avoid token bloat
      if (this._conversationMessages.length > 20) {
        this._conversationMessages = this._conversationMessages.slice(-20);
      }

      this._panel.webview.postMessage({ command: 'aiResponse', text: result.text });
    } catch (err: any) {
      if (this._isSessionCurrent(generation)) {
        this._panel.webview.postMessage({ command: 'aiResponse', text: `**Error:** ${err.message}` });
      }
    } finally {
      if (this._isSessionCurrent(generation)) {
        this._panel.webview.postMessage({ command: 'aiLoading', loading: false });
      }
    }
  }

  private async _executeQueryForAI(sql: string, question: string) {
    const generation = this._sessionGeneration;
    const trimmed = sql.trim();
    const sqlWithoutLeadingComments = trimmed
      .replace(/^\s*\/\*[\s\S]*?\*\//, '')
      .replace(/^\s*--.*(?:\r?\n|$)/gm, '')
      .trim();
    const upper = sqlWithoutLeadingComments.toUpperCase().replace(/\s+/g, ' ');
    const isReadOnly = /^(SELECT|WITH|EXPLAIN)\b/.test(upper);
    if (!isReadOnly) {
      this._panel.webview.postMessage({
        command: 'queryForAIResult',
        error: 'Only SELECT, WITH, or EXPLAIN queries are allowed.'
      });
      return;
    }
    let client;
    try {
      client = await this.getClient();
      await client.query('SET statement_timeout = 10000');
      const result = await client.query(trimmed);
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      const normalizedRows = result.rows
        .slice(0, 100)
        .map((row: Record<string, any>) => this._normalizeQueryRow(row));
      this._panel.webview.postMessage({
        command: 'queryForAIResult',
        sql: trimmed,
        question,
        columns: result.fields.map((f: any) => f.name),
        rows: normalizedRows,
        rowCount: result.rowCount ?? result.rows.length,
      });
    } catch (err: any) {
      if (this._isSessionCurrent(generation)) {
        this._panel.webview.postMessage({
          command: 'queryForAIResult',
          sql: trimmed,
          question,
          error: err.message,
        });
      }
    } finally {
      if (client) client.release();
    }
  }

  private _normalizeQueryRow(row: Record<string, any>): Record<string, any> {
    const normalized: Record<string, any> = {};
    for (const [key, value] of Object.entries(row || {})) {
      normalized[key] = this._normalizeQueryValue(value);
    }
    return normalized;
  }

  private _normalizeQueryValue(value: any): any {
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
      return value;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value)) {
      return value.map(v => this._normalizeQueryValue(v));
    }

    if (valueType === 'object') {
      const intervalText = this._formatIntervalLikeObject(value);
      if (intervalText) return intervalText;

      const toPostgres = (value as { toPostgres?: () => string }).toPostgres;
      if (typeof toPostgres === 'function') {
        try {
          return toPostgres.call(value);
        } catch {
          // Fall through to JSON serialization.
        }
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    return String(value);
  }

  private _formatIntervalLikeObject(value: any): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const keys = ['years', 'months', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'];
    const hasIntervalShape = keys.some(k => k in value);
    if (!hasIntervalShape) return null;

    const toNum = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const parts: string[] = [];
    const units: Array<{ key: string; label: string }> = [
      { key: 'years', label: 'year' },
      { key: 'months', label: 'month' },
      { key: 'days', label: 'day' },
      { key: 'hours', label: 'hour' },
      { key: 'minutes', label: 'minute' },
      { key: 'seconds', label: 'second' },
      { key: 'milliseconds', label: 'millisecond' }
    ];

    for (const unit of units) {
      const n = toNum(value[unit.key]);
      if (n === 0) continue;
      const abs = Math.abs(n);
      parts.push(`${n} ${unit.label}${abs === 1 ? '' : 's'}`);
    }

    return parts.length > 0 ? parts.join(' ') : '0 seconds';
  }

  private _buildDashboardSystemPrompt(contextSummary: string): string {
    return `# PostgreSQL DBA Dashboard Assistant

You are an expert PostgreSQL DBA assistant embedded in a live monitoring dashboard.
Your job is to help operators understand metrics, diagnose bottlenecks, and navigate performance issues step by step.

## Safety Rules (CRITICAL — Never Violate)
- ONLY generate SELECT, WITH (read-only CTEs), or EXPLAIN queries
- NEVER generate INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, or any DDL/DML
- Always add a LIMIT clause (max 100 rows) unless the user explicitly requests more
- If the user asks for a write operation, explain this is a read-only monitoring dashboard and suggest using the SQL notebook for write operations

## SQL Query Rules
- Always wrap SQL in \`\`\`sql fenced blocks so the UI can render the Run button
- Do NOT ask "shall I run this?" or "would you like me to execute?" — the UI handles approval automatically
- When query results arrive in the conversation, interpret them directly — do NOT ask to run another query
- Use parameterized-safe patterns, reference real pg_catalog / information_schema views
- NEVER repeat the same SQL query (or a trivial variant) already attempted in this thread unless the user explicitly asks to re-run it
- NEVER repeat the same follow-up question already asked in this thread
- If evidence is sufficient, stop generating SQL and provide a final investigation summary

## How to Investigate Systematically
1. Start with the current snapshot provided below — answer from it when sufficient
2. If you need deeper data, write one targeted diagnostic SQL query
3. When results return, synthesize and give a concrete actionable answer
4. Suggest the next logical investigation step

## Common Investigation Paths
- **Blocking locks**: check pg_locks + pg_stat_activity, identify blocking PID's query, suggest pg_cancel_backend vs pg_terminate_backend
- **Slow queries**: check pg_stat_activity for active long-running, correlate with pg_stat_statements for chronic offenders
- **High connections**: check pg_stat_activity by application_name and state, look for idle-in-transaction
- **Vacuum pressure**: check pg_stat_user_tables for n_dead_tup, autovacuum_count, last_autovacuum
- **Cache miss**: investigate pg_statio_user_tables for heap_blks_read vs heap_blks_hit by table
- **Seq scans**: investigate pg_stat_user_tables, suggest CREATE INDEX after checking column selectivity

## Current Database Snapshot
${contextSummary || '(No snapshot available — ask the user to refresh the dashboard)'}

## Response Format
- Lead with a direct 1–3 sentence answer or diagnosis
- Use bullet points only for lists of 3+ items
- For SQL queries: briefly state what it investigates before the code block
- Order recommendations by severity (critical → warning → advisory)
- Skip preamble — answer directly

## Investigation Closure (REQUIRED)
- At logical completion, provide a concise "Investigation summary" that explicitly states:
  1) Whether there is a major finding (yes/no)
  2) Whether anything suspicious was found on the current thread (yes/no)
  3) What was ruled out
- If nothing suspicious is found, explicitly say so and switch to the next likely problem area
- Only propose one next query at a time, and only if it explores a different diagnostic angle

## Follow-up Questions (CONDITIONAL)
- Provide 2–4 follow-up questions only when they are genuinely new and non-redundant
- Do not include follow-up questions when you already provided a final investigation summary unless user asks to continue

**Follow-up questions:**
1. [Question that builds on what was just discussed]
2. [Question from a different diagnostic angle]
3. [Deeper investigation question]

## Next Step Suggestion Bubbles (OPTIONAL)
If there are 2–3 clear next investigation actions, append this JSON at the very end of the response (no markdown wrapper, no code fence):
{"next_steps": ["Short action phrase", "Short action phrase", "Short action phrase"]}

Each phrase should be 3–6 words, max 40 characters. Only include if genuinely useful — omit entirely if no clear next steps.

IMPORTANT: When the user sends a bare number (1, 2, or 3), treat it as selecting that numbered follow-up question from the previous response and answer it directly.`;
  }

  private _buildContextSummary(stats: DashboardStats): string {
    const health = stats.blockingLocks.length > 0 ? 'Degraded (blocking locks)' :
      stats.waitingConnections > 0 ? 'Degraded (waiting sessions)' : 'OK';
    const sharedCacheHitRatio = stats.sharedCacheHitRatio != null
      ? `${stats.sharedCacheHitRatio.toFixed(1)}%`
      : 'n/a';
    const connPct = stats.maxConnections > 0
      ? ((stats.totalConnections / stats.maxConnections) * 100).toFixed(0)
      : '0';

    const lines = [
      `Database: ${stats.dbName} | Size: ${stats.size} | Owner: ${stats.owner}`,
      `Health: ${health}`,
      `Connections: ${stats.activeConnections} active / ${stats.idleConnections} idle / ${stats.waitingConnections} waiting / ${stats.maxConnections} max (${connPct}% capacity)`,
      `Blocking locks: ${stats.blockingLocks.length}`,
      `Long-running queries (>5s): ${stats.longRunningQueries}`,
      `Wait events: ${stats.waitEvents.map(w => `${w.type}=${w.count}`).join(', ') || 'none'}`,
      `Shared cache hit ratio: ${sharedCacheHitRatio}`,
      `Index block hit ratio: ${stats.indexHitRatio.toFixed(1)}%`,
      `Oldest transaction age: ${stats.oldestTransactionAgeSeconds}s`,
      `Tables needing vacuum: ${stats.tablesNeedingVacuum.length} (attention signal: ${stats.vacuumTablesNeedingAttention})`,
      `Unused indexes: ${stats.unusedIndexes.length}`,
      `Dead-tuple pressure tables: ${stats.tableBloat.length}`,
      `High sequential scan tables: ${stats.highSeqScanTables.length}`,
    ];

    // Specific blocking lock details
    if (stats.blockingLocks.length > 0) {
      const lockDetails = stats.blockingLocks.slice(0, 3).map(l =>
        `PID ${l.blocking_pid} (${l.blocking_user}) blocks PID ${l.blocked_pid} (${l.blocked_user}) on "${l.locked_object}" [${l.lock_mode}]` +
        (l.blocking_query ? ` — blocking query: ${l.blocking_query.substring(0, 80)}…` : '')
      );
      lines.push(`\nBlocking lock details:\n${lockDetails.map(d => `  - ${d}`).join('\n')}`);
    }

    // Active long-running queries
    const longRunning = stats.activeQueries.filter(q =>
      q.state === 'active' && q.duration && q.duration > '00:00:05'
    ).slice(0, 3);
    if (longRunning.length > 0) {
      const lrDetails = longRunning.map(q =>
        `PID ${q.pid} (${q.usename}): ${q.duration} — ${q.query.substring(0, 80)}…`
      );
      lines.push(`\nSample long-running queries:\n${lrDetails.map(d => `  - ${d}`).join('\n')}`);
    }

    // Top pg_stat_statements
    if (stats.pgStatStatements && stats.pgStatStatements.length > 0) {
      const topStatements = stats.pgStatStatements.slice(0, 3).map((s, i) =>
        `#${i + 1}: ${s.total_time.toFixed(0)}ms total, ${s.calls} calls, avg ${s.mean_time.toFixed(1)}ms — ${s.query.substring(0, 80)}…`
      );
      lines.push(`\nTop SQL by total time (pg_stat_statements):\n${topStatements.map(d => `  ${d}`).join('\n')}`);
    }

    // Schema health signals
    if (stats.unusedIndexes.length > 0) {
      const topUnused = stats.unusedIndexes.slice(0, 3).map(i =>
        `${i.index_name} on ${i.table_name} (${i.index_size})`
      );
      lines.push(`\nTop unused indexes: ${topUnused.join(', ')}`);
    }
    if (stats.highSeqScanTables.length > 0) {
      const topSeq = stats.highSeqScanTables.slice(0, 3).map(t =>
        `${t.table_name} (${t.seq_scan_pct.toFixed(0)}% seq scans, ${t.row_count.toLocaleString()} rows)`
      );
      lines.push(`Top high seq-scan tables: ${topSeq.join(', ')}`);
    }
    if (stats.tableBloat.length > 0) {
      const topBloat = stats.tableBloat.slice(0, 3).map(t =>
        `${t.table_name} (${t.bloat_pct.toFixed(0)}% dead tuples, ${t.n_dead_tup.toLocaleString()} dead)`
      );
      lines.push(`Top dead-tuple tables: ${topBloat.join(', ')}`);
    }
    if (stats.tablesNeedingVacuum.length > 0) {
      const topVacuum = stats.tablesNeedingVacuum.slice(0, 3).map(t =>
        `${t.table_name} (${t.n_dead_tup.toLocaleString()} dead, last autovacuum: ${t.last_autovacuum || 'never'})`
      );
      lines.push(`Tables most needing vacuum: ${topVacuum.join(', ')}`);
    }

    return lines.join('\n');
  }

  private _isHealthCritical(stats: DashboardStats): boolean {
    const hasSevereSchemaPressure =
      stats.tablesNeedingVacuum.length > 5 ||
      stats.tableBloat.some(t => t.bloat_pct >= 30) ||
      stats.highSeqScanTables.some(t => t.seq_scan_pct >= 95 && t.row_count >= 100000);

    return stats.blockingLocks.length > 0 ||
      stats.waitingConnections > 5 ||
      stats.longRunningQueries > 3 ||
      (stats.totalConnections / stats.maxConnections) > 0.9 ||
      hasSevereSchemaPressure;
  }

  private async _update() {
    const generation = this._sessionGeneration;
    let client;
    try {
      client = await this.getClient();
      const stats = await fetchStats(client as unknown as Client, this._dbName);
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      this._lastStats = stats;
      this._lastSuccessfulRefreshAt = Date.now();
      this._staleWarningShown = false;
      this._panel.webview.postMessage({ command: 'updateStats', stats });
      this._panel.webview.postMessage({
        command: 'dashboardFreshness',
        stale: false,
        lastSuccessfulRefreshAt: this._lastSuccessfulRefreshAt,
      });
      // First paint uses a script-free loading shell; replace it once stats are ready so scripts run and JSON bootstraps the UI.
      if (this._panel.webview.html.includes(DASHBOARD_LOADING_SHELL_MARKER)) {
        this._panel.webview.html = await getHtmlForWebview(this._panel.webview, this.extensionUri, stats);
      }
      // Auto-notify if enabled and health newly turned critical
      if (this._autoNotifyEnabled) {
        const nowCritical = this._isHealthCritical(stats);
        if (nowCritical && !this._lastHealthCritical) {
          await this._handleAskAI(
            'Database health has degraded. Explain what is happening and what I should do immediately.',
            this._buildContextSummary(stats)
          );
        }
        this._lastHealthCritical = nowCritical;
      }
    } catch (error: any) {
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      const staleMs =
        this._lastSuccessfulRefreshAt > 0 ? Date.now() - this._lastSuccessfulRefreshAt : 0;
      const stale =
        this._lastSuccessfulRefreshAt === 0 || staleMs >= 60_000;
      this._panel.webview.postMessage({
        command: 'dashboardFreshness',
        stale,
        staleMs,
        lastSuccessfulRefreshAt: this._lastSuccessfulRefreshAt || null,
      });
      if (stale && !this._staleWarningShown) {
        this._staleWarningShown = true;
        vscode.window.showWarningMessage(
          `Dashboard data may be stale for ${this._dbName}. Last successful refresh was ${
            this._lastSuccessfulRefreshAt
              ? `${Math.round(staleMs / 1000)}s ago`
              : 'never'
          }.`,
        );
      }
      // Only show error if we haven't loaded the UI yet, otherwise send error message
      if (this._panel.webview.html.includes(DASHBOARD_LOADING_SHELL_MARKER)) {
        this._panel.webview.html = getErrorHtml(error.message);
      } else {
        // Could send error toast to webview here
        console.error('Dashboard update failed:', error);
      }
    } finally {
      if (client) client.release();
    }
  }

  private async _downloadCsv(csv: string, filename: string) {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(filename),
      filters: { 'CSV Files': ['csv'], 'All Files': ['*'] }
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf-8'));
      vscode.window.showInformationMessage(`Saved: ${uri.fsPath}`);
    }
  }

  private async _showDetails(type: string) {
    const generation = this._sessionGeneration;
    let client;
    try {
      client = await this.getClient();
      if (!this._isSessionCurrent(generation)) {
        return;
      }
      let data: any[] = [];
      let columns: string[] = [];

      switch (type) {
        case 'tables':
          const res = await client.query(`
                        SELECT schemaname || '.' || tablename as name,
                               pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as size,
                               pg_total_relation_size(schemaname || '.' || tablename) as raw_size
                        FROM pg_tables
                        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                        ORDER BY raw_size DESC
                    `);
          data = res.rows;
          columns = ['Name', 'Size'];
          break;
        case 'views':
          const vRes = await client.query(`
                        SELECT schemaname || '.' || viewname as name,
                               viewowner as owner
                        FROM pg_views
                        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                        ORDER BY schemaname, viewname
                    `);
          data = vRes.rows;
          columns = ['Name', 'Owner'];
          break;
        case 'functions':
          const fRes = await client.query(`
                        SELECT n.nspname || '.' || p.proname as name,
                               l.lanname as language
                        FROM pg_proc p
                        JOIN pg_namespace n ON p.pronamespace = n.oid
                        JOIN pg_language l ON p.prolang = l.oid
                        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                        ORDER BY n.nspname, p.proname
                    `);
          data = fRes.rows;
          columns = ['Name', 'Language'];
          break;
        case 'pgStatStatements':
          const pgRes = await client.query(`
                        SELECT query, calls, total_time, mean_time, rows
                        FROM pg_stat_statements
                        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                        ORDER BY total_time DESC
                        LIMIT 50
                    `);
          data = pgRes.rows.map((r: any) => ({
            query: r.query,
            calls: r.calls,
            total_time: Number(r.total_time).toFixed(1),
            mean_time: Number(r.mean_time).toFixed(1),
            rows: r.rows
          }));
          columns = ['Query', 'Calls', 'Total Time (ms)', 'Mean Time (ms)', 'Rows'];
          break;
        // Add other cases as needed
      }

      if (this._isSessionCurrent(generation)) {
        this._panel.webview.postMessage({ command: 'showDetails', type, data, columns });
      }
    } catch (error: any) {
      if (this._isSessionCurrent(generation)) {
        console.error('Failed to fetch details:', error);
      }
    } finally {
      if (client) client.release();
    }
  }
}
