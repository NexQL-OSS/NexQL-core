import { expect } from 'chai';
import * as sinon from 'sinon';

import { TransactionManager } from '../../services/TransactionManager';

describe('TransactionManager', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function createClient() {
    return {
      query: sandbox.stub().resolves(undefined)
    } as any;
  }

  it('begins, commits, rolls back, and rejects duplicate begins', async () => {
    const manager = new TransactionManager();
    const client = createClient();
    const clock = sandbox.useFakeTimers({ now: 1_000 });

    expect(manager.getTransactionInfo('missing')).to.equal(null);
    expect(manager.getTransactionSummary('missing')).to.equal('No connection');
    expect(manager.getSavepoints('missing')).to.deep.equal([]);
    expect(manager.getTransactionState('missing')).to.deep.equal({ isActive: false, isFailed: false, savepointCount: 0 });

    await manager.beginTransaction(client, 'session-1', 'SERIALIZABLE', true, true);
    expect(client.query.firstCall.args[0]).to.equal('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE');
    expect(manager.getTransactionInfo('session-1')).to.deep.include({
      isActive: true,
      state: 'active',
      isolationLevel: 'SERIALIZABLE',
      readOnly: true,
      deferrable: true
    });

    clock.tick(2_000);
    expect(manager.getTransactionSummary('session-1')).to.contain('Transaction Active (SERIALIZABLE)');
    expect(manager.getTransactionSummary('session-1')).to.contain('[READ-ONLY]');
    expect(manager.getTransactionSummary('session-1')).to.contain('2s');
    expect(manager.getTransactionState('session-1')).to.deep.equal({ isActive: true, isFailed: false, savepointCount: 0 });

    try {
      await manager.beginTransaction(client, 'session-1');
      expect.fail('Expected duplicate beginTransaction to fail');
    } catch (error) {
      expect((error as Error).message).to.contain('Transaction already active');
    }

    await manager.commitTransaction(client, 'session-1');
    expect(client.query.calledWith('COMMIT')).to.be.true;
    expect(manager.getTransactionInfo('session-1')?.isActive).to.be.false;
    expect(manager.getTransactionSummary('session-1')).to.equal('No transaction');

    await manager.beginTransaction(client, 'session-1');
    expect(client.query.getCall(2).args[0]).to.equal('BEGIN READ WRITE');

    await manager.rollbackTransaction(client, 'session-1');
    expect(client.query.calledWith('ROLLBACK')).to.be.true;
    expect(manager.getTransactionInfo('session-1')?.isActive).to.be.false;
  });

  it('manages savepoints and reports missing-savepoint errors', async () => {
    const manager = new TransactionManager();
    const client = createClient();

    await manager.beginTransaction(client, 'session-2');

    const firstSavepoint = await manager.createSavepoint(client, 'session-2');
    const customSavepoint = await manager.createSavepoint(client, 'session-2', 'custom_sp');
    expect(firstSavepoint).to.equal('sp_pgstudio_1');
    expect(customSavepoint).to.equal('custom_sp');
    expect(manager.getSavepoints('session-2')).to.deep.equal([
      { name: 'sp_pgstudio_1', timestamp: 0 },
      { name: 'custom_sp', timestamp: 1 }
    ]);

    await manager.releaseSavepoint(client, 'session-2');
    expect(client.query.calledWith('RELEASE SAVEPOINT "custom_sp"')).to.be.true;
    expect(manager.getSavepoints('session-2')).to.deep.equal([
      { name: 'sp_pgstudio_1', timestamp: 0 }
    ]);

    await manager.rollbackToSavepoint(client, 'session-2');
    expect(client.query.calledWith('ROLLBACK TO SAVEPOINT "sp_pgstudio_1"')).to.be.true;
    expect(manager.getSavepoints('session-2')).to.deep.equal([]);

    try {
      await manager.rollbackToSavepoint(client, 'session-2');
      expect.fail('Expected rollbackToSavepoint to fail without a savepoint');
    } catch (error) {
      expect((error as Error).message).to.contain('No savepoint available for rollback');
    }

    try {
      await manager.releaseSavepoint(client, 'session-2');
      expect.fail('Expected releaseSavepoint to fail without a savepoint');
    } catch (error) {
      expect((error as Error).message).to.contain('No savepoint available for release');
    }
  });

  it('handles cell errors, isolation changes, cleanup, and invalid transitions', async () => {
    const manager = new TransactionManager();
    const client = createClient();

    try {
      await manager.commitTransaction(client, 'missing');
      expect.fail('Expected commitTransaction to fail without an active transaction');
    } catch (error) {
      expect((error as Error).message).to.equal('No active transaction to commit');
    }

    try {
      await manager.rollbackTransaction(client, 'missing');
      expect.fail('Expected rollbackTransaction to fail without an active transaction');
    } catch (error) {
      expect((error as Error).message).to.equal('No active transaction to rollback');
    }

    try {
      await manager.createSavepoint(client, 'missing');
      expect.fail('Expected createSavepoint to fail without an active transaction');
    } catch (error) {
      expect((error as Error).message).to.equal('No active transaction for savepoint creation');
    }

    try {
      await manager.releaseSavepoint(client, 'missing');
      expect.fail('Expected releaseSavepoint to fail without an active transaction');
    } catch (error) {
      expect((error as Error).message).to.equal('No active transaction for savepoint release');
    }

    try {
      await manager.rollbackToSavepoint(client, 'missing');
      expect.fail('Expected rollbackToSavepoint to fail without an active transaction');
    } catch (error) {
      expect((error as Error).message).to.equal('No active transaction for savepoint rollback');
    }

    manager.initializeSession('session-3', true);
    await manager.beginTransaction(client, 'session-3');
    await manager.createSavepoint(client, 'session-3');

    await manager.handleCellError(client, 'session-3', new Error('cell failed'));
    expect(manager.getTransactionState('session-3')).to.deep.equal({ isActive: true, isFailed: false, savepointCount: 0 });

    await manager.handleCellError(client, 'session-3', new Error('cell failed again'));
    expect(client.query.calledWith('ROLLBACK')).to.be.true;
    expect(manager.getTransactionInfo('session-3')?.isActive).to.be.false;

    manager.initializeSession('session-4', false);
    await manager.beginTransaction(client, 'session-4');
    await manager.handleCellError(client, 'session-4', new Error('no rollback'));
    expect(manager.isTransactionFailed('session-4')).to.be.true;

    const failingIsolationClient = {
      query: sandbox.stub().rejects(new Error('bad isolation'))
    } as any;
    try {
      await manager.setIsolationLevel(failingIsolationClient, 'SERIALIZABLE');
      expect.fail('Expected setIsolationLevel to fail when the client rejects');
    } catch (error) {
      expect((error as Error).message).to.contain('Failed to set isolation level');
    }

    const brokenClient = {
      query: sandbox.stub().rejects(new Error('connection failed'))
    } as any;
    try {
      await manager.beginTransaction(brokenClient, 'session-5');
      expect.fail('Expected beginTransaction to surface the client failure');
    } catch (error) {
      expect((error as Error).message).to.equal('connection failed');
    }
    expect(manager.getTransactionInfo('session-5')?.state).to.equal('failed');
    expect(manager.isTransactionFailed('session-5')).to.be.true;

    manager.cleanupSession('session-4');
    expect(manager.getTransactionInfo('session-4')).to.equal(null);
    expect(manager.getTransactionState('session-4')).to.deep.equal({ isActive: false, isFailed: false, savepointCount: 0 });
  });
});