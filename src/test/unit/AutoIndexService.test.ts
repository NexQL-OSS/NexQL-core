import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { AutoIndexService } from '../../features/dbindex/AutoIndexService';
import { ConnectionManager } from '../../services/ConnectionManager';
import * as featureGates from '../../services/featureGates';

const CONNECTIONS = [
  { id: 'conn-1', name: 'One', host: 'localhost', port: 5432, database: 'appdb', environment: 'staging' },
  { id: 'conn-2', name: 'Two', host: 'localhost', port: 5433, database: 'otherdb' },
];

function createOutputChannel() {
  return {
    appendLine: sinon.stub(),
    show: sinon.stub(),
    dispose: sinon.stub(),
  } as any;
}

function fingerprintRows(fingerprint: string) {
  const [object_count, max_oid, total_rows_estimate, schema_count, max_schema_oid] = fingerprint.split('|');
  return [{ object_count, max_oid, total_rows_estimate, schema_count, max_schema_oid }];
}

/** Routes probe queries by SQL text: fingerprint vs schema list. */
function createClient(opts: { fingerprint?: string; schemas?: string[] }) {
  const query = sinon.stub().callsFake(async (sql: string) => {
    if (sql.includes('pg_class')) {
      return { rows: fingerprintRows(opts.fingerprint ?? '1|2|3|4|5') };
    }
    return { rows: (opts.schemas ?? ['public']).map(nspname => ({ nspname })) };
  });
  return { query, release: sinon.stub() };
}

function createStore(opts: { manifest?: any; lock?: boolean } = {}) {
  return {
    getBaseDir: sinon.stub().returns({ fsPath: '/tmp/dbindex/conn/db' } as any),
    readManifest: sinon.stub().resolves(opts.manifest ?? null),
    acquireLock: sinon.stub().resolves(opts.lock ?? true),
    releaseLock: sinon.stub().resolves(),
  } as any;
}

function createBuilder() {
  return { build: sinon.stub().resolves({}) } as any;
}

