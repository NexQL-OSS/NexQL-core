import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { AccountService } from '../../features/sync/AccountService';
import { LicenseService } from '../../services/LicenseService';

function createContext() {
  const secrets = new Map<string, string>();
  const globals = new Map<string, unknown>();

  return {
    subscriptions: [],
    globalState: {
      get: <T>(key: string, defaultValue?: T) =>
        globals.has(key) ? (globals.get(key) as T) : (defaultValue as T),
      update: async (key: string, value: unknown) => {
        globals.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  } as any;
}

describe('AccountService auth prompting', () => {
  let sandbox: sinon.SinonSandbox;
  let originalAuthentication: any;
  let getSession: sinon.SinonStub;
  let context: any;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    originalAuthentication = (vscode as any).authentication;
    getSession = sandbox.stub();
    (vscode as any).authentication = { getSession };
    (vscode as any).env = { ...(vscode as any).env, machineId: 'test-machine' };

    sandbox
      .stub(LicenseService, 'getInstance')
      .returns({ getLicenseKey: () => null } as any);

    AccountService.resetInstanceForTests();
    context = createContext();
  });

  afterEach(() => {
    sandbox.restore();
    (vscode as any).authentication = originalAuthentication;
    AccountService.resetInstanceForTests();
  });

  it('silent ensureAiSession returns undefined without prompting when unsigned', async () => {
    getSession.resolves(undefined);
    const account = AccountService.getInstance(context);

    const token = await account.ensureAiSession();

    expect(token).to.equal(undefined);
    expect(getSession.calledOnce).to.equal(true);
    expect(getSession.firstCall.args[2]).to.deep.equal({ silent: true });
    expect(
      getSession.getCalls().some((c) => c.args[2]?.createIfNone === true),
    ).to.equal(false);
  });

  it('silent signInFree performs no network mint when no GitHub session exists', async () => {
    getSession.resolves(undefined);
    const account = AccountService.getInstance(context);
    const postJson = sandbox.stub(account as any, 'postJson');

    const result = await account.signInFree();

    expect(result).to.equal(undefined);
    expect(postJson.called).to.equal(false);
  });

  it('interactive ensureAiSession prompts with createIfNone and mints a session', async () => {
    getSession.resolves({ accessToken: 'gh-token' });
    const account = AccountService.getInstance(context);
    sandbox.stub(account as any, 'postJson').resolves({
      access_token: 'nexql-token',
      refresh_token: 'nexql-refresh',
      email: 'user@example.com',
    });

    const token = await account.ensureAiSession({ interactive: true });

    expect(token).to.equal('nexql-token');
    expect(getSession.firstCall.args[2]).to.deep.equal({ createIfNone: true });
    expect(await account.isSignedIn()).to.equal(true);
  });

  it('reuses an existing access token without touching GitHub auth', async () => {
    await context.secrets.store('postgresExplorer.sync.accessToken', 'cached-token');
    const account = AccountService.getInstance(context);

    const token = await account.ensureAiSession();

    expect(token).to.equal('cached-token');
    expect(getSession.called).to.equal(false);
  });
});
