import { expect } from 'chai';
import * as sinon from 'sinon';
import * as http from 'http';
import * as vscode from 'vscode';
import { NexqlMcpServer } from '../../mcp/NexqlMcpServer';
import { McpDefinitionProvider } from '../../mcp/McpDefinitionProvider';
import { ConnectionManager } from '../../services/ConnectionManager';
import { ConnectionUtils } from '../../utils/connectionUtils';

function postRequest(
  port: number,
  token: string,
  body: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization': `Bearer ${token}`,
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: raw, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function deleteRequest(
  port: number,
  token: string,
  headers: Record<string, string> = {}
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, ...headers }
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode || 0 }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('NexqlMcpServer & McpDefinitionProvider Unit Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let server: NexqlMcpServer;
  let provider: McpDefinitionProvider;
  let poolClientStub: any;
  let connectionManagerStub: any;
  let mockConnections: any[];
  let mcpEnabled = true;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mcpEnabled = true;

    mockContext = {
      subscriptions: [],
      workspaceState: {
        get: () => ({ lastConnectionId: 'conn1', lastDatabaseName: 'db1' }),
        update: () => Promise.resolve()
      },
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve()
      },
      extension: {
        packageJSON: { version: '2.3.0' }
      },
      globalStorageUri: vscode.Uri.file('/tmp/nexql-mcp-test-storage')
    } as any;

    mockConnections = [
      { id: 'conn1', name: 'Connection 1', host: 'localhost', port: 5432, database: 'db1' },
      { id: 'conn2', name: 'Connection 2', host: 'localhost', port: 5432, database: 'db2' }
    ];

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string) => {
        if (key === 'postgresExplorer.connections') {
          return mockConnections;
        }
        return undefined;
      }
    } as any);

    poolClientStub = {
      query: sandbox.stub().resolves({ rows: [] }),
      release: sandbox.stub()
    };

    connectionManagerStub = {
      getPooledClient: sandbox.stub().resolves(poolClientStub)
    };

    sandbox.stub(ConnectionManager, 'getInstance').returns(connectionManagerStub);
    sandbox.stub(ConnectionUtils, 'listDatabases').resolves(['db1', 'db2', 'db3']);

    server = new NexqlMcpServer(mockContext);
    provider = new McpDefinitionProvider(server, () => mcpEnabled);
  });

  afterEach(() => {
    server.dispose();
    provider.dispose();
    sandbox.restore();
  });

  describe('McpDefinitionProvider', () => {
    it('returns empty array when disabled', () => {
      mcpEnabled = false;
      const defs = provider.provideMcpServerDefinitions();
      expect(defs).to.deep.equal([]);
    });

    it('returns definition when enabled', () => {
      const defs = provider.provideMcpServerDefinitions();
      expect(defs.length).to.equal(1);
      expect(defs[0].label).to.equal('NexQL');
    });

    it('resolves definition to start server and set authorization headers', async () => {
      const defs = provider.provideMcpServerDefinitions();
      const resolved = await provider.resolveMcpServerDefinition(defs[0]);
      expect(resolved.uri.toString()).to.contain('http://127.0.0.1:');
      expect(resolved.headers?.Authorization).to.contain('Bearer ');
    });
  });

  describe('NexqlMcpServer Security', () => {
    it('returns 401 Unauthorized for missing token', async () => {
      const info = await server.start();
      return new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: info.port,
            path: '/mcp',
            method: 'POST'
          },
          (res) => {
            expect(res.statusCode).to.equal(401);
            resolve();
          }
        );
        req.on('error', reject);
        req.end();
      });
    });

    it('returns 401 Unauthorized for invalid token', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, 'wrong-token', { jsonrpc: '2.0', method: 'ping', id: 1 });
      expect(res.status).to.equal(401);
    });

    it('returns 405 Method Not Allowed for GET', async () => {
      const info = await server.start();
      return new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: info.port,
            path: '/mcp',
            method: 'GET',
            headers: {
              Authorization: `Bearer ${info.token}`
            }
          },
          (res) => {
            expect(res.statusCode).to.equal(405);
            resolve();
          }
        );
        req.on('error', reject);
        req.end();
      });
    });

    it('returns 400 Bad Request for malformed JSON', async () => {
      const info = await server.start();
      return new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: info.port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${info.token}`
            }
          },
          (res) => {
            expect(res.statusCode).to.equal(400);
            resolve();
          }
        );
        req.on('error', reject);
        req.write('{invalid json');
        req.end();
      });
    });

    it('returns 413 Payload Too Large when payload exceeds limit', async () => {
      const info = await server.start();
      const largePayload = 'a'.repeat(1024 * 1024 + 100);
      return new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: info.port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${info.token}`
            }
          },
          (res) => {
            expect(res.statusCode).to.equal(413);
            resolve();
          }
        );
        req.on('error', reject);
        req.write(largePayload);
        req.end();
      });
    });

    it('rate limits when request limit is exceeded', async () => {
      const info = await server.start();
      // Temporarily overwrite rate limit property for faster testing
      (server as any).MAX_REQUESTS_PER_MINUTE = 5;
      for (let i = 0; i < 5; i++) {
        const res = await postRequest(info.port, info.token, { jsonrpc: '2.0', method: 'ping', id: i });
        expect(res.status).to.equal(200);
      }
      const resLimit = await postRequest(info.port, info.token, { jsonrpc: '2.0', method: 'ping', id: 99 });
      expect(resLimit.status).to.equal(429);
    });
  });

  describe('NexqlMcpServer Protocol & Tool Dispatching', () => {
    it('handles ping request', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, { jsonrpc: '2.0', method: 'ping', id: 1 });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.result).to.deep.equal({});
    });

    it('handles initialize request', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
        id: 1
      });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.result.protocolVersion).to.equal('2024-11-05');
      expect(parsed.result.serverInfo.name).to.equal('nexql');
    });

    it('handles tools/list request with new tools', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, { jsonrpc: '2.0', method: 'tools/list', id: 1 });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      const tools = parsed.result.tools;
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).to.include('list_connections');
      expect(toolNames).to.include('list_databases');
      expect(toolNames).to.include('list_schemas');
      expect(toolNames).to.include('list_objects');
      expect(toolNames).to.include('get_current_context');
      expect(toolNames).to.include('switch_connection');
    });

    it('returns error for unknown tool call', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'unknown_tool', arguments: {} },
        id: 1
      });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).to.equal(-32602);
      expect(parsed.error.message).to.contain('Unknown tool');
    });

    it('handles list_connections tool call', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_connections', arguments: {} },
        id: 1
      });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      const resultData = JSON.parse(parsed.result.content[0].text);
      expect(resultData.length).to.equal(2);
      expect(resultData[0].name).to.equal('Connection 1');
      expect(resultData[1].name).to.equal('Connection 2');
    });

    it('handles list_databases tool call', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_databases', arguments: { connectionId: 'conn1' } },
        id: 1
      });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      const resultData = JSON.parse(parsed.result.content[0].text);
      expect(resultData).to.deep.equal(['db1', 'db2', 'db3']);
    });

    it('handles get_current_context and switch_connection tool calls', async () => {
      const info = await server.start();

      // Check current context initially defaults
      const res1 = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_current_context', arguments: {} },
        id: 1
      });
      const parsed1 = JSON.parse(res1.body);
      const ctx1 = JSON.parse(parsed1.result.content[0].text);
      expect(ctx1.connectionId).to.equal('conn1');
      expect(ctx1.database).to.equal('db1');

      // Switch context
      const resSwitch = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'switch_connection', arguments: { connectionId: 'conn2', databaseName: 'db2' } },
        id: 2
      });
      expect(resSwitch.status).to.equal(200);

      // Verify context has updated
      const res2 = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_current_context', arguments: {} },
        id: 3
      });
      const parsed2 = JSON.parse(res2.body);
      const ctx2 = JSON.parse(parsed2.result.content[0].text);
      expect(ctx2.connectionId).to.equal('conn2');
      expect(ctx2.database).to.equal('db2');
    });

    it('handles list_schemas tool call', async () => {
      const info = await server.start();
      poolClientStub.query.withArgs(sinon.match.any).resolves({
        rows: [{ schema_name: 'public' }, { schema_name: 'test_schema' }]
      });

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_schemas', arguments: {} },
        id: 1
      });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      const resultData = JSON.parse(parsed.result.content[0].text);
      expect(resultData.length).to.equal(2);
      expect(resultData[0].schema_name).to.equal('public');
      expect(resultData[1].schema_name).to.equal('test_schema');
    });

    it('handles list_objects tool call', async () => {
      const info = await server.start();
      poolClientStub.query.withArgs(sinon.match.any).resolves({
        rows: [{ schema: 'public', name: 'users', kind: 'table', comment: 'Users table' }]
      });

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_objects', arguments: { schema: 'public', kind: 'table' } },
        id: 1
      });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      const resultData = JSON.parse(parsed.result.content[0].text);
      expect(resultData.length).to.equal(1);
      expect(resultData[0].name).to.equal('users');
      expect(resultData[0].kind).to.equal('table');
    });

    it('session isolation preserves separate connection context per session ID', async () => {
      const info = await server.start();

      // Session 1 switches to connection 2
      await postRequest(
        info.port,
        info.token,
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'switch_connection', arguments: { connectionId: 'conn2', databaseName: 'db2' } },
          id: 1
        },
        { 'x-mcp-session-id': 'session-alpha' }
      );

      // Session 2 queries context (should be defaulted to conn1/db1)
      const resSession2 = await postRequest(
        info.port,
        info.token,
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'get_current_context', arguments: {} },
          id: 2
        },
        { 'x-mcp-session-id': 'session-beta' }
      );
      const ctx2 = JSON.parse(JSON.parse(resSession2.body).result.content[0].text);
      expect(ctx2.connectionId).to.equal('conn1');
      expect(ctx2.database).to.equal('db1');

      // Session 1 queries context (should be conn2/db2)
      const resSession1 = await postRequest(
        info.port,
        info.token,
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'get_current_context', arguments: {} },
          id: 3
        },
        { 'x-mcp-session-id': 'session-alpha' }
      );
      const ctx1 = JSON.parse(JSON.parse(resSession1.body).result.content[0].text);
      expect(ctx1.connectionId).to.equal('conn2');
      expect(ctx1.database).to.equal('db2');
    });

    it('aborts query execution when SET default_transaction_read_only = ON fails', async () => {
      const info = await server.start();
      poolClientStub.query.withArgs('SET default_transaction_read_only = ON').rejects(new Error('Permission Denied'));

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'run_select', arguments: { sql: 'SELECT 1;' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.true;
      const errorObj = JSON.parse(parsed.result.content[0].text);
      expect(errorObj.error).to.contain('Failed to set transaction read-only mode');
      // Assert the actual query SELECT 1 was never run
      expect(poolClientStub.query.calledWith('SELECT 1;')).to.be.false;
    });

    it('aborts query execution when SET statement_timeout fails', async () => {
      const info = await server.start();
      poolClientStub.query.withArgs('SET default_transaction_read_only = ON').resolves();
      poolClientStub.query.withArgs("SET statement_timeout = '30s'").rejects(new Error('Unsupported configuration'));

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'run_select', arguments: { sql: 'SELECT 1;' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.true;
      const errorObj = JSON.parse(parsed.result.content[0].text);
      expect(errorObj.error).to.contain('Failed to set statement timeout');
      expect(poolClientStub.query.calledWith('SELECT 1;')).to.be.false;
    });

    it('executes SET statement_timeout before SELECT query and LIMIT-wraps it', async () => {
      const info = await server.start();
      poolClientStub.query.withArgs('SET default_transaction_read_only = ON').resolves();
      poolClientStub.query.withArgs("SET statement_timeout = '30s'").resolves();
      poolClientStub.query
        .withArgs('SELECT * FROM (SELECT 1) AS nexql_limited LIMIT 501')
        .resolves({ rows: [{ num: 1 }] });

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'run_select', arguments: { sql: 'SELECT 1;' } },
        id: 1
      });
      expect(res.status).to.equal(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.false;
      const resultData = JSON.parse(parsed.result.content[0].text);
      expect(resultData).to.deep.equal([{ num: 1 }]);
    });

    it('flags truncation when run_select exceeds maxRows', async () => {
      const info = await server.start();
      const manyRows = Array.from({ length: 501 }, (_, i) => ({ n: i }));
      poolClientStub.query
        .withArgs('SELECT * FROM (SELECT 1) AS nexql_limited LIMIT 501')
        .resolves({ rows: manyRows });

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'run_select', arguments: { sql: 'SELECT 1;' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      const resultData = JSON.parse(parsed.result.content[0].text);
      expect(resultData.truncated).to.be.true;
      expect(resultData.maxRows).to.equal(500);
      expect(resultData.rows.length).to.equal(500);
    });

    it('falls back to raw query with client-side slice when the LIMIT wrapper fails', async () => {
      const info = await server.start();
      poolClientStub.query
        .withArgs('SELECT * FROM (SELECT 1) AS nexql_limited LIMIT 501')
        .rejects(new Error('syntax error'));
      poolClientStub.query.withArgs('SELECT 1;').resolves({ rows: [{ num: 1 }] });

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'run_select', arguments: { sql: 'SELECT 1;' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.false;
      expect(JSON.parse(parsed.result.content[0].text)).to.deep.equal([{ num: 1 }]);
    });
  });

  describe('NexqlMcpServer Spec Hardening', () => {
    it('negotiates unknown protocol versions down to the newest supported', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2099-01-01' },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.protocolVersion).to.equal('2025-06-18');
    });

    it('advertises tools, resources, and prompts capabilities and instructions', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.capabilities).to.have.keys(['tools', 'resources', 'prompts']);
      expect(parsed.result.instructions).to.be.a('string').and.contain('search_schema');
    });

    it('issues an Mcp-Session-Id header on initialize', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
        id: 1
      });
      expect(res.headers['mcp-session-id']).to.be.a('string').with.length.greaterThan(0);
    });

    it('tears down a session on DELETE and 404s unknown sessions', async () => {
      const info = await server.start();
      const init = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
        id: 1
      });
      const sessionId = init.headers['mcp-session-id'] as string;

      const del = await deleteRequest(info.port, info.token, { 'mcp-session-id': sessionId });
      expect(del.status).to.equal(204);

      const delAgain = await deleteRequest(info.port, info.token, { 'mcp-session-id': sessionId });
      expect(delAgain.status).to.equal(404);
    });

    it('evicts sessions idle beyond the TTL', async () => {
      const info = await server.start();
      await postRequest(
        info.port,
        info.token,
        { jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_current_context', arguments: {} }, id: 1 },
        { 'mcp-session-id': 'stale-session' }
      );
      const sessions: Map<string, { lastUsedAt: number }> = (server as any)._sessions;
      expect(sessions.has('stale-session')).to.be.true;
      sessions.get('stale-session')!.lastUsedAt = Date.now() - 31 * 60 * 1000;
      (server as any)._evictIdleSessions();
      expect(sessions.has('stale-session')).to.be.false;
    });

    it('caps the session map with LRU eviction', async () => {
      const info = await server.start();
      const sessions: Map<string, unknown> = (server as any)._sessions;
      for (let i = 0; i < 33; i++) {
        await postRequest(
          info.port,
          info.token,
          { jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_current_context', arguments: {} }, id: i },
          { 'mcp-session-id': `session-${i}` }
        );
      }
      expect(sessions.size).to.equal(32);
      expect(sessions.has('session-0')).to.be.false;
      expect(sessions.has('session-32')).to.be.true;
    });

    it('returns structuredContent alongside text for JSON tool results', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_current_context', arguments: {} },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.structuredContent).to.be.an('object');
      expect(parsed.result.structuredContent.connectionId).to.equal('conn1');
    });

    it('lists the monitoring tools in tools/list', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, { jsonrpc: '2.0', method: 'tools/list', id: 1 });
      const toolNames = JSON.parse(res.body).result.tools.map((t: any) => t.name);
      for (const name of [
        'table_stats', 'index_usage', 'list_running_queries', 'find_blocking_locks',
        'slow_queries', 'db_health_check', 'get_ddl', 'explain_analyze', 'analyze_query_plan'
      ]) {
        expect(toolNames).to.include(name);
      }
    });
  });

  describe('NexqlMcpServer Resources & Prompts', () => {
    it('returns an empty resource list when no index exists', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, { jsonrpc: '2.0', method: 'resources/list', id: 1 });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.resources).to.deep.equal([]);
      expect(parsed.result.nextCursor).to.be.undefined;
    });

    it('rejects an invalid resources/list cursor with -32602', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'resources/list',
        params: { cursor: '!!!not-base64-json!!!' },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).to.equal(-32602);
    });

    it('returns -32002 for an unknown resource URI', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'resources/read',
        params: { uri: 'nexql://conn1/db1/object/public/missing' },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).to.equal(-32002);
    });

    it('lists resource templates', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'resources/templates/list',
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.resourceTemplates).to.have.length(1);
      expect(parsed.result.resourceTemplates[0].uriTemplate).to.contain('nexql://');
    });

    it('lists prompts with argument metadata', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, { jsonrpc: '2.0', method: 'prompts/list', id: 1 });
      const prompts = JSON.parse(res.body).result.prompts;
      const names = prompts.map((p: any) => p.name);
      expect(names).to.have.members(['health-check', 'analyze-slow-queries', 'explore-schema', 'debug-blocking']);
      const explore = prompts.find((p: any) => p.name === 'explore-schema');
      expect(explore.arguments[0]).to.deep.include({ name: 'topic', required: true });
    });

    it('builds prompt messages referencing the workflow tools', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'prompts/get',
        params: { name: 'debug-blocking' },
        id: 1
      });
      const result = JSON.parse(res.body).result;
      expect(result.messages[0].role).to.equal('user');
      expect(result.messages[0].content.text).to.contain('find_blocking_locks');
    });

    it('rejects prompts/get with a missing required argument', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'prompts/get',
        params: { name: 'explore-schema', arguments: {} },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).to.equal(-32602);
    });

    it('rejects prompts/get for an unknown prompt', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'prompts/get',
        params: { name: 'nope' },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).to.equal(-32602);
    });
  });

  describe('NexqlMcpServer Monitoring Tools', () => {
    it('maps a missing pg_stat_statements extension to a friendly hint', async () => {
      const info = await server.start();
      poolClientStub.query
        .withArgs(sinon.match(/pg_stat_statements/))
        .rejects(new Error('relation "pg_stat_statements" does not exist'));

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'slow_queries', arguments: {} },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      const result = JSON.parse(parsed.result.content[0].text);
      expect(result.error).to.contain('pg_stat_statements');
      expect(result.hint).to.contain('CREATE EXTENSION');
    });

    it('runs explain_analyze inside a read-only transaction that rolls back', async () => {
      const info = await server.start();
      poolClientStub.query
        .withArgs(sinon.match(/^EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/))
        .resolves({ rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result' } }] }] });

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'explain_analyze', arguments: { sql: 'SELECT 1' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.false;

      const calls = poolClientStub.query.getCalls().map((c: any) => String(c.args[0]));
      const beginIdx = calls.indexOf('BEGIN');
      const readOnlyIdx = calls.indexOf('SET TRANSACTION READ ONLY');
      const explainIdx = calls.findIndex((c: string) => c.startsWith('EXPLAIN (ANALYZE'));
      const rollbackIdx = calls.indexOf('ROLLBACK');
      expect(beginIdx).to.be.greaterThan(-1);
      expect(readOnlyIdx).to.be.greaterThan(beginIdx);
      expect(explainIdx).to.be.greaterThan(readOnlyIdx);
      expect(rollbackIdx).to.be.greaterThan(explainIdx);
    });

    it('rejects explain_analyze for non-SELECT statements', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'explain_analyze', arguments: { sql: 'DELETE FROM users' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.true;
      expect(JSON.parse(parsed.result.content[0].text).error).to.contain('Security Error');
    });

    it('returns plan metrics and recommendations from analyze_query_plan', async () => {
      const info = await server.start();
      poolClientStub.query
        .withArgs(sinon.match(/^EXPLAIN \(FORMAT JSON\)/))
        .resolves({
          rows: [{
            'QUERY PLAN': [{
              Plan: { 'Node Type': 'Seq Scan', 'Total Cost': 100, 'Relation Name': 'users' }
            }]
          }]
        });

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'analyze_query_plan', arguments: { sql: 'SELECT 1' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.false;
      const result = JSON.parse(parsed.result.content[0].text);
      expect(result.metrics).to.be.an('object');
      expect(result.metrics.sequentialScans).to.equal(1);
      expect(result.plan).to.be.an('array');
    });

    it('runs db_health_check and returns partial results when a section fails', async () => {
      const info = await server.start();
      poolClientStub.query.withArgs(sinon.match(/pg_database/)).rejects(new Error('boom'));

      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'db_health_check', arguments: {} },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      const report = JSON.parse(parsed.result.content[0].text);
      expect(report.overview).to.have.property('error');
      expect(report.connection_states).to.be.an('array');
      expect(report).to.have.property('blocking_lock_count');
    });

    it('validates table refs for table_stats', async () => {
      const info = await server.start();
      const res = await postRequest(info.port, info.token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'table_stats', arguments: { ref: 'public.users; DROP TABLE x' } },
        id: 1
      });
      const parsed = JSON.parse(res.body);
      expect(parsed.result.isError).to.be.true;
      expect(JSON.parse(parsed.result.content[0].text).error).to.contain('Invalid object reference');
    });
  });
});
