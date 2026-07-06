import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { AiService } from '../../providers/chat/AiService';
import { SecretStorageService } from '../../services/SecretStorageService';
import { AiCredentialsService } from '../../features/aiAssistant/AiCredentialsService';

class MockTextPart {
  constructor(public value: string) { }
}

class MockToolCallPart {
  constructor(public name: string) { }
}

class MockImagePart {
  constructor(public mimeType: string, public bytes: Uint8Array) { }
}

function createConfig(values: Record<string, any>) {
  return {
    get: (key: string, defaultValue?: any) => {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return values[key];
      }

      return defaultValue;
    }
  } as any;
}

function asyncIterable<T>(values: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) {
        yield value;
      }
    }
  } as any;
}

function createImageMessage() {
  return {
    role: 'user' as const,
    content: 'Analyze the attachment',
    attachments: [
      {
        name: 'diagram.png',
        type: 'image',
        dataUrl: 'data:image/png;base64,AAAA'
      },
      {
        name: 'notes.txt',
        type: 'text',
        content: 'Important notes'
      }
    ]
  };
}

function createPlainMessage() {
  return {
    role: 'user' as const,
    content: 'Prior context'
  };
}

describe('AiService', () => {
  let sandbox: sinon.SinonSandbox;
  let originalAuthentication: any;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    originalAuthentication = (vscode as any).authentication;

    (vscode as any).LanguageModelChatMessage.System = (content: string) => ({ role: 'system', content });
    (vscode as any).LanguageModelTextPart = MockTextPart;
    (vscode as any).LanguageModelToolCallPart = MockToolCallPart;
    (vscode as any).LanguageModelImagePart = MockImagePart;
    (vscode as any).authentication = { getSession: sandbox.stub() };
  });

  afterEach(() => {
    sandbox.restore();
    delete (vscode as any).LanguageModelChatMessage.System;
    delete (vscode as any).LanguageModelTextPart;
    delete (vscode as any).LanguageModelToolCallPart;
    delete (vscode as any).LanguageModelImagePart;
    (vscode as any).authentication = originalAuthentication;
  });

  it('builds the system prompt and clears cancellation state', () => {
    const service = new AiService();
    const cancelStub = sandbox.stub();
    const disposeStub = sandbox.stub();
    const abortStub = sandbox.stub();

    (service as any)._cancellationTokenSource = { cancel: cancelStub, dispose: disposeStub };
    (service as any)._abortController = { abort: abortStub };

    // v1.4.0: the default (chat) prompt is slimmed — the SQL quality checklist now only
    // attaches to SQL-producing capabilities, not conceptual chat.
    const prompt = service.buildSystemPrompt();
    expect(prompt).to.contain('PostgreSQL database assistant');
    expect(prompt).to.contain('treat it as ground truth');
    expect(prompt).to.not.contain('SQL QUALITY CHECKLIST');

    service.cancel();

    expect(cancelStub.calledOnce).to.be.true;
    expect(disposeStub.calledOnce).to.be.true;
    expect(abortStub.calledOnce).to.be.true;
    expect((service as any)._cancellationTokenSource).to.equal(null);
    expect((service as any)._abortController).to.equal(null);
  });

  it('builds the agentic system prompt with exploration rules when useAgentic is true', () => {
    const service = new AiService();
    service.setConnectionContext({
      environment: 'development',
      readOnlyMode: false,
      connectionName: 'TestConn',
      databaseName: 'testdb',
      useAgentic: true
    });
    const prompt = service.buildSystemPrompt();
    expect(prompt).to.contain('PostgreSQL database assistant');
    expect(prompt).to.contain('Connected to database: `testdb` via connection `TestConn`');
    expect(prompt).to.contain('You have NO upfront schema context');
    expect(prompt).to.not.contain('treat it as ground truth');
  });

  it('generates titles from VS Code LM and falls back to a simple title', async () => {
    const service = new AiService();
    const titleModel = {
      id: 'title-model',
      name: 'Title Model',
      family: 'gpt-4o',
      sendRequest: sandbox.stub().resolves({ text: asyncIterable(['Chat Title']) })
    };
    const selectModelsStub = sandbox.stub(vscode.lm, 'selectChatModels').resolves([titleModel as any]);

    const generated = await service.generateTitle('Show me active users by region', 'vscode-lm');
    expect(generated).to.equal('Chat Title');
    expect(titleModel.sendRequest.calledOnce).to.be.true;
    expect((titleModel.sendRequest.firstCall.args[0] as any[])[0].content).to.contain('Generate a very short title');

    const fallback = await service.generateTitle('0123456789012345678901234567890123456789extra text', 'openai');
    expect(fallback).to.equal('0123456789012345678901234567890123456789...');
    expect(selectModelsStub.calledOnce).to.be.true;
  });

  it('reports model info for configured and fallback VS Code LM models', async () => {
    const service = new AiService();
    const selectModelsStub = sandbox.stub(service as any, '_selectChatModelsWithTimeout');
    selectModelsStub.onCall(0).resolves([
      { id: 'title-model', name: 'Primary Model', family: 'gpt-4o' }
    ]);
    selectModelsStub.onCall(1).resolves([
      { id: 'family-model', name: 'Family Model', family: 'gpt-4o' }
    ]);
    selectModelsStub.onCall(2).resolves([]);
    selectModelsStub.onCall(3).resolves([]);

    const configured = await service.getModelInfo('vscode-lm', createConfig({ aiModel: 'Primary Model (gpt-4o)' }));
    expect(configured).to.equal('Primary Model');

    const family = await service.getModelInfo('vscode-lm', createConfig({}));
    expect(family).to.equal('Family Model');

    const none = await service.getModelInfo('vscode-lm', createConfig({}));
    expect(none).to.equal('VS Code LM (No Models)');

    const githubDefault = await service.getModelInfo('github', createConfig({}));
    expect(githubDefault).to.equal('openai/gpt-4.1');
  });

  it('uses the Cursor SDK for model info and request execution', async () => {
    const service = new AiService();
    const cursorModels = [
      { id: 'composer-2', displayName: 'Composer 2' },
      { id: 'auto', displayName: 'Auto' }
    ];
    const loadCursorSdkStub = sandbox.stub(service as any, '_loadCursorSdk').resolves({
      Cursor: {
        me: sandbox.stub().resolves({ userEmail: 'user@example.com' }),
        models: {
          list: sandbox.stub().resolves(cursorModels)
        }
      },
      Agent: {
        create: sandbox.stub().resolves({
          send: sandbox.stub().resolves({
            wait: sandbox.stub().resolves({ status: 'finished', result: 'Cursor answer', durationMs: 1234 }),
            cancel: sandbox.stub()
          }),
          close: sandbox.stub()
        })
      }
    });
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getCursorApiKey: sandbox.stub().resolves('cursor-secret')
    } as any);

    const modelInfo = await service.getModelInfo('cursor', createConfig({}));
    expect(modelInfo).to.equal('Composer 2');

    const result = await service.callProvider('cursor', 'Summarize the query', createConfig({ aiModel: 'composer-2' }), 'Use concise SQL guidance');
    expect(result.text).to.equal('Cursor answer');
    expect(loadCursorSdkStub.called).to.be.true;
  });

  it('calls VS Code LM with image attachments and streamed text', async () => {
    const service = new AiService();
    service.setMessages([createImageMessage() as any]);

    const primaryModel = {
      id: 'primary-model',
      name: 'Primary Model',
      family: 'gpt-4o',
      sendRequest: sandbox.stub().resolves({ stream: asyncIterable([new MockTextPart('Streamed answer')]) })
    };

    const selectModelsStub = sandbox.stub(vscode.lm, 'selectChatModels').callsFake(async (selector: any) => {
      if (selector && selector.family === 'gpt-4o') {
        return [primaryModel as any];
      }

      return [primaryModel as any];
    });

    const result = await service.callVsCodeLm('Please continue', createConfig({}), 'Custom system prompt');

    expect(result.text).to.equal('Streamed answer');
    expect(selectModelsStub.calledOnceWithExactly({ family: 'gpt-4o' })).to.be.true;

    const requestMessages = primaryModel.sendRequest.firstCall.args[0] as any[];
    expect(requestMessages[0]).to.deep.equal({ role: 'system', content: 'Custom system prompt' });
    expect(requestMessages[1].role).to.equal('user');
    expect(Array.isArray(requestMessages[1].content)).to.be.true;
    expect(requestMessages[1].content.some((part: any) => part instanceof MockImagePart)).to.be.true;
    expect(requestMessages[1].content.some((part: any) => part instanceof MockTextPart)).to.be.true;
    expect(requestMessages[2]).to.deep.equal({ role: 'user', content: 'Please continue' });
  });

  it('retries an empty VS Code LM response and falls back to an alternate model', async () => {
    const service = new AiService();
    service.setMessages([createPlainMessage() as any]);

    const primaryModel = {
      id: 'primary-model',
      name: 'Primary Model',
      family: 'gpt-4o',
      sendRequest: sandbox.stub()
    };
    const alternateModel = {
      id: 'alternate-model',
      name: 'Alternate Model',
      family: 'gpt-4.1',
      sendRequest: sandbox.stub().resolves({ result: { content: [{ text: 'Recovered response' }] } })
    };

    primaryModel.sendRequest.onCall(0).resolves({
      stream: asyncIterable([new MockToolCallPart('lookup')]),
      text: asyncIterable([])
    });
    primaryModel.sendRequest.onCall(1).resolves({
      stream: asyncIterable([new MockToolCallPart('lookup')]),
      text: asyncIterable([])
    });

    const selectModelsStub = sandbox.stub(vscode.lm, 'selectChatModels').callsFake(async (selector: any) => {
      if (selector && selector.family === 'gpt-4o') {
        return [primaryModel as any];
      }

      return [primaryModel as any, alternateModel as any];
    });

    const result = await service.callVsCodeLm('Retry please', createConfig({}));

    expect(result.text).to.equal('Recovered response');
    expect(primaryModel.sendRequest.callCount).to.equal(2);
    expect(alternateModel.sendRequest.calledOnce).to.be.true;
    expect(selectModelsStub.firstCall.args[0]).to.deep.equal({ family: 'gpt-4o' });
    expect(selectModelsStub.secondCall.args[0]).to.deep.equal({});
  });

  it('builds direct API payloads for supported providers', async () => {
    const service = new AiService();
    const makeHttpRequestStub = sandbox.stub(service as any, '_makeHttpRequest').resolves({ text: 'ok', usage: '1 token' });
    const getAiApiKeyStub = sandbox.stub();
    const getProviderApiKeyStub = sandbox.stub().resolves(undefined);
    const secretService = { getAiApiKey: getAiApiKeyStub } as any;
    sandbox.stub(SecretStorageService, 'getInstance').returns(secretService);
    sandbox.stub(AiCredentialsService, 'getInstance').returns({
      getApiKey: getProviderApiKeyStub,
    } as any);

    const getSessionStub = (vscode as any).authentication.getSession as sinon.SinonStub;
    const imageMessage = createImageMessage();

    const cases = [
      {
        provider: 'openai',
        secretBehavior: () => {
          getProviderApiKeyStub.withArgs('openai').resolves('secret-key');
          getAiApiKeyStub.rejects(new Error('missing secret'));
        },
        config: createConfig({}),
        messages: [imageMessage],
        expectedEndpoint: 'https://api.openai.com/v1/chat/completions',
        assert: (headers: any, body: any) => {
          expect(headers.Authorization).to.equal('Bearer secret-key');
          expect(body.model).to.equal('gpt-4.1');
          expect(body.messages[1].role).to.equal('user');
          expect(Array.isArray(body.messages[1].content)).to.be.true;
          expect(body.messages[1].content.some((part: any) => part.type === 'image_url')).to.be.true;
        }
      },
      {
        provider: 'anthropic',
        secretBehavior: () => getProviderApiKeyStub.withArgs('anthropic').resolves('secret-key'),
        config: createConfig({}),
        messages: [imageMessage],
        expectedEndpoint: 'https://api.anthropic.com/v1/messages',
        assert: (headers: any, body: any) => {
          expect(headers['x-api-key']).to.equal('secret-key');
          expect(headers.Authorization).to.be.undefined;
          expect(body.model).to.equal('claude-sonnet-4-20250514');
          expect(body.system).to.contain('PostgreSQL database assistant');
          expect(Array.isArray(body.messages[0].content)).to.be.true;
          expect(body.messages[0].content.some((part: any) => part.type === 'image')).to.be.true;
        }
      },
      {
        provider: 'gemini',
        secretBehavior: () => getProviderApiKeyStub.withArgs('gemini').resolves('secret-key'),
        config: createConfig({}),
        messages: [imageMessage],
        expectedEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        assert: (headers: any, body: any) => {
          expect(headers['X-goog-api-key']).to.equal('secret-key');
          expect(body.contents[0].role).to.equal('user');
          expect(Array.isArray(body.contents[0].parts)).to.be.true;
          expect(body.contents[0].parts.some((part: any) => part.inline_data)).to.be.true;
        }
      },
      {
        provider: 'github',
        secretBehavior: () => getAiApiKeyStub.rejects(new Error('missing secret')),
        authSession: { accessToken: 'gh-token' },
        config: createConfig({}),
        messages: [createPlainMessage()],
        expectedEndpoint: 'https://models.github.ai/inference/chat/completions',
        assert: (headers: any, body: any) => {
          expect(headers.Accept).to.equal('application/vnd.github+json');
          expect(headers.Authorization).to.equal('Bearer gh-token');
          expect(headers['X-GitHub-Api-Version']).to.equal('2026-03-10');
          expect(body.model).to.equal('openai/gpt-4.1');
        }
      }
    ];

    for (const testCase of cases) {
      getAiApiKeyStub.resetBehavior();
      getAiApiKeyStub.resetHistory();
      getProviderApiKeyStub.resetBehavior();
      getProviderApiKeyStub.resetHistory();
      getProviderApiKeyStub.resolves(undefined);
      getSessionStub.resetHistory();
      getSessionStub.resolves(testCase.authSession);
      testCase.secretBehavior();
      service.setMessages(testCase.messages as any);

      const result = await service.callDirectApi(testCase.provider, 'Current prompt', testCase.config);
      expect(result.text).to.equal('ok');

      const [endpoint, headers, body, provider] = makeHttpRequestStub.lastCall.args;
      expect(endpoint).to.equal(testCase.expectedEndpoint);
      expect(provider).to.equal(testCase.provider);
      testCase.assert(headers, body);

      if (testCase.provider === 'github') {
        expect(getSessionStub.calledOnceWithExactly('github', [], { silent: true, clearSessionPreference: false })).to.be.true;
      }
    }
  });

  it('builds direct API payloads for text-only providers without an API key', async () => {
    const service = new AiService();
    const makeHttpRequestStub = sandbox.stub(service as any, '_makeHttpRequest').resolves({ text: 'ok', usage: undefined });
    const getAiApiKeyStub = sandbox.stub().rejects(new Error('missing secret'));
    sandbox.stub(SecretStorageService, 'getInstance').returns({ getAiApiKey: getAiApiKeyStub } as any);

    service.setMessages([createPlainMessage() as any]);

    const cases = [
      {
        provider: 'custom',
        config: createConfig({ aiEndpoint: 'https://custom.example/v1/chat/completions' }),
        expectedEndpoint: 'https://custom.example/v1/chat/completions',
        expectedModel: 'gpt-3.5-turbo'
      },
      {
        provider: 'ollama',
        config: createConfig({}),
        expectedEndpoint: 'http://localhost:11434/v1/chat/completions',
        expectedModel: ''
      },
      {
        provider: 'lmstudio',
        config: createConfig({}),
        expectedEndpoint: 'http://localhost:1234/v1/chat/completions',
        expectedModel: ''
      }
    ];

    for (const testCase of cases) {
      const result = await service.callDirectApi(testCase.provider, 'Current prompt', testCase.config);
      expect(result.text).to.equal('ok');

      const [endpoint, headers, body, provider] = makeHttpRequestStub.lastCall.args;
      expect(endpoint).to.equal(testCase.expectedEndpoint);
      expect(provider).to.equal(testCase.provider);
      expect(headers.Authorization).to.be.undefined;
      expect(body.model).to.equal(testCase.expectedModel);
      expect(body.messages[0].role).to.equal('system');
      expect(body.messages[body.messages.length - 1]).to.deep.equal({ role: 'user', content: 'Current prompt' });
    }
  });

  it('falls back to legacy secret storage when scoped provider key is missing', async () => {
    const service = new AiService();
    const makeHttpRequestStub = sandbox.stub(service as any, '_makeHttpRequest').resolves({ text: 'ok', usage: undefined });
    sandbox.stub(AiCredentialsService, 'getInstance').returns({
      getApiKey: sandbox.stub().resolves(undefined),
    } as any);
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getAiApiKey: sandbox.stub().resolves('legacy-secret-key'),
    } as any);

    await service.callDirectApi('openai', 'Current prompt', createConfig({}));

    const [, headers] = makeHttpRequestStub.lastCall.args;
    expect(headers.Authorization).to.equal('Bearer legacy-secret-key');
  });
});