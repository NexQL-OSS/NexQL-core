/**
 * Server Log Viewer Panel (Phase 6.3)
 *
 * Opens a webview panel that reads PostgreSQL server logs using pg_read_file.
 * Features:
 *   - Lists available log files from pg_ls_logdir()
 *   - Loads and displays the most recent log file (tail last 50KB)
 *   - Parses log lines and categorises by level (ERROR, WARNING, LOG, etc.)
 *   - Auto-refreshes every 5 seconds when "Tail" mode is on
 *   - Level filter pills, search box, and file selector
 */
import * as vscode from 'vscode';
import { ConnectionManager } from '../services/ConnectionManager';
import { SecretStorageService } from '../services/SecretStorageService';
import { MODERN_WEBVIEW_BASE_CSS } from '../common/htmlStyles';
import { disposePooledOwner, WebviewPool } from '../utils/WebviewPool';

export class ServerLogPanel {
  public static readonly viewType = 'pgStudio.serverLogViewer';

  /** Active panel instances keyed by "{connectionId}:{database}" */
  private static _panels = new Map<string, ServerLogPanel>();

  public readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  /** Interval handle for polling new log lines */
  private _pollInterval: NodeJS.Timeout | undefined;

  /** Current byte offset for incremental tail */
  private _byteOffset = 0;

  /** Currently loaded log file name */
  private _currentFile = '';

  /** Connection info cached for polling queries */
  private _connInfo: {
    id: string; host: string; port: number; username: string;
    database: string; name: string; password: string | undefined;
  } | undefined;

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Open (or reveal) the Server Log Viewer for the given connection / database.
   */
  public static async open(
    connectionId: string,
    database: string,
    context: vscode.ExtensionContext
  ): Promise<void> {
    const panelKey = `${connectionId}:${database}`;

    // Re-use an existing panel if one is already open for this connection+db
    if (ServerLogPanel._panels.has(panelKey)) {
      ServerLogPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // Resolve connection details
    const connections = vscode.workspace.getConfiguration()
      .get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find((c: any) => c.id === connectionId);
    if (!conn) {
      vscode.window.showErrorMessage(`Connection "${connectionId}" not found.`);
      return;
    }
    const password = await SecretStorageService.getInstance().getPassword(connectionId)
      ?? conn.password ?? undefined;

    const connInfo = {
      id: conn.id,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      database,
      name: conn.name,
      password,
    };

    // Check that the user has access to pg_read_file / pg_ls_logdir
    let logFiles: Array<{ name: string; size: number; modification: string }> = [];
    let initialContent = '';
    let initialFile = '';
    let accessError = '';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading PostgreSQL server logs…',
        cancellable: false,
      },
      async () => {
        let client: any;
        try {
          client = await ConnectionManager.getInstance().getPooledClient(connInfo);

          // Attempt to list log files
          const listResult = await client.query(
            `SELECT name, size, modification::text
             FROM pg_ls_logdir()
             ORDER BY modification DESC
             LIMIT 10`
          );
          logFiles = listResult.rows;

          if (logFiles.length > 0) {
            initialFile = logFiles[0].name;
            const fileSize: number = logFiles[0].size ?? 0;
            const startByte = Math.max(0, fileSize - 51200);

            // Load the tail of the most recent log file
            const contentResult = await client.query(
              `SELECT pg_read_file($1, $2, 51200) AS content`,
              [initialFile, startByte]
            );
            initialContent = contentResult.rows[0]?.content ?? '';
          }
        } catch (err: any) {
          const msg: string = err?.message ?? String(err);
          if (
            msg.toLowerCase().includes('superuser') ||
            msg.toLowerCase().includes('permission denied') ||
            msg.toLowerCase().includes('must be')
          ) {
            accessError =
              'pg_read_file requires superuser privileges. ' +
              'Connect as a superuser to view server logs.';
          } else {
            accessError = `Failed to read server logs: ${msg}`;
          }
        } finally {
          if (client?.release) { client.release(); }
        }
      }
    );

