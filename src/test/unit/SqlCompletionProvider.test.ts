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

function attachNotebookMultiCells(documents: vscode.TextDocument[], metadata: any) {
  const notebook = new vscode.NotebookDocument(vscode.Uri.file('/workspace/sql-notebook.pgsql'), metadata);
  (notebook as any).notebookType = 'postgres-notebook';
  const cells = documents.map((doc, i) => new vscode.NotebookCell(doc, i, vscode.NotebookCellKind.Code));
  notebook.getCells = () => cells;
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

  /** Query order: objects, columns, FKs, search_path, composites, roles (single `_fetchAndStoreCache` round-trip). */
  const setupCacheResults = (
    objectsRows: any[],
    columnsRows: any[],
    foreignKeyRows: any[] = [],
    searchPath = 'public',
    compositeRows: any[] = [],
    roleRows: any[] = [{ rolname: 'postgres' }]
  ) => {
    queryStub.onCall(0).resolves({ rows: objectsRows });
    queryStub.onCall(1).resolves({ rows: columnsRows });
    queryStub.onCall(2).resolves({ rows: foreignKeyRows });
    queryStub.onCall(3).resolves({ rows: [{ search_path: searchPath }] });
    queryStub.onCall(4).resolves({ rows: compositeRows });
    queryStub.onCall(5).resolves({ rows: roleRows });
  };

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

    setupCacheResults(
      [
        { schema: 'public', object_name: 'users', object_type: 'table' },
        { schema: 'sales', object_name: 'orders', object_type: 'table' },
        { schema: 'sales', object_name: 'monthly_sales', object_type: 'view' },
        { schema: 'sales', object_name: 'recompute_totals', object_type: 'function', arguments: 'customer_id integer, include_tax boolean', call_arguments: 'customer_id integer, include_tax boolean' },
        { schema: 'sales', object_name: 'sync_inventory', object_type: 'procedure', arguments: 'warehouse_id integer', call_arguments: 'warehouse_id integer' }
      ],
      [
        { schema: 'public', table_name: 'users', column_name: 'user_id', data_type: 'integer' },
        { schema: 'public', table_name: 'users', column_name: 'email', data_type: 'text' },
        { schema: 'sales', table_name: 'orders', column_name: 'order_total', data_type: 'numeric' }
      ]
    );

    const provider = new SqlCompletionProvider();
    const sql =
      'SELECT u.user_id, o.order_total FROM public.users u JOIN sales.orders o ON o.user_id = u.user_id';
    const document = createNotebookCellDocument(sql);
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const selectClausePos = new vscode.Position(0, 'SELECT '.length);
    const firstItems = await provider.provideCompletionItems(document, selectClausePos, {} as any, {} as any);
    const secondItems = await provider.provideCompletionItems(document, selectClausePos, {} as any, {} as any);

    const firstLabels = firstItems.map(item => item.label);
    expect(getPooledClientStub.calledOnce).to.be.true;
    expect(releaseStub.calledOnce).to.be.true;
    expect(queryStub.callCount).to.equal(6);
    expect(queryStub.firstCall.args[0]).to.contain('NULL::text as arguments');
    expect(queryStub.firstCall.args[0]).to.contain('pg_get_function_arguments(p.oid) AS arguments');
    expect(queryStub.firstCall.args[0]).to.contain('pg_get_function_identity_arguments(p.oid) AS call_arguments');
    expect(firstLabels).to.include('user_id');
    expect(firstLabels).to.include('email');
    expect(firstLabels).to.include('order_total');
    expect(firstLabels).to.include('recompute_totals');
    expect(firstLabels).to.include('sync_inventory');

    const emailItem = firstItems.find(item => item.label === 'email');
    const orderTotalItem = firstItems.find(item => item.label === 'order_total');
    const recomputeTotalsItem = firstItems.find(item => item.label === 'recompute_totals');
    const syncInventoryItem = firstItems.find(item => item.label === 'sync_inventory');

    expect(emailItem?.sortText).to.equal('0-00-0001');
    expect(orderTotalItem?.sortText).to.equal('0-01-0000');
    expect(emailItem?.insertText).to.equal('u.email');
    expect(orderTotalItem?.insertText).to.equal('o.order_total');
    expect((recomputeTotalsItem?.insertText as any)?.value || recomputeTotalsItem?.insertText).to.equal('recompute_totals(${1:customer_id}, ${2:include_tax})');
    expect((syncInventoryItem?.insertText as any)?.value || syncInventoryItem?.insertText).to.equal('sync_inventory(${1:warehouse_id})');
    expect(secondItems.map(item => item.label)).to.deep.equal(firstLabels);

    const sqlFromAfterCursor = 'SELECT u FROM public.users u';
    const docAliasPrefix = createNotebookCellDocument(sqlFromAfterCursor, 'cell-alias-prefix');
    attachNotebook(docAliasPrefix, { connectionId: 'conn-1', databaseName: 'appdb' });
    const aliasPrefixPos = new vscode.Position(0, 'SELECT u'.length);
    const aliasPrefixItems = await provider.provideCompletionItems(docAliasPrefix, aliasPrefixPos, {} as any, {} as any);
    const aliasPrefixLabels = aliasPrefixItems.map(item => item.label);
    expect(aliasPrefixLabels).to.include('email');
    expect(aliasPrefixItems.find(i => i.label === 'email')?.insertText).to.equal('u.email');

    const fallbackDocument = createNotebookCellDocument('SELECT 1;', 'cell-2');
    attachNotebook(fallbackDocument, { connectionId: 'conn-1', databaseName: 'appdb' });
    const fallbackItems = await provider.provideCompletionItems(fallbackDocument, new vscode.Position(0, fallbackDocument.text.length), {} as any, {} as any);
    expect(fallbackItems.length).to.be.greaterThan(0);
    expect(getPooledClientStub.calledOnce).to.be.true;
  });

  it('deduplicates repeated database objects before returning completions', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [
        { schema: 'public', object_name: 'users', object_type: 'table' },
        { schema: 'public', object_name: 'users', object_type: 'table' },
        { schema: 'sales', object_name: 'orders', object_type: 'table' }
      ],
      [
        { schema: 'public', table_name: 'users', column_name: 'email', data_type: 'text' },
        { schema: 'public', table_name: 'users', column_name: 'email', data_type: 'text' },
        { schema: 'sales', table_name: 'orders', column_name: 'order_total', data_type: 'numeric' }
      ]
    );

    const provider = new SqlCompletionProvider();
    const sql = 'SELECT * FROM public.users u JOIN sales.orders o WHERE ';
    const document = createNotebookCellDocument(sql);
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, sql.length), {} as any, {} as any);
    const labels = items.map(item => item.label);

    expect(labels.filter(label => label === 'email')).to.have.length(1);
    expect(labels.filter(label => label === 'order_total')).to.have.length(1);
  });

  it('after FROM schema. suggests objects in that schema, not columns', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [
        { schema: 'sales', object_name: 'orders', object_type: 'table' },
        { schema: 'public', object_name: 'customers', object_type: 'table' }
      ],
      [
        { schema: 'sales', table_name: 'orders', column_name: 'id', data_type: 'integer' },
        { schema: 'public', table_name: 'customers', column_name: 'email', data_type: 'text' }
      ]
    );

    const provider = new SqlCompletionProvider();
    const sql = 'SELECT * FROM sales.';
    const document = createNotebookCellDocument(sql);
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, sql.length), {} as any, {} as any);
    const labels = items.map(item => item.label);

    expect(labels).to.include('orders');
    expect(labels).to.not.include('customers');
    expect(labels).to.not.include('id');
    expect(labels).to.not.include('email');
  });

  it('keeps the schema context when inserting objects from a schema-prefixed completion', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [
        { schema: 'public', object_name: 'users', object_type: 'table' },
        { schema: 'sales', object_name: 'orders', object_type: 'table' },
        { schema: 'sales', object_name: 'monthly_sales', object_type: 'view' },
        { schema: 'sales', object_name: 'recompute_totals', object_type: 'function' }
      ],
      []
    );

    const provider = new SqlCompletionProvider();
    const document = createNotebookCellDocument('SELECT * FROM sales.');
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, document.text.length), {} as any, {} as any);
    const labels = items.map(item => item.label);
    const ordersItem = items.find(item => item.label === 'orders');
    const usersItem = items.find(item => item.label === 'users');

    expect(labels).to.include('orders');
    expect(labels).to.include('monthly_sales');
    expect(labels).to.include('recompute_totals');
    expect(labels).to.not.include('users');
    expect(ordersItem?.insertText).to.equal('orders');
    expect(usersItem).to.be.undefined;
  });

  it('narrows column completions to the relation in the current query context', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [
        { schema: 'public', object_name: 'users', object_type: 'table' },
        { schema: 'sales', object_name: 'orders', object_type: 'table' }
      ],
      [
        { schema: 'public', table_name: 'users', column_name: 'id', data_type: 'integer' },
        { schema: 'public', table_name: 'users', column_name: 'email', data_type: 'text' },
        { schema: 'sales', table_name: 'orders', column_name: 'order_total', data_type: 'numeric' }
      ]
    );

    const provider = new SqlCompletionProvider();
    const sql = 'SELECT  FROM public.users u';
    const document = createNotebookCellDocument(sql);
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 'SELECT '.length), {} as any, {} as any);
    const labels = items.map(item => item.label);
    const idItem = items.find(item => item.label === 'id');

    expect(labels).to.include('id');
    expect(labels).to.include('email');
    expect(labels).to.not.include('order_total');
    expect(idItem?.insertText).to.equal('u.id');
  });

  it('does not duplicate an already typed column qualifier', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [
        { schema: 'public', object_name: 'users', object_type: 'table' }
      ],
      [
        { schema: 'public', table_name: 'users', column_name: 'created_at', data_type: 'timestamp with time zone' }
      ]
    );

    const provider = new SqlCompletionProvider();
    const document = createNotebookCellDocument('SELECT tn. FROM public.users tn');
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 'SELECT tn.'.length), {} as any, {} as any);
    const createdAtItem = items.find(item => item.label === 'created_at');

    expect(createdAtItem?.insertText).to.equal('created_at');
  });

  it('shows only columns from the specified alias when using qualified prefix with multiple joins', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [
        { schema: 'ecom', object_name: 'orders', object_type: 'table' },
        { schema: 'ecom', object_name: 'order_items', object_type: 'table' }
      ],
      [
        { schema: 'ecom', table_name: 'orders', column_name: 'id', data_type: 'integer' },
        { schema: 'ecom', table_name: 'orders', column_name: 'customer_id', data_type: 'integer' },
        { schema: 'ecom', table_name: 'orders', column_name: 'order_status', data_type: 'text' },
        { schema: 'ecom', table_name: 'order_items', column_name: 'item_id', data_type: 'integer' },
        { schema: 'ecom', table_name: 'order_items', column_name: 'order_id', data_type: 'integer' },
        { schema: 'ecom', table_name: 'order_items', column_name: 'product_id', data_type: 'integer' },
        { schema: 'ecom', table_name: 'order_items', column_name: 'quantity', data_type: 'integer' }
      ]
    );

    const provider = new SqlCompletionProvider();
    const document = createNotebookCellDocument('SELECT * FROM ecom.orders o JOIN ecom.order_items oi ON o.id = oi.order_id WHERE oi.');
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const textWithoutDot = 'SELECT * FROM ecom.orders o JOIN ecom.order_items oi ON o.id = oi.order_id WHERE oi';
    const position = new vscode.Position(0, textWithoutDot.length + 1);
    const items = await provider.provideCompletionItems(document, position, {} as any, {} as any);
    const labels = items.map(item => item.label);

    // Should include columns from order_items
    expect(labels).to.include('item_id');
    expect(labels).to.include('order_id');
    expect(labels).to.include('product_id');
    expect(labels).to.include('quantity');

    // Should NOT include columns from orders
    expect(labels).to.not.include('customer_id');
    expect(labels).to.not.include('order_status');

    // Verify insert text is just the column name (no prefix duplication)
    const itemIdItem = items.find(item => item.label === 'item_id');
    expect(itemIdItem?.insertText).to.equal('item_id');
  });

  it('binds alias after duplicated schema segment (ecom.ecom.table) to the real table', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [
        { schema: 'ecom', object_name: 'orders', object_type: 'table' },
        { schema: 'ecom', object_name: 'order_items', object_type: 'table' }
      ],
      [
        { schema: 'ecom', table_name: 'orders', column_name: 'customer_id', data_type: 'integer' },
        { schema: 'ecom', table_name: 'order_items', column_name: 'product_id', data_type: 'integer' }
      ]
    );

    const provider = new SqlCompletionProvider();
    const sql =
      'SELECT * FROM ecom.orders o JOIN ecom.ecom.order_items oi ON o.id = oi.order_id WHERE oi.';
    const document = createNotebookCellDocument(sql);
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const position = new vscode.Position(0, sql.length);
    const items = await provider.provideCompletionItems(document, position, {} as any, {} as any);
    const labels = items.map(item => item.label);

    expect(labels).to.include('product_id');
    expect(labels).to.not.include('customer_id');
  });

  it('loads full catalog in one round-trip on first completion (four queries, one connection)', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) => (key === 'postgresExplorer.connections'
        ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
        : undefined)
    } as any);

    setupCacheResults(
      [{ schema: 'public', object_name: 'users', object_type: 'table' }],
      [{ schema: 'public', table_name: 'users', column_name: 'id', data_type: 'integer' }]
    );

    const provider = new SqlCompletionProvider();
    const sql = 'SELECT  FROM public.users u';
    const document = createNotebookCellDocument(sql);
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    const pos = new vscode.Position(0, 'SELECT '.length);
    const itemsFirst = await provider.provideCompletionItems(document, pos, {} as any, {} as any);

    expect(getPooledClientStub.calledOnce).to.be.true;
    expect(releaseStub.calledOnce).to.be.true;
    expect(queryStub.callCount).to.equal(6);
    expect(itemsFirst.map(i => i.label)).to.include('id');

    queryStub.resetHistory();
    getPooledClientStub.resetHistory();
    releaseStub.resetHistory();

    const itemsCached = await provider.provideCompletionItems(document, pos, {} as any, {} as any);
    expect(getPooledClientStub.called).to.be.false;
    expect(itemsCached.map(i => i.label)).to.include('id');
  });

  it('includes prior notebook SQL cells so CTE names resolve in a later cell', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) =>
        key === 'postgresExplorer.connections'
          ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
          : undefined
    } as any);

    setupCacheResults([{ schema: 'public', object_name: 'users', object_type: 'table' }], []);

    const provider = new SqlCompletionProvider();
    const cellA = createNotebookCellDocument('WITH t AS (SELECT 1 AS cx)', 'cell-a');
    const cellB = createNotebookCellDocument('SELECT t.', 'cell-b');
    attachNotebookMultiCells([cellA, cellB], { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(cellB, new vscode.Position(0, 'SELECT t.'.length), {} as any, {} as any);
    expect(items.map(i => i.label)).to.include('cx');
  });

  it('suggests columns from a derived subquery alias', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) =>
        key === 'postgresExplorer.connections'
          ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
          : undefined
    } as any);

    setupCacheResults(
      [{ schema: 'public', object_name: 'users', object_type: 'table' }],
      [{ schema: 'public', table_name: 'users', column_name: 'user_id', data_type: 'integer' }]
    );

    const provider = new SqlCompletionProvider();
    const sql = 'SELECT sq. FROM (SELECT user_id AS uid FROM public.users) sq';
    const document = createNotebookCellDocument(sql);
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 'SELECT sq.'.length), {} as any, {} as any);
    expect(items.map(i => i.label)).to.include('uid');
  });

  it('INSERT INTO target lists relation objects only', async () => {
    (getConfigurationStub as sinon.SinonStub).returns({
      get: (key: string) =>
        key === 'postgresExplorer.connections'
          ? [{ id: 'conn-1', name: 'Main', host: 'localhost', port: 5432, username: 'postgres' }]
          : undefined
    } as any);

    setupCacheResults([{ schema: 'public', object_name: 'orders', object_type: 'table' }], []);

    const provider = new SqlCompletionProvider();
    const document = createNotebookCellDocument('INSERT INTO ');
    attachNotebook(document, { connectionId: 'conn-1', databaseName: 'appdb' });

    await provider.warmCache('conn-1', 'appdb');

    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 'INSERT INTO '.length), {} as any, {} as any);
    const labels = items.map(i => i.label);
    expect(labels).to.include('orders');
    expect(labels).to.not.include('SELECT');
  });
});