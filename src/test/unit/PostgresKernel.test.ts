import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { PostgresKernel } from '../../providers/NotebookKernel';
import { ConnectionManager } from '../../services/ConnectionManager';
import { QueryPerformanceService } from '../../services/QueryPerformanceService';
import { QueryHistoryService } from '../../services/QueryHistoryService';

const notebookUri = { toString: () => 'vscode-notebook:test-nb' };

function nb(metadata: Record<string, unknown>) {
  return { metadata, uri: notebookUri };
}

function decodeCellOutputData(data: unknown): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString('utf8');
  }
  return String(data);
}

/** Client stub: handles pg_backend_pid probe then delegates to row result for SELECTs */
function makePgClient(
  sandbox: sinon.SinonSandbox,
  dataResolver?: (sql: string) => Promise<{ rows: any[]; fields?: { name: string }[]; command?: string; rowCount?: number }>
) {
  const query = sandbox.stub();
  query.callsFake((sql: string) => {
    if (typeof sql === 'string' && sql.includes('pg_backend_pid')) {
      return Promise.resolve({ rows: [{ pg_backend_pid: 12345 }] });
    }
    if (dataResolver) {
      return dataResolver(sql);
    }
    return Promise.resolve({
      rows: [{ id: 1, name: 'Test' }],
      fields: [{ name: 'id' }, { name: 'name' }]
    });
  });
  return { query, on: sandbox.stub(), release: sandbox.stub(), removeListener: sandbox.stub() };
}

