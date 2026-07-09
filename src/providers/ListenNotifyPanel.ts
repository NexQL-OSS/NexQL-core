import * as vscode from 'vscode';
import { Client } from 'pg';
import { SecretStorageService } from '../services/SecretStorageService';
import { MODERN_WEBVIEW_BASE_CSS } from '../common/htmlStyles';
import { disposePooledOwner, WebviewPool } from '../utils/WebviewPool';

/** A single received NOTIFY notification. */
interface PgNotification {
  channel: string;
  payload: string;
  receivedAt: Date;
}

/**
 * LISTEN / NOTIFY Monitor Panel (Phase 5.3)
 *
 * Opens a persistent webview panel that maintains a **dedicated, non-pooled**
 * pg.Client for receiving PostgreSQL LISTEN notifications in real-time.
 *
 * Features:
 *   - Subscribe / unsubscribe to channels at runtime
 *   - Send ad-hoc NOTIFY via pg_notify()
 *   - Live notification feed (newest-first, max 500 entries)
 *   - VS Code theme-aware HTML (dark / light compatible)
 *
 * One panel exists per (connectionId + database) pair.
 */
export class ListenNotifyPanel {
  public static readonly viewType = 'pgStudio.listenNotify';
  private static readonly MAX_FEED_ENTRIES = 500;
  private static readonly POLL_INTERVAL_MS = 500;

  // One panel instance per connection:database
  private static _panels = new Map<string, ListenNotifyPanel>();

  public readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  /** The dedicated (non-pooled) pg client for LISTEN. */
  private _pgClient: Client | null;
  /** Stable listener refs so removeListener matches addListener on this instance. */
  private _pgListenerRefs: {
    notification: (msg: { channel: string; payload?: string | null }) => void;
    error: (err: Error) => void;
    end: () => void;
  } | null = null;
  /** Connected flag – updated by pg client events. */
  private _connected = false;
  /** Channels currently LISTENed on. */
  private _channels = new Set<string>();
  /** Buffer of pending notifications not yet forwarded to the webview. */
  private _pendingNotifications: PgNotification[] = [];
  /** setInterval handle for the poll-and-forward loop. */
  private _pollTimer: NodeJS.Timeout | null = null;

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._pgClient = null;

