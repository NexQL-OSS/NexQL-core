import { expect } from 'chai';
import * as sinon from 'sinon';

import { QueryHistoryService } from '../../services/QueryHistoryService';

function createStorage(initialHistory: any[] = []) {
  let history = [...initialHistory];
  const update = sinon.stub().callsFake(async (_key: string, value: any) => {
    history = value;
  });

  return {
    get: <T>(key: string, defaultValue?: T) => {
      if (key === 'postgres-explorer.queryHistory') {
        return history as any;
      }

      return defaultValue as T;
    },
    update,
    getHistory: () => history
  } as any;
}

describe('QueryHistoryService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (QueryHistoryService as any).instance = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    (QueryHistoryService as any).instance = undefined;
  });

  it('adds, deletes, and clears history entries while firing change events', async () => {
    expect(() => QueryHistoryService.getInstance()).to.throw('QueryHistoryService not initialized');

    const storage = createStorage();
    QueryHistoryService.initialize(storage);
    const service = QueryHistoryService.getInstance();
    const changed = sandbox.spy();
    service.onDidChangeHistory(changed);

    sandbox.useFakeTimers({ now: 1_000 });

    await service.add({ query: 'select 1', success: true, durationMs: 25, rowCount: 1, connectionName: 'Primary' });
    await service.add({ query: 'select 2', success: false, duration: 2, slow: true });

    expect(service.getHistory()).to.have.lengthOf(2);
    expect(service.getHistory()[0]).to.include({ query: 'select 2', success: false, slow: true });
    expect(changed.callCount).to.equal(2);

    const newestId = service.getHistory()[0].id;
    await service.delete(newestId);
    expect(service.getHistory()).to.have.lengthOf(1);
    expect(changed.callCount).to.equal(3);

    await service.clear();
    expect(service.getHistory()).to.deep.equal([]);
    expect(changed.callCount).to.equal(4);
  });

  it('trims to the maximum history size and computes trend statistics', async () => {
    const storage = createStorage();
    QueryHistoryService.initialize(storage);
    const service = QueryHistoryService.getInstance();

    sandbox.useFakeTimers({ now: 10_000 });

    for (let index = 0; index < 101; index++) {
      await service.add({
        query: `select ${index}`,
        success: index % 2 === 0,
        durationMs: index === 100 ? undefined : index + 1,
        duration: index === 100 ? 2 : undefined,
        rowCount: index,
        slow: index % 10 === 0
      });
    }

    expect(service.getHistory()).to.have.lengthOf(100);
    expect(service.getHistory()[0].query).to.equal('select 100');

    const stats = service.getTrendStats();
    expect(stats.total).to.equal(100);
    expect(stats.avgMs).to.be.greaterThan(0);
    expect(stats.successRate).to.be.greaterThan(0);
    expect(stats.slowRate).to.be.greaterThan(0);
  });
});