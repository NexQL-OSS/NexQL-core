import { expect } from 'chai';
import * as sinon from 'sinon';

import { SavedQueriesService, SavedQuery } from '../../services/SavedQueriesService';

function createContext(initialQueries: SavedQuery[] = []) {
  const state = new Map<string, any>([['postgres-explorer.savedQueries', initialQueries]]);
  const update = sinon.stub().callsFake(async (key: string, value: any) => {
    state.set(key, value);
  });

  return {
    subscriptions: [],
    extensionUri: { fsPath: '/ext' } as any,
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: <T>(key: string, defaultValue?: T) => (state.has(key) ? state.get(key) : defaultValue as T),
      update
    },
    globalState: {
      get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
      update: async () => undefined
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }
  } as any;
}

describe('SavedQueriesService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (SavedQueriesService as any).instance = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    (SavedQueriesService as any).instance = undefined;
  });

  it('loads existing queries and persists save, update, delete, and usage changes', async () => {
    const context = createContext([
      {
        id: 'stored',
        title: 'Stored query',
        query: 'select 1',
        description: 'Older saved query',
        tags: ['ops'],
        createdAt: 100,
        usageCount: 1
      }
    ]);
    const service = SavedQueriesService.getInstance();
    service.initialize(context);

    expect(service.getQueries()).to.have.lengthOf(1);

    const clock = sandbox.useFakeTimers({ now: 1_000 });

    await service.saveQuery({
      id: '',
      title: 'New query',
      query: 'select 2',
      description: 'Fresh query',
      tags: ['ops', 'analytics'],
      usageCount: 0
    } as any);

    const [savedQuery] = service.getQueries();
    expect(savedQuery.title).to.equal('New query');
    expect(savedQuery.id).to.match(/^query_/);
    expect(savedQuery.createdAt).to.equal(1_000);

    await service.updateQuery({ ...savedQuery, title: 'Renamed query' } as any);
    expect(service.getQuery(savedQuery.id)?.createdAt).to.equal(1_000);

    await service.recordUsage(savedQuery.id);
    expect(service.getQuery(savedQuery.id)?.usageCount).to.equal(1);
    expect(service.getQuery(savedQuery.id)?.lastUsed).to.equal(1_000);

    await service.deleteQuery('stored');
    expect(service.getQuery('stored')).to.equal(undefined);

    expect((context.workspaceState.update as sinon.SinonStub).callCount).to.be.greaterThan(0);
    clock.restore();
  });

  it('filters, sorts, exports, and imports query collections', async () => {
    const context = createContext([
      {
        id: 'recent',
        title: 'Recent maintenance',
        query: 'select 1',
        description: 'Archive stats report',
        tags: ['maintenance', 'analytics'],
        createdAt: 100,
        lastUsed: 300,
        usageCount: 2
      },
      {
        id: 'old',
        title: 'Old ops query',
        query: 'select 2',
        tags: ['ops', 'maintenance'],
        createdAt: 200,
        usageCount: 5
      },
      {
        id: 'most-used',
        title: 'Popular query',
        query: 'select 3',
        tags: ['analytics'],
        createdAt: 150,
        usageCount: 10
      }
    ]);
    const service = SavedQueriesService.getInstance();
    service.initialize(context);

    expect(service.getQueriesByTag('maintenance').map((query) => query.id)).to.deep.equal(['recent', 'old']);
    expect(service.searchQueries('archive').map((query) => query.id)).to.deep.equal(['recent']);
    expect(service.getMostUsedQueries(1)[0].id).to.equal('most-used');
    expect(service.getRecentQueries(1)[0].id).to.equal('recent');
    expect(service.getAllTags()).to.deep.equal(['analytics', 'maintenance', 'ops']);
    expect(JSON.parse(service.exportQueries())).to.have.lengthOf(3);

    await service.importQueries(JSON.stringify([
      {
        title: 'Imported query',
        query: 'select 4',
        description: 'Imported from JSON',
        tags: ['imported'],
        usageCount: 0
      }
    ]));

    expect(service.getQueries().some((query) => query.title === 'Imported query')).to.be.true;

    try {
      await service.importQueries('not valid json');
      expect.fail('Expected importQueries to throw for invalid JSON');
    } catch (error) {
      expect((error as Error).message).to.contain('Failed to import queries');
    }
  });
});