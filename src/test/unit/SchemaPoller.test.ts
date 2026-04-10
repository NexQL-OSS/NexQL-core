import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { ConnectionManager } from '../../services/ConnectionManager';
import { SchemaPoller } from '../../services/SchemaPoller';

function createOutputChannel() {
  return {
    appendLine: sinon.stub(),
    show: sinon.stub(),
    dispose: sinon.stub()
  } as any;
}

function createFingerprintRow(objectCount: string, maxOid: string, totalRowsEstimate: string, schemaCount: string, maxSchemaOid: string) {
  return {
    object_count: objectCount,
    max_oid: maxOid,
    total_rows_estimate: totalRowsEstimate,
    schema_count: schemaCount,
    max_schema_oid: maxSchemaOid
  };
}

describe('SchemaPoller', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('starts, pauses, resumes, updates intervals, and disposes timers', () => {
    const outputChannel = createOutputChannel();
    const poller = new SchemaPoller('conn-1', sandbox.stub(), outputChannel);
    const clock = sandbox.useFakeTimers();

    poller.start(250);
    expect(outputChannel.appendLine.calledWithMatch('[SchemaPoller:conn-1] Starting')).to.be.true;
    expect(clock.countTimers()).to.equal(1);

    poller.pause();
    expect(clock.countTimers()).to.equal(0);

    poller.resume(500);
    expect(clock.countTimers()).to.equal(1);

    poller.updateInterval(1_000);
    expect(clock.countTimers()).to.equal(1);

    poller.pause();
    poller.updateInterval(750);
    expect(clock.countTimers()).to.equal(0);

    poller.dispose();
    expect(clock.countTimers()).to.equal(0);
  });

  it('stores fingerprints, detects changes, and releases clients', async () => {
    const refreshSpy = sandbox.spy();
    const outputChannel = createOutputChannel();
    const queryStub = sandbox.stub();
    const releaseStub = sandbox.stub();
    queryStub.onCall(0).resolves({ rows: [createFingerprintRow('1', '2', '3', '4', '5')] });
    queryStub.onCall(1).resolves({ rows: [createFingerprintRow('2', '2', '3', '4', '5')] });
    queryStub.onCall(2).resolves({ rows: [createFingerprintRow('2', '2', '3', '4', '5')] });

    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves({ query: queryStub, release: releaseStub })
    } as any);

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: <T>(_key: string, _defaultValue?: T) => ([{ id: 'conn-1', database: 'appdb' }] as any)
    } as any);

    const poller = new SchemaPoller('conn-1', refreshSpy, outputChannel);

    await (poller as any).pollDatabase({ id: 'conn-1', database: 'appdb' }, 'appdb');
    expect(outputChannel.appendLine.calledWithMatch('Initial fingerprint stored')).to.be.true;
    expect(refreshSpy.called).to.be.false;

    await (poller as any).pollDatabase({ id: 'conn-1', database: 'appdb' }, 'appdb');
    expect(outputChannel.appendLine.calledWithMatch('Fingerprint changed')).to.be.true;
    expect(refreshSpy.calledOnceWith('conn-1', 'appdb')).to.be.true;

    await (poller as any).pollDatabase({ id: 'conn-1', database: 'appdb' }, 'appdb');
    expect(outputChannel.appendLine.calledWithMatch('No change in "appdb"')).to.be.true;
    expect(releaseStub.callCount).to.equal(3);

    poller.dispose();
    await (poller as any).pollDatabase({ id: 'conn-1', database: 'appdb' }, 'appdb');
    expect(outputChannel.appendLine.calledWithMatch('Initial fingerprint stored')).to.be.true;
  });

  it('handles missing connections and stops after repeated polling failures', async () => {
    const outputChannel = createOutputChannel();
    const poller = new SchemaPoller('conn-1', sandbox.stub(), outputChannel);
    const connections: any[] = [];

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: <T>(_key: string, _defaultValue?: T) => ([] as any)
    } as any);

    await (poller as any).poll(100);
    expect(outputChannel.appendLine.calledWithMatch('Connection not found in configuration')).to.be.true;

    const queryStub = sandbox.stub().rejects(new Error('boom'));
    const releaseStub = sandbox.stub();

    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves({ query: queryStub, release: releaseStub })
    } as any);

    (vscode.workspace.getConfiguration as sinon.SinonStub).callsFake(() => ({
      get: <T>(_key: string, _defaultValue?: T) => (connections as any)
    } as any));

    connections.push({ id: 'conn-1', database: 'appdb' });

    await (poller as any).pollDatabase({ id: 'conn-1', database: 'appdb' }, 'appdb');
    await (poller as any).pollDatabase({ id: 'conn-1', database: 'appdb' }, 'appdb');
    await (poller as any).pollDatabase({ id: 'conn-1', database: 'appdb' }, 'appdb');

    expect(outputChannel.appendLine.calledWithMatch('Poll failed for connection conn-1, database "appdb": boom')).to.be.true;
    expect(outputChannel.appendLine.calledWithMatch('Stopping poller for connection conn-1 after 3 consecutive failures.')).to.be.true;
    expect(releaseStub.callCount).to.equal(3);
  });
});