import { expect } from 'chai';
import * as sinon from 'sinon';

import { QueryPerformanceService } from '../../services/QueryPerformanceService';
import { QueryBaseline } from '../../services/queryPerformance/QueryPerformanceAnalyzer';

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
      m2: 0,
      stdDev: 0,
      sampleCount: 2,
      lastUpdated: 500,
      schemaVersion: 2
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
      m2: 0,
      stdDev: 0,
      sampleCount: 1,
      lastUpdated: 2_000,
      schemaVersion: 2
    });

    await service.clear();
    expect(service.getBaseline('existing')).to.equal(null);
    expect(storage.data['postgres-explorer.queryPerformanceBaselines']).to.deep.equal({});
    expect((storage.update as sinon.SinonStub).callCount).to.equal(3);
  });

  it('migrates legacy v1 baselines and keeps outliers out of baseline stats', async () => {
    const storage = createStorage({
      legacy: {
        queryHash: 'legacy',
        avgExecutionTime: 100,
        minExecutionTime: 80,
        maxExecutionTime: 120,
        stdDev: 5,
        sampleCount: 6,
        lastUpdated: 1_000,
      } as any
    });

    QueryPerformanceService.initialize(storage);
    const service = QueryPerformanceService.getInstance();

    const migrated = service.getBaseline('legacy');
    expect(migrated).to.deep.equal({
      queryHash: 'legacy',
      avgExecutionTime: 100,
      minExecutionTime: 80,
      maxExecutionTime: 120,
      m2: 0,
      stdDev: 0,
      sampleCount: 6,
      lastUpdated: 1_000,
      schemaVersion: 2
    });

    await service.recordExecution('q1', 100);
    await service.recordExecution('q1', 100);
    await service.recordExecution('q1', 100);
    await service.recordExecution('q1', 100);
    await service.recordExecution('q1', 100);

    const beforeOutlier = service.getBaseline('q1');
    expect(beforeOutlier).to.not.equal(null);
    expect(beforeOutlier?.sampleCount).to.equal(5);

    await service.recordExecution('q1', 10_000);

    const afterOutlier = service.getBaseline('q1');
    expect(afterOutlier).to.not.equal(null);
    expect(afterOutlier?.sampleCount).to.equal(5);
    expect(afterOutlier?.avgExecutionTime).to.equal(100);
    expect(afterOutlier?.maxExecutionTime).to.equal(100);
  });

  it('emits degradation alerts only after baseline confidence threshold', async () => {
    const storage = createStorage();
    QueryPerformanceService.initialize(storage);
    const service = QueryPerformanceService.getInstance();

    await service.recordExecution('q2', 100);
    await service.recordExecution('q2', 120);
    await service.recordExecution('q2', 110);
    await service.recordExecution('q2', 105);

    expect(service.getDegradationAlert('q2', 200)).to.equal(null);

    await service.recordExecution('q2', 115);

    const noAlert = service.getDegradationAlert('q2', 110);
    expect(noAlert).to.equal(null);

    const alert = service.getDegradationAlert('q2', 300);
    expect(alert).to.not.equal(null);
    expect(alert!).to.contain('slower than the');
    expect(alert!).to.contain('avg:');
    expect(alert!).to.contain('σ:');
  });
});