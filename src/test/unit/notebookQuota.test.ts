import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { openOrCreateNotebookWithPicker } from '../../commands/notebook';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { LicenseService } from '../../services/LicenseService';

function makeContext(): vscode.ExtensionContext {
  return {
    globalStorageUri: vscode.Uri.file('/global-storage'),
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} } as any,
    globalState: { get: () => undefined, update: async () => {} } as any,
    extensionUri: vscode.Uri.file('/ext'),
    extension: { packageJSON: {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }
  } as any;
}

describe('Notebook Quota Limit (5 per connection)', () => {
  let sandbox: sinon.SinonSandbox;
  let qpMock: any;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (vscode.workspace.fs as any).readDirectory = async () => [];

    qpMock = {
      title: '',
      placeholder: '',
      matchOnDescription: false,
      matchOnDetail: false,
      value: '',
      items: [],
      selectedItems: [],
      onDidChangeValue: sandbox.stub().returns({ dispose: () => {} }),
      onDidAccept: sandbox.stub().callsFake((cb) => {
        qpMock._acceptCb = cb;
        return { dispose: () => {} };
      }),
      onDidHide: sandbox.stub().callsFake((cb) => {
        qpMock._hideCb = cb;
        return { dispose: () => {} };
      }),
      show: sandbox.stub().callsFake(() => {
        if (qpMock._hideCb) {
          qpMock._hideCb();
        }
      }),
      hide: sandbox.stub(),
      dispose: sandbox.stub()
    };

    sandbox.stub(vscode.window, 'createQuickPick').returns(qpMock);
  });

  afterEach(() => {
    sandbox.restore();
    delete (vscode.workspace.fs as any).readDirectory;
  });

  it('allows creation when connection notebooks are under limit', async () => {
    const context = makeContext();
    const metadata = { connectionId: 'conn-1', databaseName: 'mydb', name: 'local' };

    // Stub countNotebooksInConnection to return 4 notebooks
    sandbox.stub(ConnectionUtils, 'countNotebooksInConnection').resolves({
      count: 4,
      uris: Array.from({ length: 4 }, (_, i) => vscode.Uri.file(`/global-storage/local/mydb/nb${i + 1}.pgsql`))
    });

    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage');
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def?: any) => key === 'postgresExplorer.license.enforcement' ? 'freemium' : def
    } as any);

    // Mock LicenseService to return free tier
    sandbox.stub(LicenseService, 'getInstance').returns({
      getTier: () => 'free',
      isPaid: () => false
    } as any);

    // Just let it show picker and cancel
    sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

    await openOrCreateNotebookWithPicker(metadata, [], context, 'picker');

    // Should not show warning because count is 4 (< 5)
    expect(showWarning.called).to.be.false;
  });

  it('blocks creation and prompts options when limit of 5 is reached on free tier', async () => {
    const context = makeContext();
    const metadata = { connectionId: 'conn-1', databaseName: 'mydb', name: 'local' };

    const notebooks = Array.from({ length: 5 }, (_, i) => vscode.Uri.file(`/global-storage/local/mydb/nb${i + 1}.pgsql`));

    // Stub countNotebooksInConnection to return 5 notebooks
    sandbox.stub(ConnectionUtils, 'countNotebooksInConnection').resolves({
      count: 5,
      uris: notebooks
    });

    // Mock LicenseService to return free tier
    sandbox.stub(LicenseService, 'getInstance').returns({
      getTier: () => 'free',
      isPaid: () => false
    } as any);

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def?: any) => key === 'postgresExplorer.license.enforcement' ? 'freemium' : def
    } as any);

    // Stub warning message to simulate user choosing 'Upgrade'
    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Upgrade' as any);
    const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);

    await openOrCreateNotebookWithPicker(metadata, [], context, 'picker');

    expect(showWarning.calledOnce).to.be.true;
    expect(showWarning.firstCall.args[0]).to.include('limited to 5 notebooks');
    expect(executeCommand.calledWith('postgres-explorer.license.openUpgrade')).to.be.true;
  });

  it('does not limit sponsor tier users even with 5+ notebooks', async () => {
    const context = makeContext();
    const metadata = { connectionId: 'conn-1', databaseName: 'mydb', name: 'local' };

    const notebooks = Array.from({ length: 5 }, (_, i) => vscode.Uri.file(`/global-storage/local/mydb/nb${i + 1}.pgsql`));

    sandbox.stub(ConnectionUtils, 'countNotebooksInConnection').resolves({
      count: 5,
      uris: notebooks
    });

    // Mock LicenseService to return sponsor tier
    sandbox.stub(LicenseService, 'getInstance').returns({
      getTier: () => 'sponsor',
      isPaid: () => true
    } as any);

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def?: any) => key === 'postgresExplorer.license.enforcement' ? 'freemium' : def
    } as any);

    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage');

    await openOrCreateNotebookWithPicker(metadata, [], context, 'picker');

    // Should not show warning for sponsor
    expect(showWarning.called).to.be.false;
  });

  it('allows user to open an existing notebook when the limit is reached', async () => {
    const context = makeContext();
    const metadata = { connectionId: 'conn-1', databaseName: 'mydb', name: 'local' };

    const notebooks = Array.from({ length: 5 }, (_, i) => vscode.Uri.file(`/global-storage/local/mydb/nb${i + 1}.pgsql`));

    // Stub countNotebooksInConnection to return 5 notebooks
    sandbox.stub(ConnectionUtils, 'countNotebooksInConnection').resolves({
      count: 5,
      uris: notebooks
    });

    // Mock LicenseService to return free tier
    sandbox.stub(LicenseService, 'getInstance').returns({
      getTier: () => 'free',
      isPaid: () => false
    } as any);

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def?: any) => key === 'postgresExplorer.license.enforcement' ? 'freemium' : def
    } as any);

    // Stub warning message to simulate user choosing 'Open Existing Notebook'
    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Open Existing Notebook' as any);
    
    // Stub openNotebookDocument and showNotebookDocument
    const openNotebookDoc = sandbox.stub(vscode.workspace, 'openNotebookDocument').resolves({} as any);
    const showNotebookDoc = sandbox.stub(vscode.window, 'showNotebookDocument').resolves({} as any);

    // Override qpMock show to simulate user selecting the first existing notebook
    qpMock.show.callsFake(() => {
      qpMock.selectedItems = [{
        label: 'nb1',
        description: 'Notebook [mydb] · 0 sections · 01/01/2026',
        uri: notebooks[0],
        itemType: 'existing'
      }];
      if (qpMock._acceptCb) {
        qpMock._acceptCb();
      }
    });

    await openOrCreateNotebookWithPicker(metadata, [], context, 'picker');

    expect(showWarning.calledOnce).to.be.true;
    expect(openNotebookDoc.calledWith(notebooks[0])).to.be.true;
    expect(showNotebookDoc.calledOnce).to.be.true;
  });
});
