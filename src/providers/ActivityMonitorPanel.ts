import * as vscode from 'vscode';
import { SecretStorageService } from '../services/SecretStorageService';
import { ConnectionManager } from '../services/ConnectionManager';
import { MODERN_WEBVIEW_BASE_CSS } from '../common/htmlStyles';
import { disposePooledOwner, WebviewPool } from '../utils/WebviewPool';

/**
 * pg_activity Real-Time Monitor Panel (Phase 6.2)
 *
 * Opens a webview panel that polls pg_stat_activity every 2 seconds and
 * displays live query/session information. Users can filter by state,
 * toggle auto-refresh, and terminate backend processes.
 *
 * The polling loop runs entirely in the extension host so the webview
 * only needs to handle rendering; it never touches the database directly.
 */
export class ActivityMonitorPanel {
  public static readonly viewType = 'pgStudio.activityMonitor';

  /** One panel per connection+database combination */
  private static _panels = new Map<string, ActivityMonitorPanel>();

  public readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _pollTimer: NodeJS.Timeout | undefined;
  private _client: any;
  private _autoRefresh = true;
  private _isDisposed = false;

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
  }

  public dispose(isRecycling = false): void {
    this._isDisposed = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
    if (this._client) {
      try { this._client.release(); } catch { /* ignore */ }
      this._client = undefined;
    }
    if (!isRecycling) {
      this._panel.dispose();
    }
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  public static async open(
    connectionId: string,
    database: string,
    context: vscode.ExtensionContext
  ): Promise<void> {
    const panelKey = `activity:${connectionId}:${database}`;

    if (ActivityMonitorPanel._panels.has(panelKey)) {
      ActivityMonitorPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // Resolve connection details
    const connections =
      vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const connection = connections.find(c => c.id === connectionId);
    if (!connection) {
      vscode.window.showErrorMessage('Connection not found.');
      return;
    }

    const password = await SecretStorageService.getInstance().getPassword(connectionId);
    const connName = connection.name || `${connection.host}:${connection.port}`;

    // Acquire a pooled client (held for the lifetime of the panel)
    let client: any;
    try {
      client = await ConnectionManager.getInstance().getPooledClient({
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        database,
        name: connection.name,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Activity Monitor: failed to connect — ${err.message}`);
      return;
    }

    const { panel, commit } = WebviewPool.getInstance().getOrCreate(
      ActivityMonitorPanel.viewType,
      panelKey,
      `Activity: ${connName}/${database}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
      {
        onDispose: () => {
          disposePooledOwner(ActivityMonitorPanel._panels, panel, false);
        },
        onRecycle: (recycled) => {
          disposePooledOwner(ActivityMonitorPanel._panels, recycled.panel, true);
        },
      }
    );

    const instance = new ActivityMonitorPanel(panel);
    instance._client = client;
    ActivityMonitorPanel._panels.set(panelKey, instance);
    commit?.();

    panel.webview.html = ActivityMonitorPanel._buildHtml(connName, database);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'kill': {
          const pid: number = msg.pid;
          const confirm = await vscode.window.showWarningMessage(
            `Terminate backend process PID ${pid}?`,
            { modal: true },
            'Terminate'
          );
          if (confirm === 'Terminate') {
            try {
              await client.query('SELECT pg_terminate_backend($1)', [pid]);
              panel.webview.postMessage({ type: 'toast', message: `Process ${pid} terminated.` });
            } catch (err: any) {
              panel.webview.postMessage({ type: 'toast', message: `Failed to terminate ${pid}: ${err.message}`, isError: true });
            }
          }
          break;
        }
        case 'toggleAutoRefresh': {
          instance._autoRefresh = msg.enabled;
          break;
        }
        case 'refresh': {
          await instance._poll();
          break;
        }
      }
    }, null, instance._disposables);

    // Start polling loop (2 second interval)
    await instance._poll(); // Immediate first fetch
    instance._pollTimer = setInterval(async () => {
      if (instance._autoRefresh && !instance._isDisposed) {
        await instance._poll();
      }
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private readonly _SQL = `
SELECT
  pid,
  usename AS username,
  datname AS database,
  application_name,
  client_addr::text AS client_addr,
  state,
  wait_event_type,
  wait_event,
  EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_seconds,
  LEFT(query, 200) AS query,
  backend_type
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND pid != pg_backend_pid()
ORDER BY duration_seconds DESC NULLS LAST
`;

  private async _poll(): Promise<void> {
    if (!this._client || this._isDisposed) { return; }
    try {
      const res = await this._client.query(this._SQL);
      if (!this._isDisposed) {
        this._panel.webview.postMessage({ type: 'update', rows: res.rows });
      }
    } catch (err: any) {
      if (!this._isDisposed) {
        this._panel.webview.postMessage({ type: 'error', message: err.message });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTML builder
  // ---------------------------------------------------------------------------

  private static _buildHtml(connName: string, database: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Activity Monitor</title>
  <style>
    ${MODERN_WEBVIEW_BASE_CSS}
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Header */
    .header {
      padding: 10px 16px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .header h2 {
      margin: 0 0 2px 0;
      font-size: 1.05em;
      font-weight: 700;
    }
    .header-sub {
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
    }

    /* Control bar */
    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .refresh-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85em;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-charts-green, #4caf50);
      animation: pulse 2s infinite;
    }
    .dot.paused {
      background: var(--vscode-descriptionForeground);
      animation: none;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .btn {
      padding: 4px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.85em;
      font-family: var(--vscode-font-family);
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }

    select.filter-select {
      padding: 4px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 3px;
      font-size: 0.85em;
      font-family: var(--vscode-font-family);
    }

    .stat-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 0.8em;
      font-weight: 600;
    }

    /* Table area */
    .table-wrap {
      flex: 1;
      overflow: auto;
      padding: 0;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    colgroup col.pid     { width: 60px; }
    colgroup col.user    { width: 100px; }
    colgroup col.db      { width: 100px; }
    colgroup col.state   { width: 80px; }
    colgroup col.dur     { width: 80px; }
    colgroup col.wait    { width: 120px; }
    colgroup col.query   { width: auto; }
    colgroup col.action  { width: 48px; }

    thead {
      position: sticky;
      top: 0;
      z-index: 10;
    }
    th {
      background: var(--vscode-editorGroupHeader-tabsBackground);
      color: var(--vscode-foreground);
      padding: 6px 8px;
      text-align: left;
      font-weight: 600;
      font-size: 0.82em;
      border-bottom: 1px solid var(--vscode-panel-border);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      user-select: none;
    }
    th:hover { background: var(--vscode-list-hoverBackground); }

    td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      vertical-align: middle;
      font-size: 0.85em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* State-based row styling */
    tr.state-active    { border-left: 3px solid var(--vscode-charts-green, #4caf50); }
    tr.state-idle      { border-left: 3px solid transparent; }
    tr.state-waiting   { border-left: 3px solid var(--vscode-charts-orange, #ff9800); }
    tr.state-long      { border-left: 3px solid var(--vscode-charts-red, #f44336); }

    tr:hover td { background: var(--vscode-list-hoverBackground); }

    .state-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.8em;
      font-weight: 600;
    }
    .state-badge.active  { background: rgba(76, 175, 80, 0.2); color: var(--vscode-charts-green, #4caf50); }
    .state-badge.idle    { background: rgba(150, 150, 150, 0.15); color: var(--vscode-descriptionForeground); }
    .state-badge.waiting { background: rgba(255, 152, 0, 0.2); color: var(--vscode-charts-orange, #ff9800); }
    .state-badge.other   { background: rgba(100, 100, 255, 0.15); color: var(--vscode-charts-blue, #6c8ebf); }

    .kill-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1em;
      padding: 2px 4px;
      border-radius: 3px;
      opacity: 0.6;
      transition: opacity 0.15s;
    }
    .kill-btn:hover { opacity: 1; background: rgba(244, 67, 54, 0.15); }

    .query-cell {
      font-family: monospace;
      font-size: 0.82em;
      color: var(--vscode-editor-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty-state {
      text-align: center;
      padding: 32px 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }

    .error-banner {
      display: none;
      background: rgba(244, 67, 54, 0.1);
      border-left: 3px solid var(--vscode-charts-red, #f44336);
      color: var(--vscode-errorForeground, #f44336);
      padding: 8px 12px;
      margin: 8px 16px;
      border-radius: 3px;
      font-size: 0.85em;
    }
    .error-banner.show { display: block; }

    /* Toast notification */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--vscode-notificationCenterHeader-background, var(--vscode-sideBar-background));
      color: var(--vscode-notificationCenterHeader-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px 16px;
      font-size: 0.88em;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      z-index: 1000;
      max-width: 320px;
    }
    .toast.show { opacity: 1; }
    .toast.error { border-color: var(--vscode-charts-red, #f44336); color: var(--vscode-errorForeground, #f44336); }

    .last-updated {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>⚡ Activity Monitor</h2>
    <div class="header-sub">${escapeHtml(connName)} / <strong>${escapeHtml(database)}</strong></div>
  </div>

  <div class="controls">
    <div class="refresh-indicator">
      <div class="dot" id="refresh-dot"></div>
      <span id="refresh-label">Auto-refresh: ON</span>
    </div>
    <button class="btn btn-secondary" id="toggle-btn" onclick="toggleAutoRefresh()">Pause</button>
    <button class="btn btn-primary" onclick="manualRefresh()">↻ Refresh</button>
    <label style="font-size:0.85em;">Filter:</label>
    <select class="filter-select" id="state-filter" onchange="applyFilter()">
      <option value="all">All states</option>
      <option value="active">Active</option>
      <option value="idle">Idle</option>
      <option value="waiting">Waiting</option>
    </select>
    <span class="stat-badge" id="row-count">0 sessions</span>
    <span class="last-updated" id="last-updated"></span>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="table-wrap">
    <table>
      <colgroup>
        <col class="pid">
        <col class="user">
        <col class="db">
        <col class="state">
        <col class="dur">
        <col class="wait">
        <col class="query">
        <col class="action">
      </colgroup>
      <thead>
        <tr>
          <th title="Process ID">PID</th>
          <th title="Username">User</th>
          <th title="Database">Database</th>
          <th title="Connection state">State</th>
          <th title="Duration in seconds">Duration</th>
          <th title="Wait event">Wait Event</th>
          <th title="Current query (truncated to 80 chars)">Query</th>
          <th title="Actions"></th>
        </tr>
      </thead>
      <tbody id="activity-body">
        <tr>
          <td colspan="8" class="empty-state">Connecting…</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <script>
    const vscode = acquireVsCodeApi();

    let allRows = [];
    let currentFilter = 'all';
    let autoRefresh = true;

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function toggleAutoRefresh() {
      autoRefresh = !autoRefresh;
      const dot = document.getElementById('refresh-dot');
      const label = document.getElementById('refresh-label');
      const btn = document.getElementById('toggle-btn');

      dot.className = autoRefresh ? 'dot' : 'dot paused';
      label.textContent = autoRefresh ? 'Auto-refresh: ON' : 'Auto-refresh: OFF';
      btn.textContent = autoRefresh ? 'Pause' : 'Resume';

      vscode.postMessage({ type: 'toggleAutoRefresh', enabled: autoRefresh });
    }

    function manualRefresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function applyFilter() {
      currentFilter = document.getElementById('state-filter').value;
      renderRows(allRows);
    }

    function getRowClass(row) {
      const dur = parseInt(row.duration_seconds, 10) || 0;
      if (dur > 30) { return 'state-long'; }
      const state = (row.state || '').toLowerCase();
      if (state === 'active') { return 'state-active'; }
      if (state && state.includes('wait')) { return 'state-waiting'; }
      return 'state-idle';
    }

    function getStateBadge(state) {
      const s = (state || 'unknown').toLowerCase();
      if (s === 'active') { return '<span class="state-badge active">active</span>'; }
      if (s === 'idle') { return '<span class="state-badge idle">idle</span>'; }
      if (s.includes('wait')) { return '<span class="state-badge waiting">waiting</span>'; }
      return \`<span class="state-badge other">\${escapeHtml(s)}</span>\`;
    }

    function formatDuration(secs) {
      if (secs === null || secs === undefined || isNaN(secs)) { return '—'; }
      const s = parseInt(secs, 10);
      if (s < 60) { return s + 's'; }
      if (s < 3600) { return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    function truncate(str, max) {
      if (!str) { return ''; }
      str = str.replace(/\\s+/g, ' ').trim();
      return str.length > max ? str.slice(0, max) + '…' : str;
    }

    function matchesFilter(row) {
      if (currentFilter === 'all') { return true; }
      const state = (row.state || '').toLowerCase();
      if (currentFilter === 'active') { return state === 'active'; }
      if (currentFilter === 'idle') { return state === 'idle'; }
      if (currentFilter === 'waiting') { return state.includes('wait'); }
      return true;
    }

    function renderRows(rows) {
      const tbody = document.getElementById('activity-body');
      const filtered = rows.filter(matchesFilter);

      document.getElementById('row-count').textContent =
        filtered.length + ' session' + (filtered.length !== 1 ? 's' : '');

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No sessions match the current filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(row => {
        const rowClass = getRowClass(row);
        const waitEvent = row.wait_event_type && row.wait_event
          ? escapeHtml(row.wait_event_type + '/' + row.wait_event)
          : '—';
        const queryText = truncate(row.query || '', 80);
        const fullQuery = escapeHtml(row.query || '');

        return \`<tr class="\${rowClass}" title="App: \${escapeHtml(row.application_name || '')} | Client: \${escapeHtml(row.client_addr || 'local')}">
          <td>\${escapeHtml(String(row.pid))}</td>
          <td>\${escapeHtml(row.username || '—')}</td>
          <td>\${escapeHtml(row.database || '—')}</td>
          <td>\${getStateBadge(row.state)}</td>
          <td>\${formatDuration(row.duration_seconds)}</td>
          <td>\${waitEvent}</td>
          <td class="query-cell" title="\${fullQuery}">\${escapeHtml(queryText)}</td>
          <td style="text-align:center;">
            <button class="kill-btn" title="Terminate PID \${row.pid}" onclick="killProcess(\${row.pid})">🔴</button>
          </td>
        </tr>\`;
      }).join('');
    }

    function killProcess(pid) {
      vscode.postMessage({ type: 'kill', pid });
    }

    let toastTimer;
    function showToast(message, isError) {
      const el = document.getElementById('toast');
      el.textContent = message;
      el.className = 'toast show' + (isError ? ' error' : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.className = 'toast';
      }, 4000);
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'update': {
          allRows = msg.rows || [];
          renderRows(allRows);
          document.getElementById('last-updated').textContent =
            'Updated: ' + new Date().toLocaleTimeString();
          // Hide error banner on successful update
          document.getElementById('error-banner').className = 'error-banner';
          break;
        }
        case 'error': {
          const banner = document.getElementById('error-banner');
          banner.className = 'error-banner show';
          banner.textContent = 'Error: ' + msg.message;
          break;
        }
        case 'toast': {
          showToast(msg.message, msg.isError || false);
          break;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

/** HTML-escape helper (used at template build time in extension host) */
function escapeHtml(str: string): string {
  if (!str) { return ''; }
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
