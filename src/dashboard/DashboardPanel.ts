import { Client, PoolClient } from 'pg';
import * as vscode from 'vscode';
import { fetchStats, DashboardStats } from './DashboardData';
import { getErrorHtml, getHtmlForWebview, getLoadingHtml } from './DashboardHtml';
import { ConnectionManager } from '../services/ConnectionManager';
import { ConnectionConfig } from '../common/types';
import { createMetadata, createAndShowNotebook } from '../commands/connection';
import { AiService } from '../providers/chat/AiService';

export class DashboardPanel {
  private static panels: Map<string, DashboardPanel> = new Map();
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _panelKey: string;
  private _aiService: AiService | null = null;
  private _lastStats: DashboardStats | null = null;
  private _autoNotifyEnabled = false;
  private _lastHealthCritical = false;

  private constructor(panel: vscode.WebviewPanel, private readonly config: ConnectionConfig, private readonly dbName: string, panelKey: string, private readonly extensionUri: vscode.Uri) {
    this._panel = panel;
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
            const metadata = createMetadata(this.config, this.dbName);
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

  public static async show(extensionUri: vscode.Uri, config: ConnectionConfig, dbName: string, connectionId?: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // Create unique key for this dashboard (connection + database)
    // Use timestamp to allow multiple dashboards for the same database
    const timestamp = Date.now();
    const panelKey = `${connectionId || 'default'}-${dbName}-${timestamp}`;

    // Always create a new panel to allow multiple dashboards
    const panel = vscode.window.createWebviewPanel(
      'postgresDashboard',
      `Dashboard: ${dbName}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const dashboardPanel = new DashboardPanel(panel, config, dbName, panelKey, extensionUri);
    DashboardPanel.panels.set(panelKey, dashboardPanel);
  }

  public dispose() {
    DashboardPanel.panels.delete(this._panelKey);
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private async getClient(): Promise<PoolClient> {
    return await ConnectionManager.getInstance().getPooledClient(this.config);
  }

  private async _terminateQuery(pid: number) {
    let client;
    try {
      client = await this.getClient();
      await client.query('SELECT pg_terminate_backend($1)', [pid]);
      vscode.window.showInformationMessage(`Terminated query with PID ${pid}`);
      this._update();
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to terminate query: ${error.message}`);
    } finally {
      if (client) client.release();
    }
  }

