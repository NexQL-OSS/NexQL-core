import { EventEmitter } from 'events';
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SSHService } from '../../services/SSHService';

describe('SSHService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (SSHService as any).instance = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    (SSHService as any).instance = undefined;
  });

  function createClient() {
    const fakeClient = new EventEmitter() as EventEmitter & {
      connect: sinon.SinonStub;
      forwardOut: sinon.SinonStub;
      end: sinon.SinonStub;
    };

    fakeClient.connect = sandbox.stub().callsFake(() => {
      fakeClient.emit('ready');
    });

    fakeClient.forwardOut = sandbox.stub().callsFake(
      (_sourceHost: string, _sourcePort: number, _dbHost: string, _dbPort: number, callback: (err: Error | null, stream?: EventEmitter) => void) => {
        const stream = new EventEmitter();
        callback(null, stream);
        return stream as any;
      }
    );

    fakeClient.end = sandbox.stub();

    return fakeClient;
  }

  it('creates an SSH tunnel with a password and closes the connection when the stream closes', async () => {
    const fakeClient = createClient();

    const service = SSHService.getInstance();
    const stream = await service.createStream(
      {
        host: 'ssh.example.com',
        port: 22,
        username: 'dbuser',
        password: 'secret'
      },
      'db.example.com',
      5432,
      () => fakeClient as any
    );

    expect(fakeClient.connect.calledOnce).to.be.true;
    expect(fakeClient.connect.firstCall.args[0]).to.deep.equal({
      host: 'ssh.example.com',
      port: 22,
      username: 'dbuser',
      password: 'secret'
    });
    expect(fakeClient.forwardOut.calledOnceWith('127.0.0.1', 0, 'db.example.com', 5432)).to.be.true;

    (stream as EventEmitter).emit('close');
    expect(fakeClient.end.calledOnce).to.be.true;
  });

  it('loads a private key when configured', async () => {
    const fakeClient = createClient();
    const keyPath = path.join(os.tmpdir(), `nexql-ssh-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
    fs.writeFileSync(keyPath, 'private-key');

    try {
      const service = SSHService.getInstance();
      await service.createStream(
        {
          host: 'ssh.example.com',
          port: 22,
          username: 'dbuser',
          privateKeyPath: keyPath
        },
        'db.example.com',
        5432,
        () => fakeClient as any
      );

      expect(fakeClient.connect.calledOnce).to.be.true;
      expect(Buffer.isBuffer(fakeClient.connect.firstCall.args[0].privateKey)).to.be.true;
      expect((fakeClient.connect.firstCall.args[0].privateKey as Buffer).toString()).to.equal('private-key');
    } finally {
      fs.unlinkSync(keyPath);
    }
  });

  it('surfaces private key read errors before connecting', async () => {
    const fakeClient = createClient();

    const service = SSHService.getInstance();

    try {
      await service.createStream(
        {
          host: 'ssh.example.com',
          port: 22,
          username: 'dbuser',
          privateKeyPath: '/keys/missing'
        },
        'db.example.com',
        5432,
        () => fakeClient as any
      );
      expect.fail('Expected createStream to reject when the private key cannot be read');
    } catch (error) {
      expect((error as Error).message).to.contain('Failed to read private key at /keys/missing');
    }

    expect(fakeClient.connect.called).to.be.false;
  });

  it('rejects when forwarding the SSH tunnel fails', async () => {
    const fakeClient = new EventEmitter() as EventEmitter & {
      connect: sinon.SinonStub;
      forwardOut: sinon.SinonStub;
      end: sinon.SinonStub;
    };

    fakeClient.connect = sandbox.stub().callsFake(() => {
      fakeClient.emit('ready');
    });

    fakeClient.forwardOut = sandbox.stub().callsFake(
      (_sourceHost: string, _sourcePort: number, _dbHost: string, _dbPort: number, callback: (err: Error | null, stream?: EventEmitter) => void) => {
        callback(new Error('forward failed'));
        return undefined as any;
      }
    );

    fakeClient.end = sandbox.stub();

    const service = SSHService.getInstance();

    try {
      await service.createStream(
        {
          host: 'ssh.example.com',
          port: 22,
          username: 'dbuser',
          password: 'secret'
        },
        'db.example.com',
        5432,
        () => fakeClient as any
      );
      expect.fail('Expected createStream to reject when forwarding fails');
    } catch (error) {
      expect((error as Error).message).to.equal('forward failed');
    }

    expect(fakeClient.end.calledOnce).to.be.true;
  });
});
