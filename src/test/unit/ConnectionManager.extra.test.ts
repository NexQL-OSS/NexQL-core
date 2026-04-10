import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as pg from 'pg';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { ConnectionManager } from '../../services/ConnectionManager';
import { ErrorService } from '../../services/ErrorService';
import { SecretStorageService } from '../../services/SecretStorageService';
import { SSHService } from '../../services/SSHService';
import * as pgPassUtils from '../../utils/pgPassUtils';

describe('ConnectionManager additional coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let secretStorageStub: sinon.SinonStubbedInstance<SecretStorageService>;
  let workspaceConfigGetStub: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    secretStorageStub = sandbox.createStubInstance(SecretStorageService);
    (SecretStorageService as any).instance = secretStorageStub;
    sandbox.stub(SecretStorageService, 'getInstance').returns(secretStorageStub as any);
    workspaceConfigGetStub = sandbox.stub().returns(undefined);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: workspaceConfigGetStub,
    } as any);
    sandbox.stub(pgPassUtils, 'resolvePgPassPassword').returns(undefined);
  });

  afterEach(() => {
    sandbox.restore();
    const instance = (ConnectionManager as any).instance;
    if (instance?.cleanupTimer) {
      clearInterval(instance.cleanupTimer);
    }
    (ConnectionManager as any).instance = undefined;
    (SecretStorageService as any).instance = undefined;
  });

  it('exposes pool metrics and cleanup removes stale idle pools', async () => {
    const clock = sandbox.useFakeTimers({ now: 10_000 });
    const manager = ConnectionManager.getInstance();
    const pool = { end: sandbox.stub().resolves() };
    (manager as any).pools.set('c1:postgres', pool);
    (manager as any).poolMetrics.set('c1:postgres', {
      connectionId: 'c1',
      totalConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      createdAt: 1,
      lastActivity: -400_000,
    });

    expect(manager.getPoolMetrics('c1:postgres')).to.deep.include({ connectionId: 'c1', totalConnections: 0 });
    expect(manager.getAllPoolMetrics()).to.have.lengthOf(1);

    await (manager as any).cleanupIdlePools();

    expect((pool.end as sinon.SinonStub).calledOnce).to.be.true;
    expect(manager.getPoolMetrics('c1:postgres')).to.equal(undefined);
    expect((manager as any).pools.has('c1:postgres')).to.be.false;
    clock.restore();
  });

  it('builds SSL client config with cert files and query timeout', async () => {
    secretStorageStub.getPassword.resolves('stored-password');
    workspaceConfigGetStub.callsFake((key: string) => (key === 'queryTimeout' ? 25 : undefined));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgstudio-ssl-'));
    const caPath = path.join(tempDir, 'ca.pem');
    const certPath = path.join(tempDir, 'cert.pem');
    const keyPath = path.join(tempDir, 'key.pem');
    fs.writeFileSync(caPath, 'ca-cert');
    fs.writeFileSync(certPath, 'client-cert');
    fs.writeFileSync(keyPath, 'client-key');

    try {
      const manager = ConnectionManager.getInstance();
      const config = await (manager as any).createClientConfig({
        id: 'c1',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        database: 'appdb',
        sslmode: 'verify-full',
        sslRootCertPath: caPath,
        sslCertPath: certPath,
        sslKeyPath: keyPath,
      });

      expect(config.connectionTimeoutMillis).to.equal(15000);
      expect(config.statement_timeout).to.equal(25);
      expect(config.ssl.rejectUnauthorized).to.equal(true);
      expect(config.ssl.ca).to.equal('ca-cert');
      expect(config.ssl.cert).to.equal('client-cert');
      expect(config.ssl.key).to.equal('client-key');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('attaches an SSH stream when ssh tunneling is enabled', async () => {
    secretStorageStub.getPassword.resolves('stored-password');
    const stream = { on: sandbox.stub() };
    sandbox.stub(SSHService, 'getInstance').returns({
      createStream: sandbox.stub().resolves(stream),
    } as any);

    const manager = ConnectionManager.getInstance();
    const config = await (manager as any).createClientConfig({
      id: 'c1',
      host: 'db.example.com',
      port: 5432,
      username: 'postgres',
      database: 'appdb',
      ssh: {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'tunnel',
      },
    });

    expect(config.stream).to.equal(stream);
    expect((SSHService.getInstance() as any).createStream.calledOnce).to.be.true;
  });

  it('applies read-only mode when connecting pooled clients', async () => {
    secretStorageStub.getPassword.resolves('stored-password');
    const client = {
      query: sandbox.stub().resolves(undefined),
      release: sandbox.stub(),
    };
    const pool = {
      connect: sandbox.stub().resolves(client),
      on: sandbox.stub(),
      end: sandbox.stub().resolves(),
    };

    const manager = ConnectionManager.getInstance();
    sandbox.stub(manager as any, 'createPool').returns(pool as any);
    const pooledClient = await manager.getPooledClient({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'appdb',
      readOnlyMode: true,
    });

    expect(pooledClient).to.equal(client);
    expect((client.query as sinon.SinonStub).calledOnceWithExactly('SET default_transaction_read_only = ON')).to.be.true;
  });

  it('falls back to non-SSL pooled clients after an SSL connection failure', async () => {
    secretStorageStub.getPassword.resolves(undefined);
    const resolvePgPass = pgPassUtils.resolvePgPassPassword as sinon.SinonStub;
    resolvePgPass.returns(undefined);
    const firstPool = {
      connect: sandbox.stub().rejects(Object.assign(new Error('server does not support ssl'), { code: 'ECONNRESET' })),
      on: sandbox.stub(),
      end: sandbox.stub().resolves(),
    };
    const secondClient = {
      query: sandbox.stub().resolves(undefined),
      release: sandbox.stub(),
    };
    const secondPool = {
      connect: sandbox.stub().resolves(secondClient),
      on: sandbox.stub(),
      end: sandbox.stub().resolves(),
    };

    const manager = ConnectionManager.getInstance();
    const createPoolStub = sandbox.stub(manager as any, 'createPool');
    createPoolStub.onCall(0).returns(firstPool as any);
    createPoolStub.onCall(1).returns(secondPool as any);
    const client = await manager.getPooledClient({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'appdb',
    });

    expect(client).to.equal(secondClient);
    expect((firstPool.end as sinon.SinonStub).calledOnce).to.be.true;
    expect(createPoolStub.calledTwice).to.be.true;
  });

  it('creates and reuses session clients and closes them cleanly', async () => {
    secretStorageStub.getPassword.resolves('stored-password');
    const connect = sandbox.stub(pg.Client.prototype, 'connect').resolves();
    const query = sandbox.stub(pg.Client.prototype, 'query').resolves(undefined);
    const end = sandbox.stub(pg.Client.prototype, 'end').resolves();

    const manager = ConnectionManager.getInstance();
    const config = {
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'appdb',
      readOnlyMode: true,
    };

    const first = await manager.getSessionClient(config as any, 'session-1');
    const second = await manager.getSessionClient(config as any, 'session-1');

    expect(first).to.equal(second);
    expect(connect.calledOnce).to.be.true;
    expect(query.calledOnceWithExactly('SET default_transaction_read_only = ON')).to.be.true;

    await manager.closeSession(config as any, 'session-1');

    expect(end.calledOnce).to.be.true;
  });

  it('falls back to non-SSL session clients after an SSL connection failure', async () => {
    secretStorageStub.getPassword.resolves(undefined);
    const resolvePgPass = pgPassUtils.resolvePgPassPassword as sinon.SinonStub;
    resolvePgPass.returns(undefined);
    const connect = sandbox.stub(pg.Client.prototype, 'connect');
    connect.onFirstCall().rejects(Object.assign(new Error('server does not support ssl'), { code: 'ECONNRESET' }));
    connect.onSecondCall().resolves();
    sandbox.stub(pg.Client.prototype, 'query').resolves(undefined);
    sandbox.stub(pg.Client.prototype, 'end').resolves();

    const manager = ConnectionManager.getInstance();
    const client = await manager.getSessionClient({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'appdb',
    } as any, 'session-2');

    expect(client).to.exist;
    expect(connect.calledTwice).to.be.true;
  });

  it('closes all resources for a connection id', async () => {
    const manager = ConnectionManager.getInstance();
    const pool = { end: sandbox.stub().resolves() };
    const session = { end: sandbox.stub().resolves() };
    (manager as any).pools.set('c1:appdb', pool);
    (manager as any).sessions.set('c1:appdb:session:s1', session);

    await manager.closeAllConnectionsById('c1');

    expect((pool.end as sinon.SinonStub).calledOnce).to.be.true;
    expect((session.end as sinon.SinonStub).calledOnce).to.be.true;
    expect((manager as any).pools.size).to.equal(0);
    expect((manager as any).sessions.size).to.equal(0);
  });
});