import { expect } from 'chai';
import * as sinon from 'sinon';
import type { Pool } from 'pg';
import * as vscode from 'vscode';
import { ExplainProvider } from '../../providers/ExplainProvider';
import {
  AnalyzeDataHandler,
  ConvertExplainHandler,
  ExplainErrorHandler,
  FixQueryHandler,
  OptimizeQueryHandler,
  SendToChatHandler,
  ShowExplainPlanHandler
} from '../../services/handlers/ExplainHandlers';
import { SecretStorageService } from '../../services/SecretStorageService';
import { ConnectionManager } from '../../services/ConnectionManager';
import { PlanStudioPanel } from '../../features/planStudio/PlanStudioPanel';
import { LicenseService } from '../../services/LicenseService';

describe('ExplainHandlers', () => {
  let sandbox: sinon.SinonSandbox;
  let mockPlanStore: any;
  let poolQuery: sinon.SinonStub;
  let clientMock: any;
  let getPooledClientStub: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    sandbox.stub(console, 'error');
    sandbox.stub(LicenseService, 'getInstance').returns({
      getTier: () => 'singularity'
    } as any);
    sandbox.stub(PlanStudioPanel, 'show').resolves(undefined);

    mockPlanStore = {
      savePlan: sandbox.stub().returns({ id: 'saved-plan-id' }),
      linkPlanToNotebook: sandbox.stub(),
    } as any;

    poolQuery = sandbox.stub();
    clientMock = {
      query: poolQuery,
      release: sandbox.stub(),
    };

    getPooledClientStub = sandbox.stub(ConnectionManager.getInstance(), 'getPooledClient').resolves(clientMock as any);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('ExplainErrorHandler delegates to chat provider when defined', async () => {
    const handleExplainError = sandbox.stub().resolves();
    const chat = { handleExplainError } as any;
    const handler = new ExplainErrorHandler(chat);
    await handler.handle({ error: 'e', query: 'q' });
    expect(handleExplainError.calledWith('e', 'q')).to.be.true;
  });

  it('ExplainErrorHandler no-ops when chat is undefined', async () => {
    const handler = new ExplainErrorHandler(undefined);
    await handler.handle({ error: 'e', query: 'q' });
  });

  it('FixQueryHandler delegates', async () => {
    const handleFixQuery = sandbox.stub().resolves();
    const handler = new FixQueryHandler({ handleFixQuery } as any);
    await handler.handle({ error: 'e', query: 'q' });
    expect(handleFixQuery.calledOnce).to.be.true;
  });

  it('AnalyzeDataHandler delegates', async () => {
    const handleAnalyzeData = sandbox.stub().resolves();
    const handler = new AnalyzeDataHandler({ handleAnalyzeData } as any);
    await handler.handle({ data: [], query: 'q', rowCount: 1 });
    expect(handleAnalyzeData.calledOnce).to.be.true;
  });

  it('OptimizeQueryHandler delegates', async () => {
    const handleOptimizeQuery = sandbox.stub().resolves();
    const handler = new OptimizeQueryHandler({ handleOptimizeQuery } as any);
    await handler.handle({ query: 'q', executionTime: 1 });
    expect(handleOptimizeQuery.calledOnce).to.be.true;
  });

  it('SendToChatHandler delegates to chat provider (focus is handled by AssistantGateway/ChatSurfaceRegistry)', async () => {
    const sendToChat = sandbox.stub().resolves();
    const handler = new SendToChatHandler({ sendToChat } as any);
    await handler.handle({ data: { x: 1 } });
    expect(sendToChat.calledWith({ x: 1 })).to.be.true;
  });

  it('ShowExplainPlanHandler calls PlanStudioPanel.show', async () => {
    const show = PlanStudioPanel.show as sinon.SinonStub;
    const uri = vscode.Uri.file('/ext');
    const mockPlanStore = {} as any;
    const handler = new ShowExplainPlanHandler(uri, mockPlanStore);
    await handler.handle({ plan: { Plan: {} }, query: 'SELECT 1' });
    expect(show.calledOnce).to.be.true;
  });

  it('ConvertExplainHandler shows error when query missing', async () => {
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext, mockPlanStore);
    await handler.handle({ query: '' }, { editor: {} as vscode.NotebookEditor });
    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('No query available to convert')).to.be
      .true;
  });

  it('ConvertExplainHandler shows error when connection not in settings', async () => {
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext, mockPlanStore);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) => (k === 'postgresExplorer.connections' ? [] : undefined)
    });

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'missing' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('No active database connection')).to.be
      .true;
  });

  it('ConvertExplainHandler shows error when password missing for password auth', async () => {
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext, mockPlanStore);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) =>
          k === 'postgresExplorer.connections'
            ? [{ id: 'c1', host: 'h', port: 5432, username: 'u', authMode: 'password' }]
            : undefined
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves(undefined)
    } as unknown as SecretStorageService);

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('Password not found for connection')).to
      .be.true;
  });

  it('ConvertExplainHandler returns early when editor is missing', async () => {
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext, mockPlanStore);
    await handler.handle({ query: 'EXPLAIN SELECT 1' }, { editor: undefined } as any);
    expect((vscode.window.showErrorMessage as sinon.SinonStub).callCount).to.equal(0);
  });

  it('ConvertExplainHandler runs EXPLAIN FORMAT JSON and shows plan', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) =>
        k === 'postgresExplorer.connections'
          ? [{ id: 'c1', host: 'h', port: 5432, username: 'u', authMode: 'password', ssl: false }]
          : undefined
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves('secret')
    } as unknown as SecretStorageService);

    const planJson = [{ Plan: { 'Node Type': 'Result' } }];
    poolQuery.resolves({
      rows: [{ 'QUERY PLAN': JSON.stringify(planJson) }]
    });
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      mockPlanStore
    );

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(poolQuery.calledOnce).to.be.true;
  });

  it('ConvertExplainHandler uses object plan cell without JSON.parse', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) =>
        k === 'postgresExplorer.connections'
          ? [{ id: 'c1', host: 'h', port: 5432, username: 'u', authMode: 'password', ssl: false }]
          : undefined
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves('x')
    } as unknown as SecretStorageService);
    const planObj = [{ Plan: { 'Node Type': 'Seq Scan' } }];
    poolQuery.resolves({
      rows: [{ query_plan: planObj }]
    });
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      mockPlanStore
    );

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(poolQuery.calledOnce).to.be.true;
  });

  it('ConvertExplainHandler strips EXPLAIN ANALYZE prefix before JSON conversion', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) =>
        k === 'postgresExplorer.connections'
          ? [{ id: 'c1', host: 'h', port: 5432, username: 'u', authMode: 'password', ssl: false }]
          : undefined
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves('secret')
    } as unknown as SecretStorageService);

    poolQuery.resolves({
      rows: [{ 'QUERY PLAN': JSON.stringify([{ Plan: { 'Node Type': 'Result' } }]) }]
    });
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      mockPlanStore
    );

    await handler.handle(
      { query: 'EXPLAIN ANALYZE SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(poolQuery.calledOnce).to.be.true;
    const executedSql = String(poolQuery.firstCall.args[0]);
    expect(executedSql).to.match(/^EXPLAIN \(FORMAT JSON, ANALYZE, BUFFERS, VERBOSE\)/);
    expect(executedSql).to.contain('SELECT 1');
    expect(executedSql).to.not.match(/\n\s*ANALYZE\b/);
  });

  it('ConvertExplainHandler shows error when EXPLAIN returns no rows', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) =>
        k === 'postgresExplorer.connections'
          ? [{ id: 'c1', host: 'h', port: 5432, username: 'u', ssl: false }]
          : undefined
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves(undefined)
    } as unknown as SecretStorageService);
    poolQuery.resolves({ rows: [] });
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      mockPlanStore
    );

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('No results returned from EXPLAIN query')).to.be
      .true;
  });

  it('ConvertExplainHandler shows error when row has no plan column', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) =>
        k === 'postgresExplorer.connections'
          ? [{ id: 'c1', host: 'h', port: 5432, username: 'u', ssl: false }]
          : undefined
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves(undefined)
    } as unknown as SecretStorageService);
    poolQuery.resolves({ rows: [{ other: 1 }] });
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      mockPlanStore
    );

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(poolQuery.calledOnce).to.be.true;
    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('No plan data returned from query')).to.be.true;
  });

  it('ConvertExplainHandler shows error when pool query throws', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (k: string) =>
        k === 'postgresExplorer.connections'
          ? [{ id: 'c1', host: 'h', port: 5432, username: 'u', ssl: false }]
          : undefined
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves(undefined)
    } as unknown as SecretStorageService);
    poolQuery.rejects(new Error('connection refused'));
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      mockPlanStore
    );

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    const showErr = vscode.window.showErrorMessage as sinon.SinonStub;
    expect(showErr.called).to.be.true;
    const msg = String(showErr.firstCall.args[0]);
    expect(msg).to.match(/Failed to convert EXPLAIN query/);
    expect(msg).to.match(/connection refused/);
  });
});
