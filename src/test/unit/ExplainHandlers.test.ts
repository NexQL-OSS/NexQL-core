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

describe('ExplainHandlers', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    sandbox.stub(console, 'error');
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

  it('ShowExplainPlanHandler calls ExplainProvider.show', async () => {
    const show = sandbox.stub(ExplainProvider, 'show');
    const uri = vscode.Uri.file('/ext');
    const handler = new ShowExplainPlanHandler(uri);
    await handler.handle({ plan: { Plan: {} }, query: 'SELECT 1' });
    expect(show.calledOnce).to.be.true;
  });

  it('ConvertExplainHandler shows error when query missing', async () => {
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext);
    await handler.handle({ query: '' }, { editor: {} as vscode.NotebookEditor });
    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('No query available to convert')).to.be
      .true;
  });

  it('ConvertExplainHandler shows error when connection not in settings', async () => {
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext);
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
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext);
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
    const handler = new ConvertExplainHandler({ extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext);
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
    const poolQuery = sandbox.stub().resolves({
      rows: [{ 'QUERY PLAN': JSON.stringify(planJson) }]
    });
    const poolEnd = sandbox.stub().resolves();
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      () => ({ query: poolQuery, end: poolEnd } as unknown as Pool)
    );

    const show = sandbox.stub(ExplainProvider, 'show');

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(poolQuery.calledOnce).to.be.true;
    expect(show.calledOnce).to.be.true;
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
    const poolQuery = sandbox.stub().resolves({
      rows: [{ query_plan: planObj }]
    });
    const poolEnd = sandbox.stub().resolves();
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      () => ({ query: poolQuery, end: poolEnd } as unknown as Pool)
    );
    const show = sandbox.stub(ExplainProvider, 'show');

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(show.calledOnce).to.be.true;
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

    const poolQuery = sandbox.stub().resolves({
      rows: [{ 'QUERY PLAN': JSON.stringify([{ Plan: { 'Node Type': 'Result' } }]) }]
    });
    const poolEnd = sandbox.stub().resolves();
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      () => ({ query: poolQuery, end: poolEnd } as unknown as Pool)
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
    const poolQueryEmpty = sandbox.stub().resolves({ rows: [] });
    const poolEndEmpty = sandbox.stub().resolves();
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      () => ({ query: poolQueryEmpty, end: poolEndEmpty } as unknown as Pool)
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
    const poolQueryNoPlan = sandbox.stub().resolves({ rows: [{ other: 1 }] });
    const poolEndNoPlan = sandbox.stub().resolves();
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      () => ({ query: poolQueryNoPlan, end: poolEndNoPlan } as unknown as Pool)
    );

    await handler.handle(
      { query: 'EXPLAIN SELECT 1' },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1', databaseName: 'postgres' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(poolQueryNoPlan.calledOnce).to.be.true;
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
    const poolQueryFail = sandbox.stub().rejects(new Error('connection refused'));
    const poolEndFail = sandbox.stub().resolves();
    const handler = new ConvertExplainHandler(
      { extensionUri: vscode.Uri.file('/e') } as vscode.ExtensionContext,
      () => ({ query: poolQueryFail, end: poolEndFail } as unknown as Pool)
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
