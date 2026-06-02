import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { ChatViewProvider } from '../../providers/ChatViewProvider';
import { ErrorService } from '../../services/ErrorService';
import { QueryAnalyzer } from '../../services/QueryAnalyzer';
import { AiModelCatalogService } from '../../features/aiAssistant/AiModelCatalogService';
import * as aiConfig from '../../features/aiAssistant/aiConfig';

function createExtensionContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/ext'),
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: () => undefined,
      update: async () => undefined
    } as any,
    globalState: {
      get: () => [],
      update: async () => undefined
    } as any,
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }
  } as any;
}

function createProviderHarness(sandbox: sinon.SinonSandbox) {
  const provider = new ChatViewProvider(vscode.Uri.file('/ext'), createExtensionContext());

  const postMessage = sandbox.stub().resolves(true);
  (provider as any)._view = { show: sandbox.stub(), webview: { postMessage } };

  const aiService = {
    getModelInfo: sandbox.stub().resolves('Mock AI'),
    callProvider: sandbox.stub().callsFake(async (provider: string, message: string, config: any, systemPrompt?: string) => {
      if (provider === 'vscode-lm') {
        return await aiService.callVsCodeLm(message, config, systemPrompt);
      }
      return await aiService.callDirectApi(provider, message, config, systemPrompt);
    }),
    callVsCodeLm: sandbox.stub().resolves({ text: 'SELECT 1;', usage: 'usage' }),
    callDirectApi: sandbox.stub(),
    // v1.4.0: ChatViewProvider selects a capability-specific system prompt and passes it
    // through as customSystemPrompt. Echo the capability so call-site threading is observable.
    buildSystemPrompt: sandbox.stub().callsFake((capability: string = 'chat') => `SYSTEM[${capability}]`),
    setMessages: sandbox.stub(),
    generateTitle: sandbox.stub().resolves('Generated title'),
    cancel: sandbox.stub()
  };

  const sessionService = {
    saveSession: sandbox.stub().resolves(),
    clearCurrentSession: sandbox.stub(),
    getSessionSummaries: sandbox.stub().returns([]),
    loadSession: sandbox.stub(),
    deleteSession: sandbox.stub().resolves(false)
  };

  (provider as any)._aiService = aiService;
  (provider as any)._sessionService = sessionService;

  return { provider, postMessage, aiService, sessionService };
}

function createWebviewViewHarness(sandbox: sinon.SinonSandbox) {
  let messageHandler: ((message: any) => any) | undefined;

  const postMessage = sandbox.stub().resolves(true);
  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: sandbox.stub().callsFake((uri: vscode.Uri) => uri),
      postMessage,
      onDidReceiveMessage: sandbox.stub().callsFake((handler: (message: any) => any) => {
        messageHandler = handler;
        return { dispose: () => undefined };
      })
    },
    show: sandbox.stub(),
    reveal: sandbox.stub()
  } as any;

  return {
    view,
    postMessage,
    getMessageHandler: () => messageHandler
  };
}