  private async _cancelQuery(pid: number) {
    let client;
    try {
      client = await this.getClient();
      await client.query('SELECT pg_cancel_backend($1)', [pid]);
      vscode.window.showInformationMessage(`Cancelled query with PID ${pid}`);
      this._update();
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to cancel query: ${error.message}`);
    } finally {
      if (client) client.release();
    }
  }



  private async _handleAskAI(question: string, context: string) {
    if (!this._aiService) {
      this._aiService = new AiService();
    }
    this._panel.webview.postMessage({ command: 'aiLoading', loading: true });
    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const provider = config.get<string>('aiProvider') ?? 'vscode-lm';
      const systemPrompt = this._buildDashboardSystemPrompt(context);
      let result: { text: string };
      if (provider === 'vscode-lm') {
        result = await this._aiService.callVsCodeLm(question, config, systemPrompt);
      } else {
        result = await this._aiService.callDirectApi(provider, question, config, systemPrompt);
      }
      this._panel.webview.postMessage({ command: 'aiResponse', text: result.text });
    } catch (err: any) {
      this._panel.webview.postMessage({ command: 'aiResponse', text: `**Error:** ${err.message}` });
    } finally {
      this._panel.webview.postMessage({ command: 'aiLoading', loading: false });
    }
  }

  private async _executeQueryForAI(sql: string, question: string) {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase().replace(/\s+/g, ' ');
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
      this._panel.webview.postMessage({
        command: 'queryForAIResult',
        sql: trimmed,
        question,
        columns: result.fields.map((f: any) => f.name),
        rows: result.rows.slice(0, 100),
        rowCount: result.rowCount ?? result.rows.length,
      });
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'queryForAIResult',
        sql: trimmed,
        question,
        error: err.message,
      });
    } finally {
      if (client) client.release();
    }
  }

  private _buildDashboardSystemPrompt(contextSummary: string): string {
    return `You are an expert PostgreSQL DBA assistant embedded in a live monitoring dashboard.

${contextSummary ? `## Current Database State\n${contextSummary}\n` : ''}

## Your Role
- Answer questions about database health, performance, locks, and schema directly and concisely
- When you need live data, write a SELECT query in a \`\`\`sql block — the UI will present it to the user for approval and execution, then return the results to you automatically
- When query results are provided in the message, interpret them directly and answer the original question — do NOT ask to run another query
- Keep answers short and to the point

## Rules for SQL Generation
- ONLY write SELECT, WITH (read-only CTE), or EXPLAIN queries — NEVER INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, or TRUNCATE
- Always wrap SQL in \`\`\`sql fenced code blocks
- Always add a LIMIT clause (max 100 rows unless the user asks for more)
- Do NOT ask "shall I run this?" or "would you like me to execute?" — the UI handles that automatically
- Do NOT invent or assume data values — query for them

## Response Format
- Answer in plain sentences — no bullet points for simple answers
- Use bullets only for lists of 3+ items
- Skip preamble — answer directly`;
  }

  private _buildContextSummary(stats: DashboardStats): string {
    const health = stats.blockingLocks.length > 0 ? 'Degraded (blocking locks)' :
      stats.waitingConnections > 0 ? 'Degraded (waiting sessions)' : 'OK';
    const lines = [
      `Database: ${stats.dbName} | Size: ${stats.size} | Owner: ${stats.owner}`,
      `Health: ${health}`,
      `Connections: ${stats.activeConnections} active / ${stats.idleConnections} idle / ${stats.waitingConnections} waiting / ${stats.maxConnections} max`,
      `Blocking locks: ${stats.blockingLocks.length}`,
      `Long-running queries (>5s): ${stats.longRunningQueries}`,
      `Wait events: ${stats.waitEvents.map(w => `${w.type}=${w.count}`).join(', ') || 'none'}`,
      `Index hit ratio: ${stats.indexHitRatio.toFixed(1)}%`,
      `Oldest transaction age: ${stats.oldestTransactionAgeSeconds}s`,
      `Tables needing vacuum attention: ${stats.vacuumTablesNeedingAttention}`,
      `Unused indexes: ${stats.unusedIndexes.length}`,
      `Bloated tables (>1000 dead tuples): ${stats.tableBloat.length}`,
      `Tables needing vacuum: ${stats.tablesNeedingVacuum.length}`,
    ];
    if (stats.blockingLocks.length > 0) {
      lines.push(`Blocking lock details: ${stats.blockingLocks.slice(0, 3).map(l =>
        `PID ${l.blocking_pid} blocks PID ${l.blocked_pid} on ${l.locked_object} (${l.lock_mode})`
      ).join('; ')}`);
    }
    if (stats.pgStatStatements && stats.pgStatStatements.length > 0) {
      const top = stats.pgStatStatements[0];
      lines.push(`Top SQL by total time: ${top.total_time.toFixed(0)}ms total, ${top.calls} calls, avg ${top.mean_time.toFixed(1)}ms`);
    }
    return lines.join('\n');
  }

  private _isHealthCritical(stats: DashboardStats): boolean {
    return stats.blockingLocks.length > 0 ||
      stats.waitingConnections > 5 ||
      stats.longRunningQueries > 3 ||
      (stats.totalConnections / stats.maxConnections) > 0.9;
  }

  private async _update() {
    let client;
    try {
      client = await this.getClient();
      const stats = await fetchStats(client as unknown as Client, this.dbName);
      this._lastStats = stats;
      this._panel.webview.postMessage({ command: 'updateStats', stats });
      // If it's the first load, set the HTML
      if (this._panel.webview.html.includes('Loading Dashboard...')) {
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
      // Only show error if we haven't loaded the UI yet, otherwise send error message
      if (this._panel.webview.html.includes('Loading Dashboard...')) {
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
    let client;
    try {
      client = await this.getClient();
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

      this._panel.webview.postMessage({ command: 'showDetails', type, data, columns });
    } catch (error: any) {
      console.error('Failed to fetch details:', error);
    } finally {
      if (client) client.release();
    }
  }
}
