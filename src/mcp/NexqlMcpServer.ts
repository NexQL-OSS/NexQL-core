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
import { McpResourceProvider } from './McpResourceProvider';
import { McpPrompts } from './McpPrompts';
import { WorkspaceStateService } from '../services/WorkspaceStateService';
import { TelemetryService } from '../services/TelemetryService';
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

/** Newest first; initialize echoes the client's version when supported, else returns the newest. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 32;

/**
 * Surfaced via `initialize.instructions` (MCP spec: clients MAY inject this into the
 * model's system prompt). External clients like VS Code Copilot never see NexQL's
 * in-chat agentic system prompt, so this is the only hook to stop them hallucinating
 * schema — without it, models fall back to training-data table names instead of the
 * live, auto-indexed schema exposed by search_schema/describe_object/list_objects.
 */
const MCP_SERVER_INSTRUCTIONS = [
  'NexQL exposes the REAL, live-indexed schema of the connected Postgres database.',
  'Never invent or assume table, view, or column names from prior knowledge or naming conventions.',
  'Before writing any SQL (run_select / explain_query), you MUST first ground it in the actual schema:',
  '  1. list_schemas / list_objects or search_schema to find candidate objects.',
  '  2. describe_object on each referenced table/view to confirm exact columns and types.',
  '  3. get_join_path if the query spans multiple tables.',
  'Only after confirming an object and its columns exist via these tools may you reference them in SQL.',
  'If a table you expect is not returned by search_schema/list_objects, it does not exist — ask the user or pick from what was returned instead of guessing.'
].join('\n');

export class NexqlMcpServer {
  private static _instance?: NexqlMcpServer;

  public static getInstance(): NexqlMcpServer | undefined {
    return NexqlMcpServer._instance;
  }

  private _server?: http.Server;
  private _info?: NexqlMcpServerInfo;
  private _sessions = new Map<string, { executor: ToolExecutor; lastUsedAt: number }>();
  private _sweepTimer?: ReturnType<typeof setInterval>;
  private readonly _prompts = new McpPrompts();
  private _requestCount = 0;
  private _resetTime = Date.now() + 60000;
  private readonly MAX_REQUESTS_PER_MINUTE = 200;

  constructor(private readonly _context: vscode.ExtensionContext) {
    NexqlMcpServer._instance = this;
  }

  public get info(): NexqlMcpServerInfo | undefined {
    return this._info;
  }

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
    this._sweepTimer = setInterval(() => this._evictIdleSessions(), SESSION_SWEEP_INTERVAL_MS);
    // Don't keep the extension host's event loop alive just for the sweep.
    this._sweepTimer.unref?.();
    debugLog(`[NexqlMcpServer] Listening on 127.0.0.1:${port}`);
    return this._info;
  }

  dispose(): void {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = undefined;
    }
    this._server?.close();
    this._server = undefined;
    this._info = undefined;
    this._sessions.clear();
  }

  private _evictIdleSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [id, session] of this._sessions) {
      if (session.lastUsedAt < cutoff) {
        this._sessions.delete(id);
      }
    }
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

    if (req.method === 'DELETE') {
      // Explicit session termination per Streamable HTTP spec.
      const sessionId = this._readSessionId(req);
      if (sessionId && this._sessions.delete(sessionId)) {
        res.writeHead(204);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify({ error: 'session not found' }));
      }
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    // Rate Limiting Guard
    const now = Date.now();
    if (now > this._resetTime) {
      this._requestCount = 0;
      this._resetTime = now + 60000;
    }
    if (this._requestCount >= this.MAX_REQUESTS_PER_MINUTE) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too Many Requests' }));
      return;
    }
    this._requestCount++;

    // Body Size Limit Guard
    let raw = '';
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit for MCP JSON-RPC payload
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > MAX_BODY_SIZE) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (tooLarge) return;
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

      const sessionId = this._readSessionId(req) || 'default';
      try {
        // `initialize` mints the session; the id is returned via the
        // Mcp-Session-Id response header per the Streamable HTTP spec.
        let responseHeaders: Record<string, string> | undefined;
        let effectiveSessionId = sessionId;
        if (message.method === 'initialize') {
          effectiveSessionId = crypto.randomUUID();
          responseHeaders = { 'Mcp-Session-Id': effectiveSessionId };
          this._getSession(effectiveSessionId);
        }
        const result = await this._dispatch(message, effectiveSessionId);
        this._sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result }, responseHeaders);
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

  private async _dispatch(message: JsonRpcRequest, sessionId: string): Promise<unknown> {
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: {
            name: 'nexql',
            version: String(this._context.extension?.packageJSON?.version ?? '0.0.0')
          },
          instructions: MCP_SERVER_INSTRUCTIONS
        };
      }
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
        const executor = this._getSession(sessionId).executor;
        let isError = false;
        let text = '';
        try {
          text = await executor.executeTool(name, args);
          isError = this._isErrorResult(text);
        } catch (e) {
          isError = true;
          throw e;
        } finally {
          try {
            TelemetryService.getInstance().trackMcpToolInvoked(name, isError);
          } catch {
            // Safe fallback
          }
        }
        const structured = this._tryParseJsonObject(text);
        return {
          content: [{ type: 'text', text }],
          ...(structured !== undefined && !isError ? { structuredContent: structured } : {}),
          isError
        };
      }
      case 'resources/list':
        return await new McpResourceProvider(this._context.globalStorageUri).list(
          message.params?.cursor
        );
      case 'resources/read': {
        const uri = message.params?.uri;
        if (!uri || typeof uri !== 'string') {
          const err: any = new Error('Missing required parameter: uri');
          err.rpcCode = -32602;
          throw err;
        }
        return await new McpResourceProvider(this._context.globalStorageUri).read(uri);
      }
      case 'resources/templates/list':
        return new McpResourceProvider(this._context.globalStorageUri).listTemplates();
      case 'prompts/list':
        return this._prompts.list();
      case 'prompts/get':
        return this._prompts.get(message.params?.name, message.params?.arguments ?? {});
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

  /**
   * Spec requires `structuredContent` to be a JSON *object*; row arrays are
   * wrapped as `{ items }`. Non-JSON text yields undefined (text-only result).
   */
  private _tryParseJsonObject(text: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return { items: parsed };
      }
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private _readSessionId(req: http.IncomingMessage): string | undefined {
    const value = req.headers['mcp-session-id'] || req.headers['x-mcp-session-id'];
    return typeof value === 'string' && value ? value : undefined;
  }

  private _getSession(sessionId: string): { executor: ToolExecutor; lastUsedAt: number } {
    let session = this._sessions.get(sessionId);
    if (!session) {
      if (this._sessions.size >= MAX_SESSIONS) {
        // Evict the least recently used session to bound memory.
        let lruId: string | undefined;
        let lruAt = Infinity;
        for (const [id, s] of this._sessions) {
          if (s.lastUsedAt < lruAt) {
            lruAt = s.lastUsedAt;
            lruId = id;
          }
        }
        if (lruId !== undefined) {
          this._sessions.delete(lruId);
        }
      }
      const { connectionId, databaseName } = this._resolveDefaultConnection();
      session = {
        executor: new ToolExecutor(this._context, connectionId, databaseName),
        lastUsedAt: Date.now()
      };
      this._sessions.set(sessionId, session);
    }
    session.lastUsedAt = Date.now();
    return session;
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

  private _sendJson(
    res: http.ServerResponse,
    status: number,
    payload: unknown,
    extraHeaders?: Record<string, string>
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders
    });
    res.end(body);
  }
}