/** Waits until the fire-and-forget drain loop settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('AutoIndexService', function () {
  // First successful build dynamically imports panel modules, which ts-node
  // transpiles on first hit — allow for that one-time cost.
  this.timeout(10000);

  let sandbox: sinon.SinonSandbox;
  let gateStub: sinon.SinonStub;
  let autoBuildSetting: boolean;
  let service: AutoIndexService | undefined;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    autoBuildSetting = true;
    gateStub = sandbox.stub(featureGates, 'isProFeatureEnabled').returns(true);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === 'postgresExplorer.connections') {
          return CONNECTIONS as any;
        }
        if (key === 'postgresExplorer.dbIndex.autoBuild') {
          return autoBuildSetting as any;
        }
        return defaultValue as T;
      },
    } as any);
  });

  afterEach(() => {
    service?.dispose();
    service = undefined;
    sandbox.restore();
  });

  function createService(store: any, builder: any) {
    service = new AutoIndexService(store, builder, createOutputChannel());
    return service;
  }

  it('skips everything when the autoBuild setting is disabled', async () => {
    autoBuildSetting = false;
    const store = createStore();
    const builder = createBuilder();
    const getPooledClient = sandbox.stub().resolves(createClient({}));
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(getPooledClient.called).to.be.false;
    expect(builder.build.called).to.be.false;
  });

  it('skips everything when the pro feature gate is closed', async () => {
    gateStub.returns(false);
    const store = createStore();
    const builder = createBuilder();
    const getPooledClient = sandbox.stub().resolves(createClient({}));
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(getPooledClient.called).to.be.false;
    expect(builder.build.called).to.be.false;
  });

  it('first-builds with all non-system schemas at structure depth when no manifest exists', async () => {
    const store = createStore({ manifest: null });
    const builder = createBuilder();
    const client = createClient({ schemas: ['public', 'sales'] });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves(client),
    } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(builder.build.calledOnce).to.be.true;
    const [connectionId, database, scope, depth, buildMode, environment] = builder.build.firstCall.args;
    expect(connectionId).to.equal('conn-1');
    expect(database).to.equal('appdb');
    expect(scope).to.deep.equal({ includedSchemas: ['public', 'sales'], excludedObjects: [], piiExcludedColumns: [] });
    expect(depth).to.equal('structure');
    expect(buildMode).to.equal('auto');
    expect(environment).to.equal('staging');
    expect(store.acquireLock.calledOnce).to.be.true;
    expect(store.releaseLock.calledOnce).to.be.true;
    expect(client.release.calledOnce).to.be.true;
  });

  it('skips the build when the manifest fingerprint matches the live database', async () => {
    const store = createStore({
      manifest: { schemaFingerprint: '1|2|3|4|5', scope: { includedSchemas: ['public'] }, buildDepth: 'stats', environment: 'production' },
    });
    const builder = createBuilder();
    const client = createClient({ fingerprint: '1|2|3|4|5' });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves(client),
    } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(builder.build.called).to.be.false;
    expect(store.acquireLock.called).to.be.false;
    expect(client.release.calledOnce).to.be.true;
  });

  it('rebuilds when the manifest fingerprint matches but the index is older than 1 week', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const store = createStore({
      manifest: {
        schemaFingerprint: '1|2|3|4|5',
        scope: { includedSchemas: ['public'] },
        buildDepth: 'stats',
        environment: 'production',
        indexedAt: eightDaysAgo,
      },
    });
    const builder = createBuilder();
    const client = createClient({ fingerprint: '1|2|3|4|5' });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves(client),
    } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(builder.build.calledOnce).to.be.true;
    const [, , scope, depth, , environment] = builder.build.firstCall.args;
    expect(scope).to.deep.equal({ includedSchemas: ['public'] });
    expect(depth).to.equal('stats');
    expect(environment).to.equal('production');
  });

  it('skips the build when the manifest fingerprint matches and the index is newer than 1 week', async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const store = createStore({
      manifest: {
        schemaFingerprint: '1|2|3|4|5',
        scope: { includedSchemas: ['public'] },
        buildDepth: 'stats',
        environment: 'production',
        indexedAt: sixDaysAgo,
      },
    });
    const builder = createBuilder();
    const client = createClient({ fingerprint: '1|2|3|4|5' });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves(client),
    } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(builder.build.called).to.be.false;
  });

  it('rebuilds with the manifest scope and depth when the fingerprint drifted', async () => {
    const manifest = {
      schemaFingerprint: '1|2|3|4|5',
      scope: { includedSchemas: ['sales'], excludedObjects: ['sales.tmp'], piiExcludedColumns: [] },
      buildDepth: 'stats',
      environment: 'production',
    };
    const store = createStore({ manifest });
    const builder = createBuilder();
    const client = createClient({ fingerprint: '9|9|9|9|9' });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves(client),
    } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(builder.build.calledOnce).to.be.true;
    const [, , scope, depth, , environment] = builder.build.firstCall.args;
    expect(scope).to.deep.equal(manifest.scope);
    expect(depth).to.equal('stats');
    expect(environment).to.equal('production');
  });

  it('dedupes rapid enqueues for the same key and never runs builds concurrently', async () => {
    const store = createStore();
    const builder = createBuilder();
    let inFlight = 0;
    let maxInFlight = 0;
    builder.build.callsFake(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => setImmediate(resolve));
      inFlight--;
      return {};
    });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().callsFake(async () => createClient({})),
    } as any);

    const svc = createService(store, builder);
    svc.ensureIndex('conn-1');
    svc.ensureIndex('conn-1'); // duplicate while queued
    svc.ensureIndex('conn-2');
    await flush();

    expect(builder.build.callCount).to.equal(2); // one per key
    expect(maxInFlight).to.equal(1);
  });

  it('skips without touching a foreign lock when acquireLock fails', async () => {
    const store = createStore({ lock: false });
    const builder = createBuilder();
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves(createClient({})),
    } as any);

    createService(store, builder).ensureIndex('conn-1');
    await flush();

    expect(builder.build.called).to.be.false;
    expect(store.releaseLock.called).to.be.false;
  });

  it('fails silently on connection errors and applies a retry cooldown', async () => {
    const store = createStore();
    const builder = createBuilder();
    const getPooledClient = sandbox.stub().rejects(new Error('ECONNREFUSED'));
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient } as any);

    const svc = createService(store, builder);
    svc.ensureIndex('conn-1');
    await flush();
    svc.ensureIndex('conn-1'); // within cooldown
    await flush();

    expect(getPooledClient.calledOnce).to.be.true;
    expect(builder.build.called).to.be.false;
  });

  it('ensureAll enqueues every configured connection', async () => {
    const store = createStore();
    const builder = createBuilder();
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().callsFake(async () => createClient({})),
    } as any);

    createService(store, builder).ensureAll();
    await flush();

    expect(builder.build.callCount).to.equal(2);
    const databases = builder.build.getCalls().map(c => c.args[1]);
    expect(databases).to.have.members(['appdb', 'otherdb']);
  });
});
