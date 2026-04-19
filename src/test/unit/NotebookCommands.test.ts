import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as helper from '../../commands/helper';
import * as notebookCommands from '../../commands/notebook';
import { NotebookBuilder } from '../../commands/helper';
import { ConnectionUtils } from '../../utils/connectionUtils';

function createBuilderStub(sandbox: sinon.SinonSandbox) {
  const builder: any = {};
  builder.addMarkdown = sandbox.stub().returns(builder);
  builder.addSql = sandbox.stub().returns(builder);
  builder.show = sandbox.stub().resolves();
  builder.showNew = sandbox.stub().resolves();
  sandbox.stub(helper as any, 'NotebookBuilder').callsFake(function () {
    return builder;
  });
  return builder;
}

function createContext() {
  return {
    subscriptions: [],
    extensionUri: { fsPath: '/ext' } as any,
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: () => undefined,
      update: async () => undefined
    },
    globalState: {
      get: () => undefined,
      update: async () => undefined
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }
  } as any;
}

describe('notebook commands', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('creates a new notebook from a database connection', async () => {
    const builder = createBuilderStub(sandbox);
    const release = sandbox.stub();
    sandbox.stub(helper, 'getDatabaseConnection').resolves({
      metadata: { connectionId: 'c1', databaseName: 'appdb' },
      release
    } as any);

    const item = { connectionId: 'c1', databaseName: 'appdb', schema: 'public', label: 'users' } as any;
    await notebookCommands.cmdNewNotebook(item);

    expect(builder.addMarkdown.calledOnce).to.be.true;
    expect(builder.addSql.calledOnce).to.be.true;
    expect(builder.showNew.calledOnce).to.be.true;
    expect(release.calledOnce).to.be.true;
  });

  it('prompts for connection and database when invoked without tree context', async () => {
    const builder = createBuilderStub(sandbox);
    const release = sandbox.stub();
    const getDb = sandbox.stub(helper, 'getDatabaseConnection').resolves({
      metadata: { connectionId: 'c1', databaseName: 'appdb' },
      release
    } as any);
    sandbox.stub(ConnectionUtils, 'showConnectionPicker').resolves({ id: 'c1', name: 'Local', host: 'h', port: 5432 });
    sandbox.stub(ConnectionUtils, 'showDatabasePicker').resolves('appdb');

    await notebookCommands.cmdNewNotebook(undefined as any);

    expect(ConnectionUtils.showConnectionPicker.calledOnce).to.be.true;
    expect(ConnectionUtils.showDatabasePicker.calledOnce).to.be.true;
    expect(getDb.calledOnce).to.be.true;
    const firstArg = getDb.firstCall.args[0];
    expect(firstArg.connectionId).to.equal('c1');
    expect(firstArg.databaseName).to.equal('appdb');
    expect(builder.showNew.calledOnce).to.be.true;
    expect(release.calledOnce).to.be.true;
  });

  it('jumps to headings in the active notebook and handles empty states', async () => {
    const showInfoStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick');
    const showNotebookDocumentStub = sandbox.stub(vscode.window, 'showNotebookDocument').resolves(undefined);

    (vscode.window as any).activeNotebookEditor = undefined;
    await notebookCommands.cmdJumpToSection();
    expect(showInfoStub.calledOnceWithExactly('No notebook is currently open.')).to.be.true;

    const revealRange = sandbox.stub();
    const notebook = {
      getCells: () => [
        { kind: vscode.NotebookCellKind.Markup, document: { getText: () => '# Overview\nText' } },
        { kind: vscode.NotebookCellKind.Markup, document: { getText: () => '## Details\nMore' } },
        { kind: vscode.NotebookCellKind.Code, document: { getText: () => 'select 1;' } }
      ],
      uri: vscode.Uri.file('/nb')
    } as any;
    (vscode.window as any).activeNotebookEditor = { notebook, revealRange } as any;

    showQuickPickStub.resolves({ label: '$(symbol-namespace) Overview', detail: 'Cell 1', cellIndex: 0 } as any);

    await notebookCommands.cmdJumpToSection();
    expect(showInfoStub.calledOnce).to.be.true;
    expect(showQuickPickStub.calledOnce).to.be.true;
    expect(showNotebookDocumentStub.calledOnce).to.be.true;
    expect(revealRange.calledOnce).to.be.true;
  });

  it('creates EXPLAIN query cells for analyze and non-analyze flows', async () => {
    const showInfoStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const showErrorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    const originalApplyEdit = vscode.workspace.applyEdit;
    const applyEditStub = sandbox.stub().resolves(true);
    (vscode.workspace as any).applyEdit = applyEditStub;

    const cellUri = vscode.Uri.file('/nb/cell1');
    const notebook = {
      metadata: { connectionId: 'c1' },
      uri: vscode.Uri.file('/nb'),
      getCells: () => [
        { document: { uri: cellUri } }
      ]
    } as any;

    sandbox.stub(vscode.workspace, 'openTextDocument').resolves({
      getText: () => 'SELECT * FROM users;'
    } as any);
    (vscode.workspace as any).notebookDocuments = [notebook];

    try {
      await notebookCommands.cmdExplainQuery(cellUri, false);
      await notebookCommands.cmdExplainQuery(cellUri, true);
    } finally {
      (vscode.workspace as any).applyEdit = originalApplyEdit;
    }

    expect(applyEditStub.calledTwice).to.be.true;
    expect(showInfoStub.calledTwice).to.be.true;
    expect(showErrorStub.called).to.be.false;
  });
});