describe('PostgresKernel', () => {
  let sandbox: sinon.SinonSandbox;
  let contextStub: any;
  let controllerStub: any;
  let connectionManagerStub: any;
  let configGetStub: sinon.SinonStub;
  let messagingStub: { postMessage: sinon.SinonStub };
  let connectionList: any[];

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    connectionList = [];
    messagingStub = { postMessage: sandbox.stub().resolves() };
    contextStub = {
      subscriptions: []
    };
    controllerStub = {
      id: 'test-controller',
      createNotebookCellExecution: sandbox.stub().returns({
        start: sandbox.stub(),
        appendOutput: sandbox.stub(),
        replaceOutput: sandbox.stub(),
        end: sandbox.stub(),
        clearOutput: sandbox.stub()
      }),
      supportedLanguages: [],
      supportsExecutionOrder: false,
      description: '',
      executeHandler: undefined,
      onDidReceiveMessage: sandbox.stub()
    };

    // Mock vscode.notebooks.createNotebookController
    sandbox.stub(vscode.notebooks, 'createNotebookController').returns(controllerStub);

    // Mock ConnectionManager (SqlExecutor uses session + pooled clients)
    const sessionStub = sandbox.stub();
    connectionManagerStub = {
      getSessionClient: sessionStub,
      getPooledClient: sessionStub
    };
    sandbox.stub(ConnectionManager, 'getInstance').returns(connectionManagerStub);

    sandbox.stub(QueryPerformanceService, 'getInstance').returns({
      getBaseline: () => null,
      recordExecution: sandbox.stub().resolves()
    } as any);

    sandbox.stub(QueryHistoryService, 'getInstance').returns({
      add: sandbox.stub().resolves()
    } as any);

    // Mock vscode.workspace.getConfiguration — avoid returning connection[] for unrelated keys (auto-limit reads numeric defaults)
    configGetStub = sandbox.stub().callsFake((key: string, defaultValue?: unknown) => {
      if (key === 'postgresExplorer.connections') {
        return connectionList;
      }
      if (key === 'postgresExplorer.query.autoLimitEnabled') {
        return false;
      }
      if (key === 'postgresExplorer.performance.defaultLimit') {
        return typeof defaultValue === 'number' ? defaultValue : 1000;
      }
      if (key === 'postgresExplorer.performance.slowQueryThresholdMs') {
        return typeof defaultValue === 'number' ? defaultValue : 2000;
      }
      return defaultValue;
    });
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: configGetStub
    } as any);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should initialize correctly', () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);
    expect(kernel.supportedLanguages).to.include('sql');
    expect(controllerStub.supportsExecutionOrder).to.be.true;
  });

  it('should handle execution failure when no connection metadata', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);
    const cell: any = {
      notebook: nb({}),
      document: { uri: { toString: () => 'cell-uri' } }
    };

    await (kernel as any)._executor.executeCell(cell);

    const execution = controllerStub.createNotebookCellExecution.firstCall.returnValue;
    expect(execution.end.calledWith(false)).to.be.true;
    expect(execution.replaceOutput.called).to.be.true;
  });

  it('should execute query successfully', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);
    const cell: any = {
      notebook: nb({ connectionId: 'test-conn' }),
      document: {
        uri: { toString: () => 'cell-uri' },
        getText: () => 'SELECT * FROM users'
      }
    };

    const connectionConfig = {
      id: 'test-conn',
      name: 'Test DB',
      host: 'localhost',
      port: 5432,
      username: 'user',
      database: 'db'
    };
    connectionList = [connectionConfig];

    const clientStub = makePgClient(sandbox, async () => ({
      rows: [{ id: 1, name: 'Test' }],
      fields: [{ name: 'id' }, { name: 'name' }]
    }));
    connectionManagerStub.getSessionClient.resolves(clientStub);

    await (kernel as any)._executor.executeCell(cell);

    const execution = controllerStub.createNotebookCellExecution.firstCall.returnValue;
    expect(execution.end.calledWith(true)).to.be.true;
    expect(execution.appendOutput.called).to.be.true;

    const allCalls = execution.appendOutput.getCalls();
    const notebookOut = allCalls.map((c: any) => c.args[0]).find((out: any) =>
      out.items[0].mime === 'application/vnd.postgres-notebook.result'
    );
    expect(notebookOut).to.exist;
    const payload = JSON.parse(decodeCellOutputData(notebookOut.items[0].data));
    expect(payload.rows[0].name).to.equal('Test');
  });

  it('should format complex objects in query results', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);
    const cell: any = {
      notebook: nb({ connectionId: 'test-conn' }),
      document: {
        uri: { toString: () => 'cell-uri' },
        getText: () => 'SELECT * FROM complex'
      }
    };

    const connectionConfig = {
      id: 'test-conn',
      name: 'Test DB',
      host: 'localhost',
      port: 5432,
      username: 'user',
      database: 'db'
    };
    connectionList = [connectionConfig];

    const clientStub = makePgClient(sandbox, async () => ({
      rows: [{ data: { foo: 'bar' }, nullVal: null }],
      fields: [{ name: 'data' }, { name: 'nullVal' }]
    }));
    connectionManagerStub.getSessionClient.resolves(clientStub);

    await (kernel as any)._executor.executeCell(cell);

    const execution = controllerStub.createNotebookCellExecution.firstCall.returnValue;
    const allCalls = execution.appendOutput.getCalls();
    const notebookOut = allCalls.map((c: any) => c.args[0]).find((out: any) =>
      out.items[0].mime === 'application/vnd.postgres-notebook.result'
    );
    expect(notebookOut).to.exist;
    const payload = JSON.parse(decodeCellOutputData(notebookOut.items[0].data));
    expect(JSON.stringify(payload.rows[0].data)).to.contain('"foo":"bar"');
  });

  it('should execute all cells', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);
    const cell1: any = {
      notebook: nb({ connectionId: 'test-conn' }),
      document: {
        uri: { toString: () => 'cell-uri-1' },
        getText: () => 'SELECT 1'
      }
    };
    const cell2: any = {
      notebook: nb({ connectionId: 'test-conn' }),
      document: {
        uri: { toString: () => 'cell-uri-2' },
        getText: () => 'SELECT 2'
      }
    };

    const connectionConfig = {
      id: 'test-conn',
      name: 'Test DB',
      host: 'localhost',
      port: 5432,
      username: 'user',
      database: 'db'
    };
    connectionList = [connectionConfig];

    const clientStub = makePgClient(sandbox, async () => ({ rows: [], fields: [] }));
    connectionManagerStub.getSessionClient.resolves(clientStub);

    // Trigger executeHandler
    await controllerStub.executeHandler([cell1, cell2], {}, controllerStub);

    expect(controllerStub.createNotebookCellExecution.calledTwice).to.be.true;
  });

  it('should execute DDL command successfully', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);
    const cell: any = {
      notebook: nb({ connectionId: 'test-conn' }),
      document: {
        uri: { toString: () => 'cell-uri' },
        getText: () => 'CREATE TABLE test (id int)'
      }
    };

    const connectionConfig = {
      id: 'test-conn',
      name: 'Test DB',
      host: 'localhost',
      port: 5432,
      username: 'user',
      database: 'db'
    };
    connectionList = [connectionConfig];

    const clientStub = makePgClient(sandbox, async () => ({
      command: 'CREATE',
      rowCount: 0,
      rows: [],
      fields: []
    }));
    connectionManagerStub.getSessionClient.resolves(clientStub);

    await (kernel as any)._executor.executeCell(cell);

    const execution = controllerStub.createNotebookCellExecution.firstCall.returnValue;
    expect(execution.end.calledWith(true)).to.be.true;
    const allCalls = execution.appendOutput.getCalls();
    const notebookOut = allCalls.map((c: any) => c.args[0]).find((out: any) =>
      out.items[0].mime === 'application/vnd.postgres-notebook.result'
    );
    expect(notebookOut).to.exist;
    const payload = JSON.parse(decodeCellOutputData(notebookOut.items[0].data));
    expect(payload.success).to.be.true;
    expect(payload.command).to.equal('CREATE');
  });

  it('should provide SQL keyword completions', async () => {
    const providers: any[] = [];
    sandbox.stub(vscode.languages, 'registerCompletionItemProvider').callsFake((_selector, provider) => {
      providers.push(provider);
      return { dispose: sandbox.stub() };
    });

    new PostgresKernel(contextStub, messagingStub as any);
    const completionProvider = providers[0];

    const document: any = {
      lineAt: () => ({ text: 'SEL', substr: () => 'sel' }),
      getWordRangeAtPosition: () => undefined,
      getText: () => 'sel'
    };
    const position: any = { character: 3 };

    const items = await completionProvider.provideCompletionItems(document, position);
    expect(items).to.be.an('array');
    expect(items.find((i: any) => i.label === 'SELECT')).to.exist;
  });

  it('should provide simple SQL command completions', async () => {
    const providers: any[] = [];
    sandbox.stub(vscode.languages, 'registerCompletionItemProvider').callsFake((_selector, provider) => {
      providers.push(provider);
      return { dispose: sandbox.stub() };
    });

    new PostgresKernel(contextStub, messagingStub as any);
    const completionProvider = providers[0];

    const document: any = {
      lineAt: () => ({ text: '', substr: () => '' }), // Empty line
      getWordRangeAtPosition: () => undefined,
      getText: () => ''
    };
    const position: any = { character: 0 };

    const items = await completionProvider.provideCompletionItems(document, position);
    expect(items).to.be.an('array');
    expect(items.length).to.be.greaterThan(0);
    expect(items.find((i: any) => i.label === 'SELECT')).to.exist;
  });

  it('should handle serialization errors in query results', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);

    const cell: any = {
      document: {
        getText: () => 'SELECT * FROM users',
        uri: { toString: () => 'test-cell-uri' }
      },
      notebook: nb({ connectionId: 'test-conn' })
    };

    connectionList = [{ id: 'test-conn', host: 'localhost', port: 5432, username: 'user', database: 'db' }];

    const problematic: any = { a: BigInt(1) };

    const clientStub = makePgClient(sandbox, async () => ({
      rows: [{ id: 1, data: problematic }],
      fields: [{ name: 'id' }, { name: 'data' }]
    }));
    connectionManagerStub.getSessionClient.resolves(clientStub);

    await (kernel as any)._executor.executeCell(cell);

    const execution = controllerStub.createNotebookCellExecution.firstCall.returnValue;
    expect(execution.appendOutput.called).to.be.true;
    const allCalls = execution.appendOutput.getCalls();
    const notebookOut = allCalls.map((c: any) => c.args[0]).find((out: any) =>
      out.items[0].mime === 'application/vnd.postgres-notebook.error'
    );
    expect(notebookOut).to.exist;
    expect(notebookOut.items[0].mime).to.equal('application/vnd.postgres-notebook.error');
    const errPayload = JSON.parse(decodeCellOutputData(notebookOut.items[0].data));
    expect(errPayload.success).to.equal(false);
  });

  it('should handle connection errors gracefully', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);

    const cell: any = {
      document: { getText: () => 'SELECT 1', uri: { toString: () => 'cell' } },
      notebook: nb({ connectionId: 'test-conn' })
    };

    connectionList = [{ id: 'test-conn', host: 'localhost', port: 5432, username: 'user', database: 'db' }];

    connectionManagerStub.getSessionClient.rejects(new Error('Connection failed'));

    await (kernel as any)._executor.executeCell(cell);

    const execution = controllerStub.createNotebookCellExecution.firstCall.returnValue;
    expect(execution.end.calledWith(false)).to.be.true;
  });

  it('should handle missing connection configuration in execution', async () => {
    const kernel = new PostgresKernel(contextStub, messagingStub as any);

    const cell: any = {
      document: { getText: () => 'SELECT 1', uri: { toString: () => 'cell' } },
      notebook: nb({ connectionId: 'missing-conn' })
    };

    connectionList = [{ id: 'test-conn', host: 'localhost', port: 5432, username: 'user' }];

    await (kernel as any)._executor.executeCell(cell);

    const execution = controllerStub.createNotebookCellExecution.firstCall.returnValue;
    expect(execution.end.calledWith(false)).to.be.true;
  });

  it('should return the same keyword list for arbitrary SQL context (CompletionProvider is keyword-only)', async () => {
    const providers: any[] = [];
    sandbox.stub(vscode.languages, 'registerCompletionItemProvider').callsFake((_selector, provider) => {
      providers.push(provider);
      return { dispose: sandbox.stub() };
    });

    new PostgresKernel(contextStub, messagingStub as any);
    const completionProvider = providers[0];

    const document: any = {
      lineAt: () => ({ text: 'public.', substr: () => 'public.' }),
      getWordRangeAtPosition: () => undefined,
      getText: () => 'SELECT * FROM public.'
    };
    const position: any = { character: 7 };

    const items = await completionProvider.provideCompletionItems(document, position, {} as any, {} as any);
    expect(items).to.be.an('array');
    expect(items.length).to.be.at.least(25);
    expect(items.find((i: any) => i.label === 'FROM')).to.exist;
  });
});
