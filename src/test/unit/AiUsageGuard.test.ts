import { expect } from 'chai';
import * as sinon from 'sinon';

import { fetchAiUsage } from '../../services/aiUsage';
import { AccountService } from '../../features/sync/AccountService';

function createContext() {
  const secrets = new Map<string, string>();

  return {
    subscriptions: [],
    globalState: {
      get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
      update: async () => undefined,
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

describe('fetchAiUsage sign-in guard', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    AccountService.resetInstanceForTests();
  });

  afterEach(() => {
    sandbox.restore();
    AccountService.resetInstanceForTests();
  });

  it('returns null without any auth attempt when the user is not signed in', async () => {
    const context = createContext();
    const account = AccountService.getInstance(context);
    const ensureAiSession = sandbox.stub(account, 'ensureAiSession');

    const usage = await fetchAiUsage(context);

    expect(usage).to.equal(null);
    expect(ensureAiSession.called).to.equal(false);
  });
});
