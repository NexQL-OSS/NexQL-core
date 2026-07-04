/**
 * In-process MCP server exposing NexQL's read-only DB tools over MCP Streamable HTTP.
 *
 * Hand-rolled JSON-RPC-over-HTTP on node's `http` module — deliberately no MCP SDK
 * dependency. VS Code's `McpHttpServerDefinition` client POSTs JSON-RPC messages to the
 * server URI; replying `application/json` per request is spec-legal for Streamable HTTP
 * (no SSE stream required for simple tools servers — GET returns 405).
 *
 * All tools dispatch to the same `ToolExecutor` the in-chat agentic loop uses, so the
 * read-only guarantees (default_transaction_read_only, SELECT/WITH/EXPLAIN-only) apply
 * identically to external agents.
 */
import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { DB_TOOLS } from '../providers/chat/tools/ToolSpec';
import { ToolExecutor } from '../providers/chat/tools/ToolExecutor';
import { WorkspaceStateService } from '../services/WorkspaceStateService';
import { debugLog } from '../common/logger';

export interface NexqlMcpServerInfo {
  port: number;
  token: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
}

const FALLBACK_PROTOCOL_VERSION = '2025-03-26';

export class NexqlMcpServer {
  private _server?: http.Server;
  private _info?: NexqlMcpServerInfo;
  /**
   * One executor for the server's lifetime: `select_connection_context` mutates the
   * executor's own connection/database, and external agents expect that choice to stick
   * across subsequent tool calls.
   */
  private _executor?: ToolExecutor;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  async start(): Promise<NexqlMcpServerInfo> {
    if (this._info) {
      return this._info;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const server = http.createServer((req, res) => {
      void this._handleRequest(req, res, token);
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('NexQL MCP server failed to bind a local port.'));
        }
      });
    });

    this._server = server;
    this._info = { port, token };
    debugLog(`[NexqlMcpServer] Listening on 127.0.0.1:${port}`);
    return this._info;
  }

  dispose(): void {
    this._server?.close();
    this._server = undefined;
    this._info = undefined;
    this._executor = undefined;
  }

  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: string
  ): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(raw);
      } catch {
        this._sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' }
        });
        return;
      }

      // Notifications (no id) get acknowledged without a body.
      if (message.id === undefined || message.id === null) {
        res.writeHead(202);
        res.end();
        return;
      }

      try {
        const result = await this._dispatch(message);
        this._sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result });
      } catch (err: any) {
        const code = typeof err?.rpcCode === 'number' ? err.rpcCode : -32603;
        this._sendJson(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code, message: err?.message || String(err) }
        });
      }
    });
  }

  private async _dispatch(message: JsonRpcRequest): Promise<unknown> {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: message.params?.protocolVersion || FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: 'nexql',
            version: String(this._context.extension?.packageJSON?.version ?? '0.0.0')
          }
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: DB_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters
          }))
        };
      case 'tools/call': {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        if (!name || !DB_TOOLS.some((t) => t.name === name)) {
          const err: any = new Error(`Unknown tool: ${name}`);
          err.rpcCode = -32602;
          throw err;
        }
        const executor = this._getExecutor();
        const text = await executor.executeTool(name, args);
        return {
          content: [{ type: 'text', text }],
          isError: this._isErrorResult(text)
        };
      }
      default: {
        const err: any = new Error(`Method not found: ${message.method}`);
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  /** ToolExecutor returns `{"error": …}` JSON on failure instead of throwing. */
  private _isErrorResult(text: string): boolean {
    try {
      const parsed = JSON.parse(text);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed;
    } catch {
      return false;
    }
  }

  private _getExecutor(): ToolExecutor {
    if (!this._executor) {
      const { connectionId, databaseName } = this._resolveDefaultConnection();
      this._executor = new ToolExecutor(this._context, connectionId, databaseName);
    }
    return this._executor;
  }

  /** Last-used workspace defaults, else the first configured connection (mirrors chat fallback). */
  private _resolveDefaultConnection(): { connectionId: string; databaseName: string } {
    const defaults = WorkspaceStateService.getInstance().getDefaults();
    let connectionId = defaults.lastConnectionId ?? '';
    let databaseName = defaults.lastDatabaseName ?? '';

    if (!connectionId || !databaseName) {
      const connections =
        vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const first = connections[0];
      if (first) {
        connectionId = connectionId || first.id;
        databaseName = databaseName || first.database || 'postgres';
      }
    }

    return { connectionId, databaseName };
  }

  private _sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  }
}
