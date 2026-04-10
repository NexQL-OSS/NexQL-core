import { expect } from 'chai';
import * as sinon from 'sinon';

import { SessionService } from '../../providers/chat/SessionService';
import { ChatMessage, ChatSession } from '../../providers/chat/types';

function createContext(initialSessions: ChatSession[] = []) {
  let sessions = [...initialSessions];

  return {
    subscriptions: [],
    extensionUri: { fsPath: '/ext' } as any,
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: () => undefined,
      update: async () => undefined
    },
    globalState: {
      get: <T>(key: string, defaultValue?: T) => {
        if (key === 'chatSessions') {
          return sessions as any;
        }

        return defaultValue as T;
      },
      update: async (key: string, value: any) => {
        if (key === 'chatSessions') {
          sessions = value;
        }
      }
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }
  } as any;
}

describe('SessionService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('creates a new session with preview and metadata', async () => {
    const context = createContext();
    const service = new SessionService(context);
    const generateTitle = sandbox.stub().resolves('Session title');

    const messages: ChatMessage[] = [
      { role: 'user', content: 'show users' },
      { role: 'assistant', content: '**Answer**\n```sql\nSELECT 1;\n```' }
    ];

    await service.saveSession(messages, generateTitle, {
      connectionName: 'Primary',
      database: 'appdb'
    });

    const currentSessionId = service.getCurrentSessionId();
    expect(currentSessionId).to.match(/^session_\d+_[A-Za-z0-9]+$/);
    expect(generateTitle.calledOnceWithExactly('show users')).to.be.true;

    const sessions = service.getChatSessions();
    expect(sessions).to.have.lengthOf(1);
    expect(sessions[0]).to.include({
      title: 'Session title',
      preview: 'Answer',
      connectionName: 'Primary',
      database: 'appdb'
    });
    expect(sessions[0].messages).to.deep.equal(messages);

    const summaries = service.getSessionSummaries();
    expect(summaries[0]).to.include({
      id: sessions[0].id,
      title: 'Session title',
      messageCount: 2,
      isActive: true,
      preview: 'Answer',
      connectionName: 'Primary',
      database: 'appdb'
    });
  });

  it('updates an existing session and preserves the existing preview', async () => {
    const existingSession: ChatSession = {
      id: 'session_existing',
      title: 'Existing',
      messages: [{ role: 'user', content: 'hello' }],
      createdAt: 100,
      updatedAt: 100,
      preview: 'Existing preview',
      connectionName: 'Old',
      database: 'old_db'
    };

    const context = createContext([existingSession]);
    const service = new SessionService(context);
    service.setCurrentSessionId('session_existing');

    const generateTitle = sandbox.stub().resolves('Should not be used');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'new message' },
      { role: 'assistant', content: 'Fresh preview text' }
    ];

    await service.saveSession(messages, generateTitle, {
      connectionName: 'Primary',
      database: 'appdb'
    });

    expect(generateTitle.called).to.be.false;

    const sessions = service.getChatSessions();
    expect(sessions).to.have.lengthOf(1);
    expect(sessions[0]).to.include({
      id: 'session_existing',
      title: 'Existing',
      preview: 'Existing preview',
      connectionName: 'Primary',
      database: 'appdb'
    });
    expect(sessions[0].messages).to.deep.equal(messages);
    expect(sessions[0].updatedAt).to.be.greaterThan(100);
  });

  it('loads, deletes, and clears sessions correctly', async () => {
    const sessions: ChatSession[] = [
      {
        id: 'session_one',
        title: 'First',
        messages: [{ role: 'user', content: 'one' }],
        createdAt: 1,
        updatedAt: 2,
        preview: 'First preview',
        connectionName: 'Primary',
        database: 'appdb'
      },
      {
        id: 'session_two',
        title: 'Second',
        messages: [{ role: 'user', content: 'two' }],
        createdAt: 3,
        updatedAt: 4
      }
    ];

    const context = createContext(sessions);
    const service = new SessionService(context);

    const loadedMessages = service.loadSession('session_one');
    expect(loadedMessages).to.deep.equal([{ role: 'user', content: 'one' }]);
    expect(service.getCurrentSessionId()).to.equal('session_one');

    const summaries = service.getSessionSummaries();
    expect(summaries).to.deep.equal([
      {
        id: 'session_one',
        title: 'First',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        isActive: true,
        preview: 'First preview',
        connectionName: 'Primary',
        database: 'appdb'
      },
      {
        id: 'session_two',
        title: 'Second',
        createdAt: 3,
        updatedAt: 4,
        messageCount: 1,
        isActive: false,
        preview: undefined,
        connectionName: undefined,
        database: undefined
      }
    ]);

    const wasCurrentSession = await service.deleteSession('session_one');
    expect(wasCurrentSession).to.be.true;
    expect(service.getCurrentSessionId()).to.equal(null);
    expect(service.getChatSessions()).to.deep.equal([
      {
        id: 'session_two',
        title: 'Second',
        messages: [{ role: 'user', content: 'two' }],
        createdAt: 3,
        updatedAt: 4
      }
    ]);

    service.clearCurrentSession();
    expect(service.getCurrentSessionId()).to.equal(null);
    expect(await service.deleteSession('missing')).to.be.false;
  });

  it('generates a session identifier with the expected shape', () => {
    const service = new SessionService(createContext());
    expect(service.generateSessionId()).to.match(/^session_\d+_[A-Za-z0-9]+$/);
  });
});