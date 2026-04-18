import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { NotebookStatusBar } from '../../activation/statusBar';
import { ProfileManager } from '../../features/connections/ProfileManager';
import * as TransactionModule from '../../services/TransactionManager';

const extensionModule = require('../../extension');

function createContext(activeProfileContext?: any) {
  return {
    subscriptions: [],
    extensionUri: { fsPath: '/ext' } as any,
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: () => undefined,
      update: async () => undefined
    },
    globalState: {
      get: <T>(key: string, defaultValue?: T) => {
        if (activeProfileContext && key === `activeProfile-${activeProfileContext.uri}`) {
          return activeProfileContext.data as T;
        }

        return defaultValue as T;
      },
      update: async () => undefined
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }
  } as any;
}

function createNotebookEditor(notebookType: string, metadata: any = {}, uri = 'nb:1'): vscode.NotebookEditor {
  return {
    notebook: {
      notebookType,
      metadata,
      uri: { toString: () => uri }
    } as any
  } as vscode.NotebookEditor;
}

describe('NotebookStatusBar', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (ProfileManager as any).instance = undefined;
    (vscode.window as any).activeNotebookEditor = undefined;
    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
  });

  afterEach(() => {
    sandbox.restore();
    (ProfileManager as any).instance = undefined;
    (vscode.window as any).activeNotebookEditor = undefined;
    (extensionModule as any).extensionContext = undefined;
  });

  function createStatusBarItems() {
    const items: any[] = [];
    sandbox.stub(vscode.window, 'createStatusBarItem').callsFake(() => {
      const item = {
        text: '',
        tooltip: '',
        command: undefined,
        backgroundColor: undefined,
        show: sandbox.stub(),
        hide: sandbox.stub(),
        dispose: sandbox.stub()
      };
      items.push(item);
      return item as any;
    });
    return items;
  }

  it('hides items when no notebook is active and shows the no-connection state', () => {
    const items = createStatusBarItems();
    sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    sandbox.stub(ProfileManager, 'getInstance').returns({ getProfiles: () => [] } as any);
    sandbox.stub(TransactionModule, 'getTransactionManager').returns({ getTransactionInfo: () => null } as any);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: <T>(_key: string, defaultValue?: T) => defaultValue as T
    } as any);

    const context = createContext();
    extensionModule.extensionContext = context;

    const statusBar = new NotebookStatusBar();
    expect(items.every((item) => item.hide.called)).to.be.true;

    (vscode.window as any).activeNotebookEditor = createNotebookEditor('postgres-query', {});
    statusBar.update();

    const [connectionItem, databaseItem, riskItem, profileItem, transactionItem, workspaceItem] = items;
    expect(connectionItem.text).to.equal('$(plug) Click to Connect');
    expect(connectionItem.backgroundColor.id).to.equal('statusBarItem.warningBackground');
    expect(connectionItem.show.called).to.be.true;
    expect(databaseItem.hide.called).to.be.true;
    expect(riskItem.hide.called).to.be.true;
    expect(profileItem.hide.called).to.be.true;
    expect(workspaceItem.hide.called).to.be.true;

    statusBar.updateTransactionState();
    expect(transactionItem.hide.called).to.be.true;

    statusBar.dispose();
    expect(connectionItem.dispose.called).to.be.true;
    expect(databaseItem.dispose.called).to.be.true;
    expect(workspaceItem.dispose.called).to.be.true;
  });

  it('shows connection, profile, risk, and transaction indicators for an active notebook', () => {
    const items = createStatusBarItems();
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);

    const activeProfileContext = {
      uri: 'nb:active',
      data: {
        profileId: 'profile-readonly-analyst',
        readOnlyMode: true,
        autoLimitSelectResults: 100
      }
    };
    const context = createContext(activeProfileContext);
    extensionModule.extensionContext = context;

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: <T>(_key: string, defaultValue?: T) => ([{
        id: 'c1',
        name: 'Primary',
        host: 'localhost',
        database: 'appdb',
        environment: 'production',
        readOnlyMode: true
      }] as any)
    } as any);

    sandbox.stub(ProfileManager, 'getInstance').returns({
      getProfiles: () => ([{ id: 'profile-readonly-analyst', profileName: 'Read Only Analyst' }])
    } as any);

    const txState: { current: any } = { current: null };
    sandbox.stub(TransactionModule, 'getTransactionManager').returns({
      getTransactionInfo: () => txState.current
    } as any);

    (vscode.window as any).activeNotebookEditor = createNotebookEditor('postgres-notebook', {
      connectionId: 'c1',
      databaseName: 'appdb'
    }, 'nb:active');

    const statusBar = new NotebookStatusBar();
    const [connectionItem, databaseItem, riskItem, profileItem, transactionItem, workspaceItem] = items;

    expect(connectionItem.text).to.equal('$(server) Primary');
    expect(databaseItem.text).to.equal('$(database) appdb');
    expect(connectionItem.backgroundColor.id).to.equal('statusBarItem.prominentBackground');
    expect(databaseItem.backgroundColor.id).to.equal('statusBarItem.prominentBackground');
    expect(riskItem.text).to.equal('$(shield) PROD (READ-ONLY)');
    expect(riskItem.tooltip).to.equal('Production environment - Read-only mode active');
    expect(profileItem.text).to.contain('Profile: Read Only Analyst');
    expect(profileItem.text).to.contain('Limit: 100');
    expect(executeCommandStub.calledWith('setContext', 'pgstudio.connectionName', 'Primary')).to.be.true;
    expect(executeCommandStub.calledWith('setContext', 'pgstudio.databaseName', 'appdb')).to.be.true;

    statusBar.updateTransactionState();
    expect(transactionItem.hide.called).to.be.true;

    txState.current = { isActive: true };
    statusBar.updateTransactionState();
    expect(transactionItem.text).to.equal('$(sync~spin) Transaction open');
    expect(transactionItem.backgroundColor.id).to.equal('statusBarItem.warningBackground');
    expect(transactionItem.show.called).to.be.true;

    expect(workspaceItem.hide.called).to.be.true;

    statusBar.dispose();
    expect(connectionItem.dispose.called).to.be.true;
    expect(databaseItem.dispose.called).to.be.true;
    expect(riskItem.dispose.called).to.be.true;
    expect(profileItem.dispose.called).to.be.true;
    expect(transactionItem.dispose.called).to.be.true;
    expect(workspaceItem.dispose.called).to.be.true;
  });
});