describe('ChatViewProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let setStatusBarMessageStub: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(AiModelCatalogService, 'getInstance').returns({
      buildChatCatalog: sandbox.stub().resolves({
        catalog: [],
        activeSelectionId: 'vscode-lm:default',
        activeModelLabel: 'VS Code LM',
      }),
      invalidateCache: sandbox.stub(),
    } as any);
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
      if (section === 'postgresExplorer') {
        return {
          get: (key: string, defaultValue?: unknown) => {
            if (
              key === 'aiProvider' ||
              key === 'ai.chat.provider' ||
              key === 'ai.notebook.provider'
            ) {
              return 'vscode-lm';
            }
            if (key === 'aiModel' || key === 'ai.chat.model' || key === 'ai.notebook.model') {
              return '';
            }
            return defaultValue;
          },
          update: sandbox.stub().resolves(),
        } as any;
      }
      return {
        get: () => undefined
      } as any;
    });

    setStatusBarMessageStub = sandbox.stub();
    (vscode.window as any).setStatusBarMessage = setStatusBarMessageStub;
  });

  afterEach(() => {
    sandbox.restore();
    delete (vscode.window as any).setStatusBarMessage;
  });

  it('drives the AI message pipeline for fix query requests', async () => {
    const { provider, postMessage, aiService, sessionService } = createProviderHarness(sandbox);

    await provider.handleFixQuery('syntax error at or near FROM', 'SELECT * FROM users');

    expect((provider as any)._messages).to.have.lengthOf(2);
    expect((provider as any)._messages[0].role).to.equal('user');
    expect((provider as any)._messages[1].role).to.equal('assistant');
    expect((provider as any)._messages[1].content).to.equal('SELECT 1;');

    expect(aiService.getModelInfo.calledTwice).to.be.true;
    expect(aiService.callVsCodeLm.calledOnce).to.be.true;
    const prompt = aiService.callVsCodeLm.firstCall.args[0] as string;
    expect(prompt).to.contain('Fix this SQL query which caused an error');
    expect(prompt).to.contain('SELECT * FROM users');
    expect(prompt).to.contain('syntax error at or near FROM');
    expect(aiService.setMessages.calledOnce).to.be.true;
    expect(sessionService.saveSession.calledOnce).to.be.true;
    expect(postMessage.callCount).to.be.greaterThan(0);
  });

  it('builds prompt strings for explain, optimize, and generate query flows', async () => {
    const { provider } = createProviderHarness(sandbox);
    const handleUserMessage = sandbox.stub().resolves();
    (provider as any)._handleUserMessage = handleUserMessage;

    await provider.handleExplainError('relation "users" does not exist', 'SELECT * FROM users');
    await provider.handleOptimizeQuery('SELECT * FROM users', 12.345);
    await provider.handleGenerateQuery('find active users', [
      { type: 'table', schema: 'public', name: 'users', columns: ['id', 'email'] },
      { type: 'function', schema: 'public', name: 'calc_total' }
    ]);
    await provider.handleGenerateQuery('find active users');

    expect(handleUserMessage.callCount).to.equal(4);
    expect(handleUserMessage.getCall(0).args[0]).to.contain('I ran this SQL query:');
    expect(handleUserMessage.getCall(0).args[0]).to.contain('relation "users" does not exist');
    expect(handleUserMessage.getCall(1).args[0]).to.contain('Optimize this SQL query:');
    expect(handleUserMessage.getCall(1).args[0]).to.contain('12.345ms');
    // v1.4.0: quick actions thread a capability tag as the 4th arg.
    expect(handleUserMessage.getCall(1).args[3]).to.equal('optimizeQuery');
    expect(handleUserMessage.getCall(0).args[3]).to.equal('explainError');
    expect(handleUserMessage.getCall(2).args[3]).to.equal('generateQuery');
    expect(handleUserMessage.getCall(2).args[0]).to.contain('Please generate a SQL query for the following request');
    expect(handleUserMessage.getCall(2).args[0]).to.contain('TABLE: public.users');
    expect(handleUserMessage.getCall(2).args[0]).to.contain('FUNCTION: public.calc_total');
    expect(handleUserMessage.getCall(3).args[0]).to.contain('No specific schema context provided');
  });

  it('builds analysis prompts and falls back when temp file creation fails', async () => {
    const { provider } = createProviderHarness(sandbox);
    const handleUserMessage = sandbox.stub().resolves();
    (provider as any)._handleUserMessage = handleUserMessage;

    const writeFileStub = sandbox.stub(fs.promises, 'writeFile').resolves();
    await provider.handleAnalyzeData('id,name\n1,Alice', 'SELECT * FROM users', 2);

    expect(handleUserMessage.calledOnce).to.be.true;
    expect(handleUserMessage.firstCall.args[0]).to.contain('It returned 2 rows. I have attached the data as a CSV file.');
    expect(handleUserMessage.firstCall.args[1]).to.have.lengthOf(1);
    expect(handleUserMessage.firstCall.args[1][0]).to.include({ type: 'csv', content: 'id,name\n1,Alice' });

    handleUserMessage.resetHistory();
    writeFileStub.rejects(new Error('disk full'));
    const showError = sandbox.stub();
    sandbox.stub(ErrorService, 'getInstance').returns({ showError } as any);

    await provider.handleAnalyzeData('id,name\n1,Alice', 'SELECT * FROM users', 2);

    expect(showError.calledOnce).to.be.true;
    expect(handleUserMessage.calledOnce).to.be.true;
    expect(handleUserMessage.firstCall.args[0]).to.contain('Here is the data:');
    expect(handleUserMessage.firstCall.args[1]).to.be.undefined;
  });

  it('builds explain result and why slow prompts from execution context', async () => {
    const { provider } = createProviderHarness(sandbox);
    const handleUserMessage = sandbox.stub().resolves();
    (provider as any)._handleUserMessage = handleUserMessage;

    const metrics = {
      totalCost: 123.45,
      planningTime: 1.23,
      executionTime: 4.56,
      sequentialScans: 2,
      indexScans: 1,
      bufferStats: { hitRatio: 98.1 },
      bottlenecks: ['Seq Scan on users'],
      recommendations: ['Add an index on users.id']
    };
    sandbox.stub(QueryAnalyzer, 'getInstance').returns({
      extractPlanMetrics: sandbox.stub().returns(metrics)
    } as any);

    const explainPlan = { Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 10 } };
    await provider.handleExplainResult('SELECT * FROM users', 5.5, 10, explainPlan);
    await provider.handleWhySlow(
      'SELECT * FROM users',
      20,
      5,
      explainPlan,
      [{ table: 'users', rows: 100, deadRows: 5, lastVacuum: '2026-01-01' }]
    );

    expect(handleUserMessage.callCount).to.equal(2);
    expect(handleUserMessage.getCall(0).args[0]).to.contain('Performance Metrics:');
    expect(handleUserMessage.getCall(0).args[0]).to.contain('Buffer Hit Ratio: 98.1%');
    expect(handleUserMessage.getCall(0).args[0]).to.contain('Execution Plan (JSON)');
    expect(handleUserMessage.getCall(1).args[0]).to.contain('Historical Average: 5.000ms');
    expect(handleUserMessage.getCall(1).args[0]).to.contain('Affected Table Statistics:');
    expect(handleUserMessage.getCall(1).args[0]).to.contain('users: 100 rows, 5 dead rows, last vacuum 2026-01-01');
  });

  it('resolves the webview and routes control messages to the expected handlers', async () => {
    const { provider, postMessage, aiService, sessionService } = createProviderHarness(sandbox);
    const { view, getMessageHandler } = createWebviewViewHarness(sandbox);
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    const showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const saveCurrentSessionStub = sandbox.stub(provider as any, '_saveCurrentSession').resolves();
    const handleSearchDbObjectsStub = sandbox.stub(provider as any, '_handleSearchDbObjects').resolves();
    const handleGetDbObjectDetailsStub = sandbox.stub(provider as any, '_handleGetDbObjectDetails').resolves();
    const handleGetAllDbObjectsStub = sandbox.stub(provider as any, '_handleGetAllDbObjects').resolves();
    const handleGetDbHierarchyStub = sandbox.stub(provider as any, '_handleGetDbHierarchy').resolves();
    const loadSessionStub = sandbox.stub(provider as any, '_loadSession').resolves();
    const deleteSessionStub = sandbox.stub(provider as any, '_deleteSession').resolves();
    const handleExplainErrorStub = sandbox.stub(provider as any, 'handleExplainError').resolves();
    const handleFixQueryStub = sandbox.stub(provider as any, 'handleFixQuery').resolves();
    const handleAnalyzeDataStub = sandbox.stub(provider as any, 'handleAnalyzeData').resolves();
    const handleOptimizeQueryStub = sandbox.stub(provider as any, 'handleOptimizeQuery').resolves();
    const handleOpenInNotebookStub = sandbox.stub(provider as any, '_handleOpenInNotebook').resolves();
    const handlePreviewFileStub = sandbox.stub(provider as any, '_handlePreviewFile').resolves();
    const handleFilePickStub = sandbox.stub(provider as any, '_handleFilePick').resolves();

    await provider.resolveWebviewView(view, {} as any, {} as any);

    expect(view.webview.options).to.deep.equal({
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file('/ext')]
    });
    expect(view.webview.html).to.be.a('string');

    const messageHandler = getMessageHandler();
    expect(messageHandler).to.be.a('function');

    (provider as any)._messages = [{ role: 'user', content: 'hello' }];

    await messageHandler!({ type: 'clearChat' });

    (provider as any)._messages = [{ role: 'user', content: 'again' }];
    await messageHandler!({ type: 'newChat' });

    await messageHandler!({ type: 'cancelRequest' });

    await messageHandler!({ type: 'getHistory' });

    await messageHandler!({ type: 'searchDbObjects', query: 'users' });
    expect(handleSearchDbObjectsStub.calledOnceWithExactly('users')).to.be.true;

    await messageHandler!({
      type: 'getDbObjectDetails',
      object: {
        name: 'users',
        type: 'table',
        schema: 'public',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > public > users'
      }
    });
    expect(handleGetDbObjectDetailsStub.calledOnce).to.be.true;

    await messageHandler!({ type: 'getDbObjects' });
    expect(handleGetAllDbObjectsStub.calledOnce).to.be.true;

    await messageHandler!({ type: 'getDbHierarchy', path: { connectionId: 'conn1' } });
    expect(handleGetDbHierarchyStub.calledOnceWithExactly({ connectionId: 'conn1' })).to.be.true;

    await messageHandler!({ type: 'openAiSettings' });
    expect(executeCommandStub.calledOnceWithExactly('postgres-explorer.aiSettings')).to.be.true;

    const writeScopeStub = sandbox.stub(aiConfig, 'writeAiScopeSettings').resolves();
    sandbox.stub(aiConfig, 'rememberLastModelForProvider').resolves();
    await messageHandler!({
      type: 'switchChatModel',
      selectionId: 'anthropic:claude-sonnet-4-20250514',
    });
    expect(
      writeScopeStub.calledOnceWith('chat', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      }),
    ).to.be.true;

    await messageHandler!({ type: 'openInNotebook', code: 'SELECT 1;' });
    expect(handleOpenInNotebookStub.calledOnceWithExactly('SELECT 1;')).to.be.true;

    await messageHandler!({ type: 'previewFile', path: '/tmp/test.sql', name: 'test.sql' });
    expect(handlePreviewFileStub.calledOnceWithExactly('/tmp/test.sql', 'test.sql')).to.be.true;

    await messageHandler!({ type: 'pickFile' });
    expect(handleFilePickStub.calledOnce).to.be.true;

    await messageHandler!({ type: 'loadSession', sessionId: 'session_1' });
    expect(loadSessionStub.calledOnceWithExactly('session_1')).to.be.true;

    await messageHandler!({ type: 'deleteSession', sessionId: 'session_2' });
    expect(deleteSessionStub.calledOnceWithExactly('session_2')).to.be.true;

    await messageHandler!({ type: 'explainError', error: 'bad syntax', query: 'SELECT' });
    expect(handleExplainErrorStub.calledOnceWithExactly('bad syntax', 'SELECT')).to.be.true;

    await messageHandler!({ type: 'fixQuery', error: 'bad syntax', query: 'SELECT' });
    expect(handleFixQueryStub.calledOnceWithExactly('bad syntax', 'SELECT')).to.be.true;

    await messageHandler!({ type: 'analyzeData', data: 'a,b\n1,2', query: 'SELECT', rowCount: 1 });
    expect(handleAnalyzeDataStub.calledOnceWithExactly('a,b\n1,2', 'SELECT', 1)).to.be.true;

    await messageHandler!({ type: 'optimizeQuery', query: 'SELECT 1', executionTime: 12.3 });
    expect(handleOptimizeQueryStub.calledOnceWithExactly('SELECT 1', 12.3)).to.be.true;

    expect(saveCurrentSessionStub.calledOnce).to.be.true;
    expect(aiService.cancel.calledOnce).to.be.true;
    expect(showInformationMessageStub.calledWith('AI request cancelled.')).to.be.true;

    void postMessage;
  });

  it('attaches database objects and query files to the chat view', async () => {
    const { provider, postMessage } = createProviderHarness(sandbox);
    const showStub = (provider as any)._view.show as sinon.SinonStub;
    const getObjectSchemaStub = sandbox.stub((provider as any)._dbObjectService, 'getObjectSchema').resolves('CREATE TABLE public.users (id integer);');
    const writeFileStub = sandbox.stub(fs.promises, 'writeFile').resolves();
    const showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const clock = sandbox.useFakeTimers();

    const attachPromise = provider.attachDbObject({
      name: 'users',
      type: 'table',
      schema: 'public',
      database: 'appdb',
      connectionId: 'conn1',
      connectionName: 'Primary',
      breadcrumb: 'Primary > appdb > public > users'
    });
    await clock.tickAsync(200);
    await attachPromise;

    expect(showStub.called).to.be.false;
    expect(getObjectSchemaStub.calledOnce).to.be.true;
    expect(postMessage.calledWithMatch({
      type: 'addMentionFromTree',
      object: {
        name: 'users',
        type: 'table',
        schema: 'public',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > public > users',
        details: 'CREATE TABLE public.users (id integer);'
      }
    })).to.be.true;

    const csvSendPromise = provider.sendToChat({
      query: 'SELECT id FROM users',
      results: JSON.stringify({ columns: ['id'], rows: [{ id: 1 }] }),
      message: 'Send query'
    });
    await clock.tickAsync(300);
    await csvSendPromise;

    expect(writeFileStub.called).to.be.true;
    expect(postMessage.calledWithMatch({
      type: 'fileAttached',
      file: {
        type: 'sql',
        content: 'SELECT id FROM users'
      }
    })).to.be.true;
    expect(postMessage.calledWithMatch({
      type: 'fileAttached',
      file: {
        type: 'csv',
        content: '"id"\n1\n'
      }
    })).to.be.true;
    expect(showInformationMessageStub.calledOnce).to.be.true;

    const fallbackSendPromise = provider.sendToChat({
      query: 'SELECT id FROM users',
      results: '{not valid json',
      message: 'Send query'
    });
    await clock.tickAsync(300);
    await fallbackSendPromise;

    expect(postMessage.calledWithMatch({
      type: 'fileAttached',
      file: {
        type: 'json',
        content: '{not valid json'
      }
    })).to.be.true;

    const noticesSendPromise = provider.sendToChat({
      query: 'DO $$ BEGIN RAISE NOTICE \'a\'; RAISE NOTICE \'b\'; END $$;',
      message: 'Notices help',
      notices: [
        { message: 'first notice', receivedAt: '2020-01-01T00:00:00.000Z' },
        { message: 'second notice', receivedAt: '2020-01-01T00:00:01.000Z' },
      ],
    });
    await clock.tickAsync(300);
    await noticesSendPromise;

    expect(postMessage.calledWithMatch({
      type: 'fileAttached',
      file: {
        type: 'txt',
        content:
          '1. [2020-01-01T00:00:00.000Z] first notice\n\n2. [2020-01-01T00:00:01.000Z] second notice',
      },
    })).to.be.true;
  });
});