    // Forward buffered notifications to the webview every 500 ms
    this._pollTimer = setInterval(() => this._flushNotifications(), ListenNotifyPanel.POLL_INTERVAL_MS);
  }

  public dispose(isRecycling = false): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    this._detachPgClient();

    this._channels.clear();
    this._pendingNotifications = [];
    this._connected = false;

    const key = [...ListenNotifyPanel._panels.entries()]
      .find(([, v]) => v === this)?.[0];
    if (key) { ListenNotifyPanel._panels.delete(key); }

    if (!isRecycling) {
      this._panel.dispose();
    }
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }

  /** Remove pg client listeners before end(); safe to call multiple times. */
  private _detachPgClient(): void {
    const client = this._pgClient;
    if (!client) {
      return;
    }
    this._pgClient = null;
    const refs = this._pgListenerRefs;
    this._pgListenerRefs = null;
    if (refs) {
      client.removeListener('notification', refs.notification);
      client.removeListener('error', refs.error);
      client.removeListener('end', refs.end);
    }
    try {
      client.end().catch(() => { /* ignore errors on cleanup */ });
    } catch {
      // ignore
    }
  }

  private _attachPgClient(client: Client): void {
    this._detachPgClient();
    const notification = (msg: { channel: string; payload?: string | null }) => {
      const note: PgNotification = {
        channel: msg.channel,
        payload: msg.payload ?? '',
        receivedAt: new Date(),
      };
      this._pendingNotifications.push(note);
      if (this._pendingNotifications.length > ListenNotifyPanel.MAX_FEED_ENTRIES) {
        this._pendingNotifications.splice(
          0,
          this._pendingNotifications.length - ListenNotifyPanel.MAX_FEED_ENTRIES,
        );
      }
    };
    const error = (err: Error) => {
      this._connected = false;
      try {
        this._panel.webview.postMessage({ type: 'status', connected: false, error: err.message });
      } catch {
        // panel disposed
      }
    };
    const end = () => {
      this._connected = false;
      try {
        this._panel.webview.postMessage({ type: 'status', connected: false });
      } catch {
        // panel disposed
      }
    };
    this._pgListenerRefs = { notification, error, end };
    this._pgClient = client;
    client.on('notification', notification);
    client.on('error', error);
    client.on('end', end);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Push buffered notifications to the webview in a single postMessage call. */
  private _flushNotifications(): void {
    if (this._pendingNotifications.length === 0) { return; }
    if (!this._panel.visible) { return; }

    const toSend = this._pendingNotifications.splice(0);
    try {
      this._panel.webview.postMessage({ type: 'notifications', notifications: toSend });
    } catch {
      // panel may have been disposed
    }
  }

  private async _handleSubscribe(channel: string): Promise<void> {
    if (!channel || this._channels.has(channel) || !this._pgClient) { return; }
    try {
      await this._pgClient.query(`LISTEN ${this._pgClient.escapeIdentifier(channel)}`);
      this._channels.add(channel);
      this._panel.webview.postMessage({ type: 'channels', channels: [...this._channels] });
    } catch (err: any) {
      this._panel.webview.postMessage({ type: 'error', message: `LISTEN failed: ${err.message}` });
    }
  }

  private async _handleUnsubscribe(channel: string): Promise<void> {
    if (!channel || !this._channels.has(channel) || !this._pgClient) { return; }
    try {
      await this._pgClient.query(`UNLISTEN ${this._pgClient.escapeIdentifier(channel)}`);
      this._channels.delete(channel);
      this._panel.webview.postMessage({ type: 'channels', channels: [...this._channels] });
    } catch (err: any) {
      this._panel.webview.postMessage({ type: 'error', message: `UNLISTEN failed: ${err.message}` });
    }
  }

  private async _handleNotify(channel: string, payload: string): Promise<void> {
    if (!channel || !this._pgClient) { return; }
    try {
      await this._pgClient.query('SELECT pg_notify($1, $2)', [channel, payload ?? '']);
      this._panel.webview.postMessage({ type: 'notifySent', channel, payload });
    } catch (err: any) {
      this._panel.webview.postMessage({ type: 'error', message: `pg_notify failed: ${err.message}` });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public static async open(
    connectionId: string,
    database: string,
    context: vscode.ExtensionContext
  ): Promise<void> {
    const panelKey = `listennotify:${connectionId}:${database}`;

    // Reveal existing panel if already open
    if (ListenNotifyPanel._panels.has(panelKey)) {
      ListenNotifyPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    // Resolve connection config
    const connections = vscode.workspace.getConfiguration()
      .get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) {
      vscode.window.showErrorMessage('LISTEN/NOTIFY Monitor: connection not found.');
      return;
    }

    const password = await SecretStorageService.getInstance().getPassword(connectionId);

    // Build a dedicated (non-pooled) pg.Client
    const clientConfig: any = {
      host: conn.host,
      port: conn.port ?? 5432,
      user: conn.username,
      password: password ?? undefined,
      database,
      // Minimal keepalive / idle settings
      application_name: 'NexQL-ListenNotify',
    };

    // Handle SSL if configured on the saved connection
    if (conn.ssl) {
      clientConfig.ssl = conn.ssl;
    }

    const pgClient = new Client(clientConfig);

    // Connect the dedicated client
    try {
      await pgClient.connect();
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `LISTEN/NOTIFY Monitor: could not connect – ${err.message}`
      );
      return;
    }

    // Create the webview panel
    const connLabel = conn.name || `${conn.host}:${conn.port ?? 5432}`;

    const { panel, commit } = WebviewPool.getInstance().getOrCreate(
      ListenNotifyPanel.viewType,
      panelKey,
      `LISTEN/NOTIFY – ${connLabel}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
      {
        onDispose: () => {
          disposePooledOwner(ListenNotifyPanel._panels, panel, false);
        },
        onRecycle: (recycled) => {
          disposePooledOwner(ListenNotifyPanel._panels, recycled.panel, true);
        },
      }
    );

    const lnPanel = new ListenNotifyPanel(panel);
    lnPanel._connected = true;
    ListenNotifyPanel._panels.set(panelKey, lnPanel);
    commit?.();

    // Render initial HTML
    panel.webview.html = ListenNotifyPanel._buildHtml(connLabel, database);

    // Send initial state to webview once it is ready
    // (the webview will request state via 'ready' message)
    panel.webview.postMessage({ type: 'status', connected: true });

    lnPanel._attachPgClient(pgClient);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.type) {
          case 'ready':
            panel.webview.postMessage({ type: 'status', connected: lnPanel._connected });
            panel.webview.postMessage({ type: 'channels', channels: [...lnPanel._channels] });
            break;
          case 'subscribe':
            await lnPanel._handleSubscribe(msg.channel);
            break;
          case 'unsubscribe':
            await lnPanel._handleUnsubscribe(msg.channel);
            break;
          case 'notify':
            await lnPanel._handleNotify(msg.channel, msg.payload ?? '');
            break;
          case 'clear':
            panel.webview.postMessage({ type: 'clearFeed' });
            break;
        }
      },
      null,
      lnPanel._disposables
    );
  }

  // ---------------------------------------------------------------------------
  // HTML builder
  // ---------------------------------------------------------------------------

  private static _buildHtml(connLabel: string, database: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>LISTEN / NOTIFY Monitor</title>
<style>
  ${MODERN_WEBVIEW_BASE_CSS}
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-widget-border, #444);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #cccccc);
    --input-border: var(--vscode-input-border, #555);
    --btn-bg: var(--vscode-button-background, #0078d4);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #106ebe);
    --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn-secondary-fg: var(--vscode-button-secondaryForeground, #cccccc);
    --btn-secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
    --header-bg: var(--vscode-sideBarSectionHeader-background, #252526);
    --section-bg: var(--vscode-sideBar-background, #1e1e1e);
    --row-alt: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    --accent: var(--vscode-focusBorder, #0078d4);
    --error-fg: var(--vscode-inputValidation-errorForeground, #f48771);
    --font: var(--vscode-font-family, system-ui, sans-serif);
    --mono: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-font-size, 13px);
  }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font);
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ---- Top header ---- */
  .top-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .top-header h1 {
    margin: 0;
    font-size: 1.05em;
    font-weight: 600;
  }

  .top-header .conn-meta {
    font-size: 0.85em;
    font-family: var(--mono);
    opacity: 0.75;
    margin-top: 2px;
  }

  .status-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
    background: #6e6e6e;
    vertical-align: middle;
    transition: background 0.3s;
  }

  .status-dot.connected { background: #4caf50; }
  .status-dot.disconnected { background: #f44336; }

  .status-label {
    font-size: 0.85em;
    font-weight: 500;
    vertical-align: middle;
  }

  /* ---- Main layout ---- */
  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* ---- Left sidebar ---- */
  .sidebar {
    width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    background: var(--section-bg);
  }

  .sidebar-section {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }

  .sidebar-section h2 {
    margin: 0 0 8px;
    font-size: 0.78em;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    opacity: 0.65;
    font-weight: 600;
  }

  .channel-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .channel-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    border-radius: 4px;
    background: var(--row-alt);
    font-family: var(--mono);
    font-size: 0.85em;
  }

  .channel-item .channel-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .channel-item .unsub-btn {
    background: none;
    border: none;
    color: var(--error-fg);
    cursor: pointer;
    padding: 0 2px;
    font-size: 0.95em;
    line-height: 1;
    flex-shrink: 0;
    opacity: 0.8;
    transition: opacity 0.15s;
  }

  .channel-item .unsub-btn:hover { opacity: 1; }

  .no-channels-msg {
    font-size: 0.85em;
    opacity: 0.55;
    font-style: italic;
  }

  /* ---- Form elements ---- */
  .form-row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }

  .form-row:last-child { margin-bottom: 0; }

  input[type="text"] {
    flex: 1;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 3px;
    padding: 5px 8px;
    font-family: var(--mono);
    font-size: 0.88em;
    outline: none;
    min-width: 0;
  }

  input[type="text"]:focus {
    border-color: var(--accent);
  }

  button.primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: 3px;
    padding: 5px 12px;
    cursor: pointer;
    font-size: 0.88em;
    white-space: nowrap;
    transition: background 0.15s;
  }

  button.primary:hover { background: var(--btn-hover); }

  button.secondary {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
    border: none;
    border-radius: 3px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 0.88em;
    white-space: nowrap;
    transition: background 0.15s;
  }

  button.secondary:hover { background: var(--btn-secondary-hover); }

  /* ---- Notification feed (right pane) ---- */
  .feed-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .feed-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .feed-toolbar h2 {
    margin: 0;
    font-size: 0.78em;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    opacity: 0.65;
    font-weight: 600;
  }

  #feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    display: flex;
    flex-direction: column-reverse;
  }

  .feed-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.45;
    font-style: italic;
    font-size: 0.9em;
  }

  .notif-entry {
    display: flex;
    align-items: flex-start;
    gap: 0;
    padding: 6px 14px 6px 10px;
    border-left: 3px solid transparent;
    font-family: var(--mono);
    font-size: 0.88em;
    line-height: 1.4;
    transition: background 0.1s;
  }

  .notif-entry:hover { background: var(--row-alt); }

  .notif-border {
    width: 3px;
    align-self: stretch;
    border-radius: 2px;
    flex-shrink: 0;
    margin-right: 10px;
  }

  .notif-time {
    color: var(--vscode-descriptionForeground, #888);
    flex-shrink: 0;
    margin-right: 10px;
  }

  .notif-channel {
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
    margin-right: 6px;
  }

  .notif-payload {
    flex: 1;
    word-break: break-all;
    color: var(--fg);
  }

  .notif-payload.empty {
    opacity: 0.4;
    font-style: italic;
  }

  .error-bar {
    padding: 6px 14px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border-top: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    font-size: 0.85em;
    color: var(--error-fg);
    flex-shrink: 0;
    display: none;
  }

  .error-bar.visible { display: block; }

  .error-bar.toast-success {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 16%, var(--vscode-editor-background));
    border-top-color: var(--vscode-testing-iconPassed, #73c991);
    color: var(--vscode-editor-foreground);
  }
</style>
</head>
<body>

<!-- Top header -->
<div class="top-header">
  <div>
    <h1>LISTEN / NOTIFY Monitor</h1>
    <div class="conn-meta">${connLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')} / ${database.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  </div>
  <div>
    <span class="status-dot" id="statusDot"></span>
    <span class="status-label" id="statusLabel">Connecting…</span>
  </div>
</div>

<!-- Main layout -->
<div class="main">

  <!-- Left sidebar -->
  <div class="sidebar">

    <!-- Active channels -->
    <div class="sidebar-section">
      <h2>Active Channels</h2>
      <div class="channel-list" id="channelList">
        <span class="no-channels-msg">No channels subscribed.</span>
      </div>
    </div>

    <!-- Subscribe -->
    <div class="sidebar-section">
      <h2>Subscribe</h2>
      <div class="form-row">
        <input type="text" id="subscribeInput" placeholder="channel name" />
        <button class="primary" id="subscribeBtn">Subscribe</button>
      </div>
    </div>

    <!-- Send NOTIFY -->
    <div class="sidebar-section">
      <h2>Send NOTIFY</h2>
      <div class="form-row">
        <input type="text" id="notifyChannel" placeholder="channel" />
      </div>
      <div class="form-row">
        <input type="text" id="notifyPayload" placeholder="payload (optional)" />
        <button class="primary" id="notifyBtn">Send</button>
      </div>
    </div>

  </div>

  <!-- Feed pane -->
  <div class="feed-pane">
    <div class="feed-toolbar">
      <h2>Notification Feed</h2>
      <button class="secondary" id="clearBtn">Clear</button>
    </div>
    <div id="feed">
      <div class="feed-empty" id="feedEmpty">Waiting for notifications…</div>
    </div>
    <div class="error-bar" id="errorBar"></div>
  </div>

</div>

<script>
  (function() {
    const vscode = acquireVsCodeApi();

    // ---------- DOM refs ----------
    const statusDot    = document.getElementById('statusDot');
    const statusLabel  = document.getElementById('statusLabel');
    const channelList  = document.getElementById('channelList');
    const subscribeInput = document.getElementById('subscribeInput');
    const subscribeBtn = document.getElementById('subscribeBtn');
    const notifyChannel = document.getElementById('notifyChannel');
    const notifyPayload = document.getElementById('notifyPayload');
    const notifyBtn    = document.getElementById('notifyBtn');
    const clearBtn     = document.getElementById('clearBtn');
    const feed         = document.getElementById('feed');
    const feedEmpty    = document.getElementById('feedEmpty');
    const errorBar     = document.getElementById('errorBar');

    // Internal feed entries (newest first)
    let feedEntries = [];
    const MAX_ENTRIES = 500;

    // Channel colour palette (cycles)
    const CHANNEL_COLOURS = [
      '#4fc3f7', '#81c784', '#ffb74d', '#e57373',
      '#ce93d8', '#80deea', '#a5d6a7', '#fff176',
    ];
    const channelColours = new Map();
    let colourIdx = 0;

    function colourForChannel(ch) {
      if (!channelColours.has(ch)) {
        channelColours.set(ch, CHANNEL_COLOURS[colourIdx % CHANNEL_COLOURS.length]);
        colourIdx++;
      }
      return channelColours.get(ch);
    }

    // ---------- Status ----------
    function setStatus(connected, errorMsg) {
      if (connected) {
        statusDot.className = 'status-dot connected';
        statusLabel.textContent = 'Connected';
      } else {
        statusDot.className = 'status-dot disconnected';
        statusLabel.textContent = errorMsg ? 'Error' : 'Disconnected';
      }
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ---------- Channel list ----------
    function renderChannels(channels) {
      if (!channels || channels.length === 0) {
        channelList.innerHTML = '<span class="no-channels-msg">No channels subscribed.</span>';
        return;
      }
      channelList.innerHTML = channels.map(ch => {
        const color = colourForChannel(ch);
        const safeLabel = escapeHtml(ch);
        return \`<div class="channel-item">
          <span class="channel-name" style="border-left:3px solid \${color}; padding-left:6px;">\${safeLabel}</span>
          <button class="unsub-btn" data-channel="\${safeLabel}" title="Unsubscribe">&times;</button>
        </div>\`;
      }).join('');

      channelList.querySelectorAll('.unsub-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'unsubscribe', channel: btn.dataset.channel });
        });
      });
    }

    // ---------- Feed ----------
    function formatTime(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleTimeString('en-GB', { hour12: false });
    }

    function renderFeedEntry(note) {
      const color = colourForChannel(note.channel);
      const safeCh = escapeHtml(note.channel);
      const safePayload = escapeHtml(note.payload || '(no payload)');
      const payloadClass = note.payload ? '' : 'empty';
      return \`<div class="notif-entry">
        <div class="notif-border" style="background:\${color}"></div>
        <span class="notif-time">\${formatTime(note.receivedAt)}</span>
        <span class="notif-channel">\${safeCh}:</span>
        <span class="notif-payload \${payloadClass}">\${safePayload}</span>
      </div>\`;
    }

    function addNotifications(notes) {
      if (!notes || notes.length === 0) { return; }

      feedEmpty.style.display = 'none';

      // Prepend new notes (newest-first in feed)
      const fragment = document.createDocumentFragment();
      for (const note of notes) {
        const div = document.createElement('div');
        div.innerHTML = renderFeedEntry(note);
        fragment.appendChild(div.firstElementChild);
      }

      // Insert before first child (which is the oldest visible entry)
      feed.insertBefore(fragment, feed.firstChild);

      // Trim to max
      feedEntries = [...notes, ...feedEntries].slice(0, MAX_ENTRIES);
      while (feed.children.length > MAX_ENTRIES + 1 /* +1 for feedEmpty */) {
        feed.removeChild(feed.lastChild);
      }
    }

    function clearFeed() {
      feedEntries = [];
      // Remove all entries but keep feedEmpty
      while (feed.firstChild && feed.firstChild !== feedEmpty) {
        feed.removeChild(feed.firstChild);
      }
      feedEmpty.style.display = '';
    }

    // ---------- Error bar ----------
    function showError(msg) {
      errorBar.textContent = msg;
      errorBar.classList.remove('toast-success');
      errorBar.classList.add('visible');
      setTimeout(() => errorBar.classList.remove('visible'), 5000);
    }

    function showSuccess(msg) {
      errorBar.textContent = msg;
      errorBar.classList.remove('toast-success');
      errorBar.classList.add('visible', 'toast-success');
      setTimeout(() => errorBar.classList.remove('visible', 'toast-success'), 3200);
    }

    // ---------- Button handlers ----------
    subscribeBtn.addEventListener('click', () => {
      const ch = subscribeInput.value.trim();
      if (!ch) { return; }
      vscode.postMessage({ type: 'subscribe', channel: ch });
      subscribeInput.value = '';
    });

    subscribeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { subscribeBtn.click(); }
    });

    notifyBtn.addEventListener('click', () => {
      const ch = notifyChannel.value.trim();
      const payload = notifyPayload.value;
      if (!ch) { notifyChannel.focus(); return; }
      vscode.postMessage({ type: 'notify', channel: ch, payload });
    });

    notifyPayload.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { notifyBtn.click(); }
    });

    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    // ---------- Message handler ----------
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          setStatus(msg.connected, msg.error);
          break;
        case 'channels':
          renderChannels(msg.channels);
          break;
        case 'notifications':
          addNotifications(msg.notifications);
          break;
        case 'clearFeed':
          clearFeed();
          break;
        case 'error':
          showError(msg.message);
          break;
        case 'notifySent': {
          const ch = (msg.channel || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const pl = msg.payload != null && String(msg.payload).length > 0
            ? ' · ' + String(msg.payload).slice(0, 120).replace(/</g, '&lt;')
            : '';
          showSuccess('NOTIFY sent: ' + ch + pl);
          break;
        }
      }
    });

    // Signal ready to the extension
    vscode.postMessage({ type: 'ready' });
  })();
</script>
</body>
</html>`;
  }
}
