import { expect } from 'chai';
import * as sinon from 'sinon';

import { SecretStorageService, migrateExistingPasswords } from '../../services/SecretStorageService';

function createContext() {
  const secretValues = new Map<string, string>();

  return {
    subscriptions: [],
    extensionUri: { fsPath: '/ext' } as any,
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: () => undefined,
      update: async () => undefined
    },
    globalState: {
      get: sinon.stub().callsFake((key: string, defaultValue?: any) => {
        if (key === 'postgresql.connections') {
          return (createContext as any)._connections || [];
        }

        return defaultValue;
      }),
      update: sinon.stub().callsFake(async (key: string, value: any) => {
        if (key === 'postgresql.connections') {
          (createContext as any)._connections = value;
        }
      })
    },
    secrets: {
      get: sinon.stub().callsFake(async (key: string) => secretValues.get(key)),
      store: sinon.stub().callsFake(async (key: string, value: string) => {
        secretValues.set(key, value);
      }),
      delete: sinon.stub().callsFake(async (key: string) => {
        secretValues.delete(key);
      })
    }
  } as any;
}

describe('SecretStorageService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (SecretStorageService as any).instance = undefined;
    (createContext as any)._connections = [];
  });

  afterEach(() => {
    sandbox.restore();
    (SecretStorageService as any).instance = undefined;
  });

  it('stores, retrieves, and deletes passwords and API keys', async () => {
    const context = createContext();
    const service = SecretStorageService.getInstance(context);

    await service.setPassword('conn1', 'pw-1');
    await service.setAiApiKey('api-key-1');

    expect(await service.getPassword('conn1')).to.equal('pw-1');
    expect(await service.getAiApiKey()).to.equal('api-key-1');

    await service.deletePassword('conn1');
    await service.deleteAiApiKey();

    expect(await service.getPassword('conn1')).to.equal(undefined);
    expect(await service.getAiApiKey()).to.equal(undefined);

    expect(context.secrets.store.calledWithExactly('postgres-password-conn1', 'pw-1')).to.be.true;
    expect(context.secrets.store.calledWithExactly('postgresExplorer.aiApiKey.openai', 'api-key-1')).to.be.true;
    expect(context.secrets.delete.calledWithExactly('postgres-password-conn1')).to.be.true;
    expect(context.secrets.delete.calledWithExactly('postgresExplorer.aiApiKey.openai')).to.be.true;
  });

  it('migrates stored passwords and updates the connection list', async () => {
    const connections = [
      { id: 'conn1', name: 'Primary', password: 'pw-1' },
      { id: 'conn2', name: 'Secondary' }
    ];
    (createContext as any)._connections = connections;

    const context = createContext();
    const service = SecretStorageService.getInstance(context);

    await migrateExistingPasswords(context);

    expect((context.secrets.store as sinon.SinonStub).calledOnceWithExactly('postgres-password-conn1', 'pw-1')).to.be.true;
    expect(connections[0].password).to.equal(undefined);
    expect(context.globalState.update.calledOnce).to.be.true;
    expect(context.globalState.update.firstCall.args[0]).to.equal('postgresql.connections');
    expect(context.globalState.update.firstCall.args[1]).to.deep.equal([
      { id: 'conn1', name: 'Primary' },
      { id: 'conn2', name: 'Secondary' }
    ]);

    expect(service).to.equal(SecretStorageService.getInstance());
  });

  it('continues migration when one password store fails', async () => {
    const connections = [
      { id: 'bad', name: 'Bad', password: 'pw-bad' },
      { id: 'good', name: 'Good', password: 'pw-good' }
    ];
    (createContext as any)._connections = connections;

    const context = createContext();
    (context.secrets.store as sinon.SinonStub).callsFake(async (key: string, value: string) => {
      if (key === 'postgres-password-bad') {
        throw new Error('disk full');
      }
      (context.secrets.get as sinon.SinonStub).callsFake(async (lookupKey: string) => {
        if (lookupKey === key) {
          return value;
        }
        return undefined;
      });
    });
    const errorStub = sandbox.stub(console, 'error');

    await migrateExistingPasswords(context);

    expect(errorStub.calledOnce).to.be.true;
    expect(String(errorStub.firstCall.args[0])).to.contain('Failed to migrate password for connection Bad');
    expect(context.globalState.update.calledOnce).to.be.true;
    expect(connections[0].password).to.equal('pw-bad');
    expect(connections[1].password).to.equal(undefined);
  });

  it('skips updating state when no passwords are present', async () => {
    const connections = [{ id: 'conn1', name: 'Primary' }];
    (createContext as any)._connections = connections;

    const context = createContext();
    await migrateExistingPasswords(context);

    expect((context.secrets.store as sinon.SinonStub).called).to.be.false;
    expect(context.globalState.update.called).to.be.false;
  });
});