import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { SqlCompletionProvider } from '../../providers/SqlCompletionProvider';
import { ConnectionManager } from '../../services/ConnectionManager';

function createNotebookCellDocument(text: string, uriSuffix = 'cell-1') {
  const uri = vscode.Uri.parse(`vscode-notebook-cell:/sql-completion/${uriSuffix}`);
  return new vscode.TextDocument(text, uri, 'sql');
}

function attachNotebook(document: vscode.TextDocument, metadata: any) {
  const notebook = new vscode.NotebookDocument(vscode.Uri.file('/workspace/sql-notebook.pgsql'), metadata);
  const cell = new vscode.NotebookCell(document, 0, vscode.NotebookCellKind.Code);
  notebook.getCells = () => [cell];
  vscode.workspace.notebookDocuments = [notebook];
  return notebook;
}

describe('SqlCompletionProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let getConfigurationStub: sinon.SinonStub;
  let getPooledClientStub: sinon.SinonStub;
  let queryStub: sinon.SinonStub;
  let releaseStub: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    vscode.workspace.notebookDocuments = [];

    getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: sandbox.stub().returns([])
    } as any);

    queryStub = sandbox.stub();
    releaseStub = sandbox.stub();
    getPooledClientStub = sandbox.stub().resolves({ query: queryStub, release: releaseStub });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: getPooledClientStub
    } as any);
  });

  afterEach(() => {
    sandbox.restore();
    vscode.workspace.notebookDocuments = [];
  });

  it('returns empty completions for unsupported documents', async () => {
    const provider = new SqlCompletionProvider();

    const nonNotebook = new vscode.TextDocument('SELECT 1', vscode.Uri.file('/tmp/query.sql'), 'sql');
    const wrongLanguage = new vscode.TextDocument('SELECT 1', vscode.Uri.parse('vscode-notebook-cell:/sql-completion/file'), 'markdown');
    const emptyNotebook = createNotebookCellDocument('   ');

    expect(await provider.provideCompletionItems(nonNotebook, new vscode.Position(0, 0), {} as any, {} as any)).to.deep.equal([]);
    expect(await provider.provideCompletionItems(wrongLanguage, new vscode.Position(0, 0), {} as any, {} as any)).to.deep.equal([]);
    expect(await provider.provideCompletionItems(emptyNotebook, new vscode.Position(0, 0), {} as any, {} as any)).to.deep.equal([]);
    expect(getPooledClientStub.called).to.be.false;
  });

  it('returns keyword-only completions when the connection is missing from settings', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections' ? [] : undefined)
    } as any);

    const provider = new SqlCompletionProvider();
    const document = createNotebookCellDocument('SELECT * FROM public.users;');
    attachNotebook(document, { connectionId: 'missing', databaseName: 'appdb' });

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, document.text.length), {} as any, {} as any);
    const labels = items.map(item => item.label);

    expect(getPooledClientStub.called).to.be.false;
    expect(labels).to.include('SELECT');
    expect(labels).to.not.include('users');
    expect(labels).to.not.include('email');
  });

  it('loads table and column completions from cache and reuses them on subsequent calls', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    queryStub.onFirstCall().resolves({
      rows: [
        { schema: 'public', table_name: 'users' },
        { schema: 'sales', table_name: 'orders' }
      ]
    });
    queryStub.onSecondCall().resolves({
      rows: [
        { schema: 'public', table_name: 'users', column_name: 'user_id', data_type: 'integer' },
        { schema: 'public', table_name: 'users', column_name: 'email', data_type: 'text' },
        { schema: 'sales', table_name: 'orders', column_name: 'order_total', data_type: 'numeric' }
      ]
    });

    const provider = new SqlCompletionProvider();
    const document = createNotebookCellDocument(
      'SELECT u.user_id, o.order_total FROM public.users u JOIN sales.orders o ON o.user_id = u.user_id;'
    );
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    const firstItems = await provider.provideCompletionItems(document, new vscode.Position(0, document.text.length), {} as any, {} as any);
    const secondItems = await provider.provideCompletionItems(document, new vscode.Position(0, document.text.length), {} as any, {} as any);

    const firstLabels = firstItems.map(item => item.label);
    expect(getPooledClientStub.calledOnce).to.be.true;
    expect(releaseStub.calledOnce).to.be.true;
    expect(queryStub.calledTwice).to.be.true;
    expect(firstLabels).to.include('SELECT');
    expect(firstLabels).to.include('users');
    expect(firstLabels).to.include('orders');
    expect(firstLabels).to.include('user_id');
    expect(firstLabels).to.include('order_total');

    const usersItem = firstItems.find(item => item.label === 'users');
    const emailItem = firstItems.find(item => item.label === 'email');
    const orderTotalItem = firstItems.find(item => item.label === 'order_total');

    expect(usersItem?.sortText).to.equal('0-users');
    expect(emailItem?.sortText).to.equal('0-email');
    expect(orderTotalItem?.sortText).to.equal('0-order_total');
    expect(secondItems.map(item => item.label)).to.deep.equal(firstLabels);

    const fallbackDocument = createNotebookCellDocument('SELECT 1;', 'cell-2');
    attachNotebook(fallbackDocument, { connectionId: 'conn-1', databaseName: 'appdb' });
    const fallbackItems = await provider.provideCompletionItems(fallbackDocument, new vscode.Position(0, fallbackDocument.text.length), {} as any, {} as any);
    expect(fallbackItems.length).to.be.greaterThan(0);
    expect(getPooledClientStub.calledOnce).to.be.true;
  });
});