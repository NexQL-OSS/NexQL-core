import { expect } from 'chai';
import * as sinon from 'sinon';

import { QueryPerformanceService } from '../../services/QueryPerformanceService';
import { QueryBaseline } from '../../services/QueryAnalyzer';

function createStorage(initialBaselines: Record<string, QueryBaseline> = {}) {
  const data: Record<string, any> = {
    'postgres-explorer.queryPerformanceBaselines': initialBaselines
  };
  const update = sinon.stub().callsFake(async (key: string, value: any) => {
    data[key] = value;
  });

  return {
    get: <T>(key: string, defaultValue?: T) => (key in data ? data[key] : defaultValue as T),
    update,
    data
  } as any;
}

describe('QueryPerformanceService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (QueryPerformanceService as any).instance = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    (QueryPerformanceService as any).instance = undefined;
  });

  it('loads baselines, records execution timing, and clears cached baselines', async () => {
    expect(() => QueryPerformanceService.getInstance()).to.throw('QueryPerformanceService not initialized');

    const storage = createStorage({
      existing: {
        queryHash: 'existing',
        avgExecutionTime: 100,
        minExecutionTime: 80,
        maxExecutionTime: 120,
        stdDev: 0,
        sampleCount: 2,
        lastUpdated: 500
      }
    });

    QueryPerformanceService.initialize(storage);
    const service = QueryPerformanceService.getInstance();

    expect(service.getBaseline('missing')).to.equal(null);
    expect(service.getBaseline('existing')).to.deep.equal({
      queryHash: 'existing',
      avgExecutionTime: 100,
      minExecutionTime: 80,
      maxExecutionTime: 120,
      stdDev: 0,
      sampleCount: 2,
      lastUpdated: 500
    });

    sandbox.useFakeTimers({ now: 2_000 });

    await service.recordExecution('existing', 50);
    const updated = service.getBaseline('existing');
    expect(updated).to.deep.include({
      queryHash: 'existing',
      minExecutionTime: 50,
      maxExecutionTime: 120,
      sampleCount: 3,
      lastUpdated: 2_000
    });
    expect(updated?.avgExecutionTime).to.be.closeTo(83.333, 0.001);

    await service.recordExecution('new-hash', 30);
    expect(service.getBaseline('new-hash')).to.deep.equal({
      queryHash: 'new-hash',
      avgExecutionTime: 30,
      minExecutionTime: 30,
      maxExecutionTime: 30,
      stdDev: 0,
      sampleCount: 1,
      lastUpdated: 2_000
    });

    await service.clear();
    expect(service.getBaseline('existing')).to.equal(null);
    expect(storage.data['postgres-explorer.queryPerformanceBaselines']).to.deep.equal({});
    expect((storage.update as sinon.SinonStub).callCount).to.equal(3);
  });
});