    const { panel, commit } = WebviewPool.getInstance().getOrCreate(
      ServerLogPanel.viewType,
      panelKey,
      `Server Logs: ${conn.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
      {
        onDispose: () => {
          disposePooledOwner(ServerLogPanel._panels, panel, false);
        },
        onRecycle: (recycled) => {
          disposePooledOwner(ServerLogPanel._panels, recycled.panel, true);
        },
      }
    );

    const instance = new ServerLogPanel(panel);
    instance._connInfo = connInfo;
    instance._currentFile = initialFile;
    // After loading the tail, the "offset" is the actual file size so we only
    // fetch new bytes on subsequent polls.
    instance._byteOffset = logFiles[0]?.size ?? 0;

    ServerLogPanel._panels.set(panelKey, instance);
    commit?.();

    // Build and set the initial HTML
    panel.webview.html = ServerLogPanel._buildHtml(
      conn.name,
      logFiles,
      initialFile,
      initialContent,
      accessError
    );

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (msg) => instance._handleMessage(msg),
      null,
      instance._disposables
    );

    // Start auto-polling if we have access and a file to tail
    if (!accessError && initialFile) {
      instance._startPolling();
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async _handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'loadFile':
        await this._loadFile(msg.fileName);
        break;
      case 'tailToggle':
        if (msg.enabled) {
          this._startPolling();
        } else {
          this._stopPolling();
        }
        break;
      case 'refresh':
        await this._pollNewLines();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // File loading
  // ---------------------------------------------------------------------------

  private async _loadFile(fileName: string): Promise<void> {
    if (!this._connInfo) { return; }
    let client: any;
    try {
      client = await ConnectionManager.getInstance().getPooledClient(this._connInfo);

      // Get file size
      const sizeResult = await client.query(
        `SELECT size FROM pg_ls_logdir() WHERE name = $1`,
        [fileName]
      );
      const fileSize: number = sizeResult.rows[0]?.size ?? 0;
      const startByte = Math.max(0, fileSize - 51200);

      const contentResult = await client.query(
        `SELECT pg_read_file($1, $2, 51200) AS content`,
        [fileName, startByte]
      );
      const content: string = contentResult.rows[0]?.content ?? '';

      this._currentFile = fileName;
      this._byteOffset = fileSize;

      this._panel.webview.postMessage({ type: 'loadContent', content, fileName });
    } catch (err: any) {
      this._panel.webview.postMessage({
        type: 'error',
        message: `Failed to load file: ${err?.message ?? err}`,
      });
    } finally {
      if (client?.release) { client.release(); }
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private _startPolling(): void {
    if (this._pollInterval) { return; }
    this._pollInterval = setInterval(() => this._pollNewLines(), 5000);
  }

  private _stopPolling(): void {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = undefined;
    }
  }

  private async _pollNewLines(): Promise<void> {
    if (!this._connInfo || !this._currentFile) { return; }
    let client: any;
    try {
      client = await ConnectionManager.getInstance().getPooledClient(this._connInfo);

      // Get current file size
      const sizeResult = await client.query(
        `SELECT size FROM pg_ls_logdir() WHERE name = $1`,
        [this._currentFile]
      );
      const currentSize: number = sizeResult.rows[0]?.size ?? 0;

      if (currentSize <= this._byteOffset) {
        // Nothing new
        return;
      }

      const readLength = currentSize - this._byteOffset;
      const contentResult = await client.query(
        `SELECT pg_read_file($1, $2, $3) AS content`,
        [this._currentFile, this._byteOffset, readLength]
      );
      const newContent: string = contentResult.rows[0]?.content ?? '';
      this._byteOffset = currentSize;

      if (newContent) {
        const lines = newContent.split('\n').filter((l: string) => l.trim().length > 0);
        this._panel.webview.postMessage({ type: 'appendLines', lines });
      }
    } catch {
      // Silently ignore polling errors to avoid spam
    } finally {
      if (client?.release) { client.release(); }
    }
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  public dispose(isRecycling = false): void {
    this._stopPolling();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
    if (!isRecycling) {
      this._panel.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // HTML generation
  // ---------------------------------------------------------------------------

  private static _buildHtml(
    connName: string,
    logFiles: Array<{ name: string; size: number; modification: string }>,
    selectedFile: string,
    initialContent: string,
    accessError: string
  ): string {
    const fileOptions = logFiles
      .map(
        (f) =>
          `<option value="${_esc(f.name)}" ${f.name === selectedFile ? 'selected' : ''}>` +
          `${_esc(f.name)} (${_formatBytes(f.size)}, ${_esc(f.modification)})</option>`
      )
      .join('\n');

    // Pre-process the initial content into lines for the log feed
    const initialLines = initialContent
      ? initialContent.split('\n').filter((l) => l.trim().length > 0)
      : [];
    const initialLinesJson = JSON.stringify(initialLines);

    const errorHtml = accessError
      ? `<div class="access-error">${_esc(accessError)}</div>`
      : '';

    const controlsHtml = accessError
      ? ''
      : /* html */ `
      <div class="controls">
        <select id="fileSelector" ${logFiles.length === 0 ? 'disabled' : ''}>
          ${fileOptions || '<option value="">No log files found</option>'}
        </select>
        <div class="filter-pills">
          <button class="pill active" data-level="ALL">ALL</button>
          <button class="pill" data-level="ERROR">ERROR</button>
          <button class="pill" data-level="WARNING">WARNING</button>
          <button class="pill" data-level="LOG">LOG</button>
          <button class="pill" data-level="INFO">INFO</button>
          <button class="pill" data-level="FATAL">FATAL</button>
          <button class="pill" data-level="HINT">HINT</button>
          <button class="pill" data-level="DETAIL">DETAIL</button>
        </div>
        <input type="text" id="searchInput" placeholder="Search logs…" />
        <label class="tail-toggle">
          <input type="checkbox" id="tailToggle" checked />
          <span>Tail</span>
        </label>
        <button id="clearBtn">Clear</button>
      </div>`;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server Log Viewer</title>
  <style>
    ${MODERN_WEBVIEW_BASE_CSS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    .header {
      padding: 8px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-sideBarTitle-foreground);
      flex-shrink: 0;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    select, input[type="text"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 12px;
      font-family: inherit;
    }

    select { max-width: 260px; }
    input[type="text"] { flex: 1; min-width: 120px; }

    .filter-pills { display: flex; flex-wrap: wrap; gap: 4px; }

    .pill {
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
    }
    .pill.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .pill:hover { opacity: 0.85; }

    .tail-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }

    button#clearBtn {
      padding: 3px 10px;
      border-radius: 3px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }
    button#clearBtn:hover { opacity: 0.85; }

    #logFeed {
      flex: 1;
      overflow-y: auto;
      padding: 6px 10px;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .log-line { display: block; }
    .log-line.hidden { display: none; }

    .level-error, .level-fatal, .level-panic {
      color: var(--vscode-errorForeground, #f48771);
    }
    .level-warning {
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .level-hint, .level-detail {
      color: var(--vscode-descriptionForeground, #8a8a8a);
    }

    .highlight {
      background-color: #ffff00;
      color: #000;
      border-radius: 2px;
    }

    .access-error {
      margin: 20px;
      padding: 12px 16px;
      background: rgba(244, 135, 113, 0.12);
      border-left: 4px solid var(--vscode-errorForeground, #f48771);
      border-radius: 3px;
      font-size: 13px;
      line-height: 1.5;
    }

    #statusBar {
      padding: 2px 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-statusBar-background, transparent);
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="header">&#128203; Server Log Viewer &mdash; ${_esc(connName)}</div>
  ${errorHtml}
  ${controlsHtml}
  <div id="logFeed"></div>
  ${accessError ? '' : '<div id="statusBar">Initialising…</div>'}

  <script>
    (function () {
      const vscode = acquireVsCodeApi();

      // ── State ──────────────────────────────────────────────────────────────
      let activeLevel = 'ALL';
      let searchText = '';
      let allLines = [];          // raw string lines
      let renderedLines = [];     // DOM span elements (same indices as allLines)

      // ── DOM refs ───────────────────────────────────────────────────────────
      const feed      = document.getElementById('logFeed');
      const status    = document.getElementById('statusBar');
      const fileSelector = document.getElementById('fileSelector');
      const searchInput  = document.getElementById('searchInput');
      const tailToggle   = document.getElementById('tailToggle');
      const clearBtn     = document.getElementById('clearBtn');
      const pills        = document.querySelectorAll('.pill');

      // ── Helpers ────────────────────────────────────────────────────────────

      function escHtml(str) {
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function detectLevel(line) {
        const upper = line.toUpperCase();
        if (upper.includes(' PANIC:') || upper.includes('[PANIC]'))   { return 'panic'; }
        if (upper.includes(' FATAL:') || upper.includes('[FATAL]'))   { return 'fatal'; }
        if (upper.includes(' ERROR:') || upper.includes('[ERROR]'))   { return 'error'; }
        if (upper.includes(' WARNING:') || upper.includes('[WARNING]')){ return 'warning'; }
        if (upper.includes(' HINT:') || upper.includes('[HINT]'))     { return 'hint'; }
        if (upper.includes(' DETAIL:') || upper.includes('[DETAIL]')) { return 'detail'; }
        if (upper.includes(' INFO:') || upper.includes('[INFO]'))     { return 'info'; }
        return 'log';
      }

      function lineMatchesFilter(level) {
        if (activeLevel === 'ALL') { return true; }
        const lvl = activeLevel.toLowerCase();
        if (lvl === 'error') { return level === 'error' || level === 'fatal' || level === 'panic'; }
        if (lvl === 'warning') { return level === 'warning'; }
        if (lvl === 'log')   { return level === 'log'; }
        if (lvl === 'info')  { return level === 'info'; }
        if (lvl === 'fatal') { return level === 'fatal' || level === 'panic'; }
        if (lvl === 'hint')  { return level === 'hint'; }
        if (lvl === 'detail'){ return level === 'detail'; }
        return true;
      }

      function highlightText(escaped, query) {
        if (!query) { return escaped; }
        // Escape regex special characters
        const specChars = {'.': 1, '*': 1, '+': 1, '?': 1, '^': 1, '$': 1, '{': 1, '}': 1, '(': 1, ')': 1, '|': 1, '[': 1, ']': 1, '\\': 1};
        const safeQuery = query
          .split('')
          .map(c => specChars[c] ? '\\' + c : c)
          .join('');
        const parts = escaped.split(new RegExp('(' + safeQuery + ')', 'gi'));
        return parts.map((p, i) => i % 2 === 1 ? '<span class="highlight">' + p + '</span>' : p).join('');
      }

      function renderLineHtml(line) {
        const level = detectLevel(line);
        const escaped = escHtml(line);
        return highlightText(escaped, searchText ? escHtml(searchText) : '');
      }

      function buildSpan(line) {
        const level = detectLevel(line);
        const span = document.createElement('span');
        span.className = 'log-line level-' + level;
        span.dataset.level = level;
        span.innerHTML = renderLineHtml(line) + '\\n';
        return span;
      }

      function applyVisibility() {
        const query = searchText.toLowerCase();
        for (let i = 0; i < allLines.length; i++) {
          const line  = allLines[i];
          const el    = renderedLines[i];
          const level = el.dataset.level;
          const matchesLevel  = lineMatchesFilter(level);
          const matchesSearch = !query || line.toLowerCase().includes(query);
          el.classList.toggle('hidden', !(matchesLevel && matchesSearch));
          // Re-render HTML to update highlight
          el.innerHTML = renderLineHtml(line) + '\\n';
        }
      }

      function appendLines(lines) {
        const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
        const query = searchText.toLowerCase();
        for (const line of lines) {
          const level = detectLevel(line);
          const matchesLevel  = lineMatchesFilter(level);
          const matchesSearch = !query || line.toLowerCase().includes(query);
          const span = buildSpan(line);
          if (!(matchesLevel && matchesSearch)) { span.classList.add('hidden'); }
          feed.appendChild(span);
          allLines.push(line);
          renderedLines.push(span);
        }
        if (wasAtBottom && tailToggle && tailToggle.checked) {
          feed.scrollTop = feed.scrollHeight;
        }
        updateStatus();
      }

      function clearFeed() {
        feed.innerHTML = '';
        allLines = [];
        renderedLines = [];
        updateStatus();
      }

      function updateStatus() {
        if (!status) { return; }
        const visible = renderedLines.filter(el => !el.classList.contains('hidden')).length;
        const tail = tailToggle && tailToggle.checked ? '  |  Tail: ON' : '  |  Tail: OFF';
        status.textContent = visible + ' / ' + allLines.length + ' lines' + tail;
      }

      // ── Event wiring ───────────────────────────────────────────────────────

      if (fileSelector) {
        fileSelector.addEventListener('change', () => {
          clearFeed();
          vscode.postMessage({ type: 'loadFile', fileName: fileSelector.value });
        });
      }

      if (searchInput) {
        searchInput.addEventListener('input', () => {
          searchText = searchInput.value;
          applyVisibility();
        });
      }

      if (tailToggle) {
        tailToggle.addEventListener('change', () => {
          vscode.postMessage({ type: 'tailToggle', enabled: tailToggle.checked });
          updateStatus();
          if (tailToggle.checked) {
            feed.scrollTop = feed.scrollHeight;
          }
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', clearFeed);
      }

      pills.forEach(pill => {
        pill.addEventListener('click', () => {
          pills.forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          activeLevel = pill.dataset.level;
          applyVisibility();
        });
      });

      // ── Message listener ──────────────────────────────────────────────────

      window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
          case 'appendLines':
            appendLines(msg.lines);
            break;
          case 'loadContent':
            clearFeed();
            appendLines(msg.content.split('\\n').filter(l => l.trim().length > 0));
            feed.scrollTop = feed.scrollHeight;
            break;
          case 'error':
            if (status) { status.textContent = 'Error: ' + msg.message; }
            break;
        }
      });

      // ── Seed with initial content ─────────────────────────────────────────

      const initialLines = ${initialLinesJson};
      if (initialLines.length > 0) {
        appendLines(initialLines);
        feed.scrollTop = feed.scrollHeight;
      }
      updateStatus();

    }());
  </script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Private helpers (module-level)
// ---------------------------------------------------------------------------

function _esc(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) { return '0 B'; }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i];
}
