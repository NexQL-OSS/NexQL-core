import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as extensionModule from '../../extension';
import { SqlExecutor } from '../../providers/kernel/SqlExecutor';

function createWorkspaceState(initialState: Record<string, any> = {}) {
  const state = { ...initialState };
  return {
    get: <T>(key: string, defaultValue?: T) => (key in state ? state[key] : defaultValue),
    update: sinon.stub().callsFake(async (key: string, value: any) => {
      state[key] = value;
    }),
    state,
  };
}

describe('SqlExecutor - notebook parameter bank', () => {
  let sandbox: sinon.SinonSandbox;
  let executor: SqlExecutor;
  let workspaceState: ReturnType<typeof createWorkspaceState>;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    executor = new SqlExecutor({} as any);
    workspaceState = createWorkspaceState();
    (extensionModule as any).extensionContext = { workspaceState: workspaceState as any };

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
      if (section === 'postgresExplorer.parameters') {
        return {
          get: (key: string, defaultValue?: unknown) => {
            if (key === 'cacheLastValues') {
              return true;
            }
            if (key === 'nullSentinel') {
              return 'NULL';
            }
            return defaultValue;
          },
        } as any;
      }
      return { get: (_key: string, defaultValue?: unknown) => defaultValue } as any;
    });
  });

  afterEach(() => {
    sandbox.restore();
    (extensionModule as any).extensionContext = undefined;
  });

  it('reuses a previous value from the same notebook', async () => {
    workspaceState.state['nexql.notebookParameterBank.v1'] = {
      'vscode-notebook:test': {
        'named:color': ['blue', 'green'],
      },
    };

    const quickPick = sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'blue', value: 'blue' } as any);
    const inputBox = sandbox.stub(vscode.window, 'showInputBox');

    const values = await (executor as any).promptForNamedParameterValues('vscode-notebook:test', ['color']);

    expect(values).to.deep.equal(['blue']);
    expect(quickPick.calledOnce).to.be.true;
    expect(inputBox.called).to.be.false;
    expect(workspaceState.state['nexql.notebookParameterBank.v1']['vscode-notebook:test']['named:color'][0]).to.equal('blue');
  });

  it('stores a new value in the notebook bank when no history exists', async () => {
    const quickPick = sandbox.stub(vscode.window, 'showQuickPick');
    const inputBox = sandbox.stub(vscode.window, 'showInputBox').resolves('acme');

    const values = await (executor as any).promptForNamedParameterValues('vscode-notebook:test', ['customer']);

    expect(values).to.deep.equal(['acme']);
    expect(quickPick.called).to.be.false;
    expect(inputBox.calledOnce).to.be.true;
    expect(workspaceState.state['nexql.notebookParameterBank.v1']['vscode-notebook:test']['named:customer']).to.deep.equal(['acme']);
  });
});