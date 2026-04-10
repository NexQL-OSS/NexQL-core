import * as vscode from 'vscode';
import { ConnectionInfo, ConnectionFormPanel } from './connectionForm';
import { SecretStorageService } from './services/SecretStorageService';

export class ConnectionManagementPanel {
    public static currentPanel: ConnectionManagementPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _extensionContext: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, extensionContext: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._extensionContext = extensionContext;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._initialize();

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'addConnection':
                        // Open the connection form panel
                        vscode.commands.executeCommand('postgres-explorer.addConnection');
                        break;

                    case 'refresh':
                        await this._update();
                        break;

                    case 'delete':
                        try {
                            const config = vscode.workspace.getConfiguration();
                            const connections = config.get<ConnectionInfo[]>('postgresExplorer.connections') || [];

                            const updatedConnections = connections.filter(c => c.id !== message.id);
                            await config.update('postgresExplorer.connections', updatedConnections, vscode.ConfigurationTarget.Global);

                            // Delete password from secret storage
                            try {
                                await SecretStorageService.getInstance().deletePassword(message.id);
                            } catch (err) {
                                console.log(`No password to delete for connection ${message.id}`);
                            }

                            vscode.window.showInformationMessage(`Connection deleted successfully`);
                            vscode.commands.executeCommand('postgres-explorer.refreshConnections');
                            await this._update();
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to delete connection: ${err.message}`);
                        }
                        break;

                    case 'edit':
                        {
                            const config = vscode.workspace.getConfiguration();
                            const connections = config.get<ConnectionInfo[]>('postgresExplorer.connections') || [];
                            const connectionToEdit = connections.find(c => c.id === message.id);

                            if (connectionToEdit) {
                                ConnectionManagementPanel.currentPanel?._panel.dispose();
                                ConnectionFormPanel.show(this._extensionUri, this._extensionContext, connectionToEdit);
                            } else {
                                vscode.window.showErrorMessage(`Connection not found: ${message.id}`);
                            }
                        }
                        break;

                    case 'test':
                        try {
                            const { Client } = require('pg');
                            const config = vscode.workspace.getConfiguration();
                            const connections = config.get<ConnectionInfo[]>('postgresExplorer.connections') || [];
                            const connection = connections.find(c => c.id === message.id);

                            if (!connection) {
                                throw new Error('Connection not found');
                            }

                            const password = await SecretStorageService.getInstance().getPassword(connection.id);

                            const client = new Client({
                                host: connection.host,
                                port: connection.port,
                                user: connection.username || undefined,
                                password: password || undefined,
                                database: connection.database || 'postgres',
                                connectionTimeoutMillis: (connection.connectTimeout || 15) * 1000
                            });

                            await client.connect();
                            const result = await client.query('SELECT version()');
                            await client.end();

                            this._panel.webview.postMessage({
                                type: 'testSuccess',
                                id: message.id,
                                version: result.rows[0].version
                            });
                        } catch (err: any) {
                            this._panel.webview.postMessage({
                                type: 'testError',
                                id: message.id,
                                error: err.message
                            });
                        }
                        break;
                }
            },
            undefined,
            this._disposables
        );
    }

    public static show(extensionUri: vscode.Uri, extensionContext: vscode.ExtensionContext) {
        if (ConnectionManagementPanel.currentPanel) {
            ConnectionManagementPanel.currentPanel._panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'connectionManagement',
            'Manage Connections',
            vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        ConnectionManagementPanel.currentPanel = new ConnectionManagementPanel(panel, extensionUri, extensionContext);
    }

    private async _initialize() {
        await this._update();
    }

    private async _update() {
        this._panel.webview.html = await this._getHtmlForWebview(this._panel.webview);
    }

    private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const config = vscode.workspace.getConfiguration();
        const connections = config.get<ConnectionInfo[]>('postgresExplorer.connections') || [];
        const logoPath = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'postgres-vsc-icon.png'));

        // Get passwords and probe reachability for each connection
        const connectionsWithStatus = await Promise.all(connections.map(async (conn) => {
            const password = await SecretStorageService.getInstance().getPassword(conn.id);
            const isReachable = await this._probeConnection(conn, password || conn.password);
            return {
                ...conn,
                hasPassword: !!password,
                isReachable
            };
        }));

        const connectionsHtml = connectionsWithStatus.length > 0
            ? connectionsWithStatus.map(conn => this._getConnectionCardHtml(conn)).join('')
            : `<div class="empty-state">
                    <div class="empty-icon">🔌</div>
                    <h2>No Connections</h2>
                    <p>You haven't added any database connections yet.</p>
                    <button class="btn-primary" onclick="addConnection()">Add Your First Connection</button>
                </div>`;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Manage Connections</title>
            <style>
                :root {
                    --bg-color: var(--vscode-editor-background);
                    --text-color: var(--vscode-editor-foreground);
                    --card-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
                    --border-color: var(--vscode-widget-border);
                    --focus-border: var(--vscode-focusBorder);
                    --accent-color: var(--vscode-textLink-foreground);
                    --hover-bg: var(--vscode-list-hoverBackground);
                    --danger-color: var(--vscode-errorForeground);
                    --success-color: var(--vscode-testing-iconPassed);
                    --warning-color: var(--vscode-editorWarning-foreground);
                    --secondary-text: var(--vscode-descriptionForeground);
                    --font-family: var(--vscode-font-family);
                    --card-radius: 6px;
                    --env-dev: #22c55e;
                    --env-staging: #f59e0b;
                    --env-prod: #ef4444;
                    --env-default: var(--accent-color);
                }

                * { margin: 0; padding: 0; box-sizing: border-box; }

                body {
                    background-color: var(--bg-color);
                    color: var(--text-color);
                    font-family: var(--font-family);
                    padding: 32px 24px;
                    line-height: 1.6;
                    min-height: 100vh;
                }

                .container {
                    max-width: 1200px;
                    margin: 0 auto;
                    animation: fadeIn 0.3s ease;
                }

                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .header {
                    text-align: center;
                    margin-bottom: 40px;
                }

                .header-icon {
                    width: 56px;
                    height: 56px;
                    margin: 0 auto 16px;
                    background: linear-gradient(135deg, #8B5CF6 0%, #A78BFA 100%);
                    border-radius: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
                }

                .header-icon img {
                    width: 32px;
                    height: 32px;
                    filter: brightness(0) invert(1);
                }

                .header h1 {
                    font-size: 24px;
                    font-weight: 600;
                    letter-spacing: -0.5px;
                    margin-bottom: 6px;
                }

                .header p {
                    color: var(--secondary-text);
                    font-size: 13px;
                }

                .btn-primary {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 14px;
                    border-radius: 4px;
                    font-family: var(--font-family);
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 16px;
                }

                .btn-primary:hover {
                    background: var(--vscode-button-hoverBackground);
                }

                .connections-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
                    gap: 16px;
                }

                /* env accent border */
                .connection-card {
                    background-color: var(--card-bg);
                    border: 1px solid var(--border-color);
                    border-left: 3px solid var(--env-default);
                    border-radius: var(--card-radius);
                    padding: 14px 16px 12px;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    transition: border-color 0.15s, box-shadow 0.15s;
                    position: relative;
                    overflow: hidden;
                }

                .connection-card.env-dev   { border-left-color: var(--env-dev); }
                .connection-card.env-staging { border-left-color: var(--env-staging); }
                .connection-card.env-prod  { border-left-color: var(--env-prod); }

                .connection-card:hover {
                    border-color: var(--focus-border);
                    border-left-color: inherit;
                    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
                }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .card-title {
                    font-size: 14px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    overflow: hidden;
                }

                .card-title span:last-child {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                /* single status pill */
                .status-pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    padding: 2px 8px;
                    border-radius: 10px;
                    font-size: 11px;
                    font-weight: 500;
                    white-space: nowrap;
                    flex-shrink: 0;
                    border: 1px solid var(--border-color);
                    color: var(--secondary-text);
                    background: transparent;
                }

                .status-pill .dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: currentColor;
                    flex-shrink: 0;
                }

                .status-pill.live {
                    color: var(--success-color);
                    border-color: color-mix(in srgb, var(--success-color) 40%, transparent);
                    background: color-mix(in srgb, var(--success-color) 10%, transparent);
                }

                .status-pill.offline {
                    color: var(--danger-color);
                    border-color: color-mix(in srgb, var(--danger-color) 40%, transparent);
                    background: color-mix(in srgb, var(--danger-color) 10%, transparent);
                }

                .card-details {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                }

                .detail-row {
                    display: flex;
                    font-size: 12px;
                    align-items: baseline;
                }

                .detail-label {
                    color: var(--secondary-text);
                    width: 68px;
                    flex-shrink: 0;
                    font-size: 11px;
                }

                .detail-value {
                    font-family: 'Courier New', monospace;
                    font-size: 12px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                /* actions: hidden by default, shown on hover */
                .card-actions {
                    display: flex;
                    gap: 6px;
                    padding-top: 10px;
                    border-top: 1px solid var(--border-color);
                    opacity: 0;
                    transition: opacity 0.15s ease;
                    pointer-events: none;
                }

                .connection-card:hover .card-actions {
                    opacity: 1;
                    pointer-events: auto;
                }

                .btn {
                    padding: 4px 10px;
                    border-radius: 3px;
                    cursor: pointer;
                    font-family: var(--font-family);
                    font-size: 11px;
                    font-weight: 500;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    background: transparent;
                    color: var(--text-color);
                    border: 1px solid var(--border-color);
                    transition: background 0.12s;
                }

                .btn:hover {
                    background-color: var(--hover-bg);
                }

                .btn-delete {
                    margin-left: auto;
                    font-size: 11px;
                    color: var(--danger-color);
                    border-color: transparent;
                    padding: 4px 6px;
                }

                .btn-delete:hover {
                    background-color: color-mix(in srgb, var(--danger-color) 15%, transparent);
                    border-color: var(--danger-color);
                }

                /* test result toast inside card */
                .test-toast {
                    position: absolute;
                    bottom: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    padding: 5px 12px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 500;
                    white-space: nowrap;
                    z-index: 10;
                    animation: toastIn 0.2s ease;
                    pointer-events: none;
                }

                @keyframes toastIn {
                    from { opacity: 0; transform: translateX(-50%) translateY(4px); }
                    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
                }

                .test-toast.success {
                    background: color-mix(in srgb, var(--success-color) 20%, transparent);
                    color: var(--success-color);
                    border: 1px solid color-mix(in srgb, var(--success-color) 40%, transparent);
                }

                .test-toast.error {
                    background: color-mix(in srgb, var(--danger-color) 15%, transparent);
                    color: var(--danger-color);
                    border: 1px solid color-mix(in srgb, var(--danger-color) 35%, transparent);
                }

                /* delete confirm overlay */
                .delete-confirm-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(0,0,0,0.82);
                    backdrop-filter: blur(2px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--card-radius);
                    z-index: 20;
                    flex-direction: column;
                    gap: 12px;
                    animation: fadeIn 0.15s;
                }

                .delete-confirm-overlay p {
                    color: #fff;
                    font-size: 13px;
                    font-weight: 500;
                }

                .confirm-buttons { display: flex; gap: 8px; }

                .empty-state {
                    grid-column: 1 / -1;
                    text-align: center;
                    padding: 64px 24px;
                    color: var(--secondary-text);
                }

                .empty-state .empty-icon { font-size: 40px; margin-bottom: 16px; }
                .empty-state h2 { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: var(--text-color); }
                .empty-state p { font-size: 13px; margin-bottom: 16px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="header-icon">
                        <img src="${logoPath}" alt="Logo">
                    </div>
                    <h1>Connection Management</h1>
                    <p>Manage your PostgreSQL database connections</p>
                    <button class="btn-primary" onclick="addConnection()">
                        + Add Connection
                    </button>
                </div>

                <div class="connections-grid">
                    ${connectionsHtml}
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                function addConnection() {
                    vscode.postMessage({ command: 'addConnection' });
                }

                function editConnection(id) {
                    vscode.postMessage({ command: 'edit', id: id });
                }

                function refreshConnections() {
                    vscode.postMessage({ command: 'refresh' });
                }

                function testConnection(id) {
                    const btn = document.querySelector(\`[data-test-id="\${id}"]\`);
                    btn.textContent = 'Testing…';
                    btn.disabled = true;
                    vscode.postMessage({ command: 'test', id: id });
                }

                function showDeleteConfirm(id) {
                    const card = document.querySelector(\`[data-card-id="\${id}"]\`);
                    if (card.querySelector('.delete-confirm-overlay')) return;

                    const overlay = document.createElement('div');
                    overlay.className = 'delete-confirm-overlay';
                    overlay.innerHTML = \`
                        <p>Delete this connection?</p>
                        <div class="confirm-buttons">
                            <button class="btn" style="background:rgba(255,255,255,0.1);color:#fff;border-color:rgba(255,255,255,0.2)" onclick="this.closest('.delete-confirm-overlay').remove()">Cancel</button>
                            <button class="btn" style="background:#ef4444;color:#fff;border:none" onclick="deleteConnection('\${id}')">Delete</button>
                        </div>
                    \`;
                    card.appendChild(overlay);
                }

                function deleteConnection(id) {
                    vscode.postMessage({ command: 'delete', id: id });
                }

                window.addEventListener('message', event => {
                    const message = event.data;

                    if (message.type === 'testSuccess') {
                        const btn = document.querySelector(\`[data-test-id="\${message.id}"]\`);
                        const card = document.querySelector(\`[data-card-id="\${message.id}"]\`);
                        btn.textContent = 'Test';
                        btn.disabled = false;
                        showToast(card, '✓ Connected', 'success');

                    } else if (message.type === 'testError') {
                        const btn = document.querySelector(\`[data-test-id="\${message.id}"]\`);
                        const card = document.querySelector(\`[data-card-id="\${message.id}"]\`);
                        btn.textContent = 'Test';
                        btn.disabled = false;
                        showToast(card, '✕ ' + (message.error || 'Failed'), 'error');
                    }
                });

                function showToast(card, text, type) {
                    const existing = card.querySelector('.test-toast');
                    if (existing) existing.remove();

                    const el = document.createElement('div');
                    el.className = 'test-toast ' + type;
                    el.textContent = text;
                    card.appendChild(el);

                    setTimeout(() => {
                        el.style.transition = 'opacity 0.3s';
                        el.style.opacity = '0';
                        setTimeout(() => el.remove(), 300);
                    }, 3500);
                }
            </script>
        </body>
        </html>`;
    }

