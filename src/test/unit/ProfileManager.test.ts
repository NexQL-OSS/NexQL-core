import { expect } from 'chai';
import * as sinon from 'sinon';

import { ProfileManager } from '../../features/connections/ProfileManager';

function createContext(initialProfiles: any[] = []) {
  let profiles = [...initialProfiles];
  const update = sinon.stub().callsFake(async (_key: string, value: any) => {
    profiles = value;
  });

  return {
    subscriptions: [],
    extensionUri: { fsPath: '/ext' } as any,
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
      update: async () => undefined
    },
    globalState: {
      get: <T>(key: string, defaultValue?: T) => {
        if (key === 'postgres-explorer.connectionProfiles') {
          return profiles as any;
        }

        return defaultValue as T;
      },
      update
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }
  } as any;
}

describe('ProfileManager', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (ProfileManager as any).instance = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    (ProfileManager as any).instance = undefined;
  });

  it('creates the built-in profile set and suggests profiles by connection shape', async () => {
    const context = createContext();
    const manager = ProfileManager.getInstance();
    manager.initialize(context);

    await manager.initializeDefaultProfiles();

    expect(manager.getProfiles()).to.have.lengthOf(4);
    expect(manager.suggestProfile({ environment: 'production', readOnlyMode: true } as any)?.id).to.equal('profile-prod-readonly');
    expect(manager.suggestProfile({ readOnlyMode: true } as any)?.id).to.equal('profile-readonly-analyst');
    expect(manager.suggestProfile({ environment: 'staging', readOnlyMode: false } as any)?.id).to.equal('profile-staging-dev');
    expect(manager.suggestProfile({ environment: 'development', readOnlyMode: false } as any)?.id).to.equal('profile-db-admin');
    expect((context.globalState.update as sinon.SinonStub).callCount).to.equal(4);
  });

  it('loads profiles from storage and applies them without replacing the base password', async () => {
    const context = createContext([
      {
        id: 'custom',
        name: 'Custom Profile',
        profileName: 'Custom Profile',
        description: 'Custom role preset',
        host: 'profile-host',
        port: 6432,
        environment: 'staging',
        readOnlyMode: true,
        password: 'profile-secret'
      }
    ]);
    const manager = ProfileManager.getInstance();
    manager.initialize(context);

    expect(manager.getProfile('custom')).to.deep.include({ id: 'custom', profileName: 'Custom Profile' });

    const baseConfig = {
      id: 'connection-1',
      host: 'base-host',
      port: 5432,
      username: 'postgres',
      password: 'base-secret'
    } as any;

    expect(manager.applyProfile(baseConfig, 'missing')).to.equal(baseConfig);

    const applied = manager.applyProfile(baseConfig, 'custom');
    expect(applied).to.include({
      id: 'custom',
      host: 'profile-host',
      port: 6432,
      environment: 'staging',
      readOnlyMode: true
    });
    expect(applied.password).to.equal('base-secret');

    await manager.initializeDefaultProfiles();
    expect(manager.getProfiles()).to.have.lengthOf(1);

    await manager.createProfile({
      id: 'extra',
      name: 'Extra',
      profileName: 'Extra',
      host: 'extra-host',
      port: 5432,
      readOnlyMode: false
    } as any);
    await manager.deleteProfile('extra');

    expect((context.globalState.update as sinon.SinonStub).callCount).to.equal(2);
  });
});