    /**
     * Attempts a quick TCP connection to the host:port to determine reachability.
     * Times out after 3 seconds to keep the panel load fast.
     */
    private async _probeConnection(conn: ConnectionInfo, password?: string): Promise<boolean> {
        return new Promise((resolve) => {
            const net = require('net') as typeof import('net');
            const socket = new net.Socket();
            const timeout = 3000;
            let settled = false;
            const done = (result: boolean) => {
                if (settled) { return; }
                settled = true;
                socket.destroy();
                resolve(result);
            };
            socket.setTimeout(timeout);
            socket.on('connect', () => done(true));
            socket.on('timeout', () => done(false));
            socket.on('error', () => done(false));
            socket.connect(conn.port || 5432, conn.host || 'localhost');
        });
    }

    private _getConnectionCardHtml(conn: ConnectionInfo & { hasPassword: boolean; isReachable: boolean }): string {
        const escape = (s: string | undefined) => this._escapeHtml(s || '');

        // Derive env class from connection name (case-insensitive keywords)
        const nameLower = (conn.name || '').toLowerCase();
        let envClass = '';
        if (/prod|production/.test(nameLower)) { envClass = 'env-prod'; }
        else if (/stag|staging|uat/.test(nameLower)) { envClass = 'env-staging'; }
        else if (/dev|local|test/.test(nameLower)) { envClass = 'env-dev'; }

        // Status pill based on actual TCP reachability
        const pillClass = conn.isReachable ? 'live' : 'offline';
        const pillLabel = conn.isReachable ? 'Live' : 'Down';

        return `
            <div class="connection-card ${envClass}" data-card-id="${conn.id}">
                <div class="card-header">
                    <div class="card-title">
                        <span>🗄️</span>
                        <span>${escape(conn.name)}</span>
                    </div>
                    <span class="status-pill ${pillClass}">
                        <span class="dot"></span>${pillLabel}
                    </span>
                </div>

                <div class="card-details">
                    <div class="detail-row">
                        <span class="detail-label">Host</span>
                        <span class="detail-value">${escape(conn.host)}:${conn.port}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Database</span>
                        <span class="detail-value">${escape(conn.database)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">User</span>
                        <span class="detail-value">${escape(conn.username)}</span>
                    </div>
                </div>

                <div class="card-actions">
                    <button class="btn" onclick="editConnection('${conn.id}')">✏ Edit</button>
                    <button class="btn" data-test-id="${conn.id}" onclick="testConnection('${conn.id}')">⚡ Test</button>
                    <button class="btn btn-delete" onclick="showDeleteConfirm('${conn.id}')">Delete</button>
                </div>
            </div>`;
    }

    private _buildConnectionString(conn: ConnectionInfo): string {
        const auth = conn.username
            ? `${conn.username}${conn.password ? ':****' : ''}@`
            : '';
        const database = conn.database || 'postgres';
        return `postgresql://${auth}${conn.host}:${conn.port}/${database}`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private dispose() {
        ConnectionManagementPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
