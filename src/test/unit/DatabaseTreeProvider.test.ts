import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { DatabaseTreeProvider, DatabaseTreeItem } from '../../providers/DatabaseTreeProvider';
import { ConnectionManager } from '../../services/ConnectionManager';
import { LicenseService } from '../../services/LicenseService';
import { NotebookIndexService } from '../../services/NotebookIndexService';

describe('DatabaseTreeProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let contextStub: any;
  let configGetStub: sinon.SinonStub;
  let connectionManagerStub: any;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    contextStub = {
      subscriptions: [],
      extensionUri: { fsPath: '/test/path' },
      globalState: {
        get: sandbox.stub().returns([]),
        update: sandbox.stub().resolves()
      }
    };

    // Mock vscode.workspace.getConfiguration
    configGetStub = sandbox.stub().returns([]);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: configGetStub
    } as any);

    // Mock ConnectionManager
    connectionManagerStub = {
      getPooledClient: sandbox.stub()
    };
    sandbox.stub(ConnectionManager, 'getInstance').returns(connectionManagerStub);

    // Mock LicenseService
    sandbox.stub(LicenseService, 'getInstance').returns({
      getTier: () => 'free',
      onDidChangeLicense: () => new vscode.Disposable()
    } as any);

    // Initialize NotebookIndexService
    NotebookIndexService.initialize(vscode.Uri.file('/test/path/storage'));

    // Initialize QueryHistoryService & SavedQueriesService to avoid uninitialized getInstance errors
    const mementoStub = {
      get: sandbox.stub().returns([]),
      update: sandbox.stub().resolves(),
      keys: () => []
    } as any;
    const { QueryHistoryService } = require('../../services/QueryHistoryService');
    QueryHistoryService.initialize(mementoStub);

    const { SavedQueriesService } = require('../../features/savedQueries/SavedQueriesService');
    SavedQueriesService.getInstance().initialize(contextStub);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should initialize correctly', () => {
    const provider = new DatabaseTreeProvider(contextStub);
    expect(provider).to.exist;
  });

  it('should return tree item', () => {
    const provider = new DatabaseTreeProvider(contextStub);
    const element = new DatabaseTreeItem('label', vscode.TreeItemCollapsibleState.None, 'table');
    const item = provider.getTreeItem(element);
    expect(item).to.equal(element);
  });

  it('should return connections as root children', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([
      { id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }
    ]);

    const children = await provider.getChildren();
    expect(children).to.have.lengthOf(1);
    expect(children[0].label).to.equal('Conn 1');
    expect(children[0].type).to.equal('connection');
  });

  it('should return databases and users for connection', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([
      { id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }
    ]);

    const clientStub = {
      query: sandbox.stub().callsFake((sql: string) => {
        if (sql.includes('pg_database')) {
          return Promise.resolve({ rows: [{ count: '1' }] });
        }
        if (sql.includes('pg_roles')) {
          return Promise.resolve({ rows: [{ count: '1' }] });
        }
        return Promise.resolve({ rows: [{ count: '1' }] });
      }),
      on: sandbox.stub(),
      release: sandbox.stub()
    };
    connectionManagerStub.getPooledClient.resolves(clientStub);

    const element = new DatabaseTreeItem('Conn 1', vscode.TreeItemCollapsibleState.Collapsed, 'connection', '1');
    const children = await provider.getChildren(element);

    expect(children).to.have.lengthOf(6);
    expect(children[0].label).to.equal('Databases');
    expect(children[1].label).to.equal('Notebooks');
    expect(children[2].label).to.equal('Saved Queries');
    expect(children[3].label).to.equal('Query History');
    expect(children[4].label).to.equal('Users & Roles');
    expect(children[5].label).to.equal('Tablespaces');
  });

  it('should return databases list for databases-group', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([
      { id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }
    ]);

    const clientStub = {
      query: sandbox.stub().resolves({ rows: [{ datname: 'db1' }, { datname: 'db2' }] }),
      on: sandbox.stub(),
      release: sandbox.stub()
    };
    connectionManagerStub.getPooledClient.resolves(clientStub);

    const element = new DatabaseTreeItem('Databases', vscode.TreeItemCollapsibleState.Collapsed, 'databases-group', '1');
    const children = await provider.getChildren(element);

    expect(children).to.have.lengthOf(2);
    expect(children[0].label).to.equal('db1');
    expect(children[0].type).to.equal('database');
  });

  it('should return schemas and extensions for database', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([
      { id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }
    ]);

    const query = sandbox.stub().resolves({ rows: [{ count: '0' }] });
    const clientStub = { query, on: sandbox.stub(), release: sandbox.stub() };
    connectionManagerStub.getPooledClient.resolves(clientStub);

    const element = new DatabaseTreeItem('db1', vscode.TreeItemCollapsibleState.Collapsed, 'database', '1', 'db1');
    const children = await provider.getChildren(element);

    expect(children).to.have.lengthOf(7);
    expect(children[0].label).to.equal('Schemas');
    expect(children[1].label).to.equal('Extensions');
    expect(children[2].label).to.equal('Cron Jobs');
    expect(children[3].label).to.equal('Foreign Data Wrappers');
    expect(children[4].label).to.equal('Event Triggers');
    expect(children[5].label).to.equal('Publications');
    expect(children[6].label).to.equal('Subscriptions');
  });

  it('should return categories for schema', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([
      { id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }
    ]);

    const clientStub = {
      query: sandbox.stub().resolves({ rows: [{ nspname: 'public' }] }),
      on: sandbox.stub(),
      release: sandbox.stub()
    };
    connectionManagerStub.getPooledClient.resolves(clientStub);

    const element = new DatabaseTreeItem('Schemas', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1');
    // Note: 'Schemas' category returns list of schemas, not categories inside a schema.
    // Wait, 'Schemas' category -> list of schemas.
    // 'schema' item -> list of categories (Tables, Views, etc.)

    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(1);
    expect(children[0].label).to.equal('public');
    expect(children[0].type).to.equal('schema');
  });

  it('should return tables for Tables category', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([
      { id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }
    ]);

    const clientStub = {
      query: sandbox.stub().resolves({ rows: [{ table_name: 'users' }] }),
      on: sandbox.stub(),
      release: sandbox.stub()
    };
    connectionManagerStub.getPooledClient.resolves(clientStub);

    const element = new DatabaseTreeItem('Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1', 'public');
    const children = await provider.getChildren(element);

    expect(children).to.have.lengthOf(1);
    expect(children[0].label).to.equal('users');
    expect(children[0].type).to.equal('table');
  });

  it('should return views for Views category', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = { query: sandbox.stub().resolves({ rows: [{ table_name: 'view1' }] }), on: sandbox.stub(),
      release: sandbox.stub() };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1', 'public');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(1);
    expect(children[0].type).to.equal('view');
  });

  it('should return functions for Functions category', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = { query: sandbox.stub().resolves({ rows: [{ routine_name: 'func1' }] }), on: sandbox.stub(),
      release: sandbox.stub() };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('Functions', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1', 'public');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(1);
    expect(children[0].type).to.equal('function');
  });

  it('should return materialized views', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = { query: sandbox.stub().resolves({ rows: [{ name: 'mv1' }] }), on: sandbox.stub(),
      release: sandbox.stub() };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('Materialized Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1', 'public');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(1);
    expect(children[0].type).to.equal('materialized-view');
  });

  it('should return types', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = { query: sandbox.stub().resolves({ rows: [{ name: 'type1' }] }), on: sandbox.stub(),
      release: sandbox.stub() };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('Types', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1', 'public');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(1);
    expect(children[0].type).to.equal('type');
  });

  it('should return foreign tables', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = { query: sandbox.stub().resolves({ rows: [{ name: 'ft1' }] }), on: sandbox.stub(),
      release: sandbox.stub() };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('Foreign Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1', 'public');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(1);
    expect(children[0].type).to.equal('foreign-table');
  });

  it('should return extensions', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = {
      query: sandbox.stub().resolves({
        rows: [
          { name: 'ext1', installed_version: '1.0', default_version: '1.0', comment: 'test', is_installed: true },
          { name: 'ext2', installed_version: null, default_version: '1.0', comment: 'test', is_installed: false }
        ]
      }), on: sandbox.stub(),
      release: sandbox.stub()
    };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('Extensions', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1', 'db1');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(2);
    expect(children[0].type).to.equal('extension');
    expect(children[0].contextValue).to.equal('extension-installed');
    expect(children[1].contextValue).to.equal('extension');
  });

  it('should return roles', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = {
      query: sandbox.stub().resolves({
        rows: [
          { rolname: 'role1', rolsuper: true, rolcreatedb: true, rolcreaterole: false, rolcanlogin: true }
        ]
      }), on: sandbox.stub(),
      release: sandbox.stub()
    };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('Users & Roles', vscode.TreeItemCollapsibleState.Collapsed, 'category', '1');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(1);
    expect(children[0].type).to.equal('role');
    expect(children[0].tooltip).to.contain('Superuser');
  });

  it('should return columns for table/view', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([{ id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }]);
    const clientStub = { query: sandbox.stub().resolves({ rows: [{ column_name: 'col1', data_type: 'text' }] }), on: sandbox.stub(),
      release: sandbox.stub() };
    connectionManagerStub.getPooledClient.resolves(clientStub);
    const element = new DatabaseTreeItem('table1', vscode.TreeItemCollapsibleState.Collapsed, 'table', '1', 'db1', 'public');
    const children = await provider.getChildren(element);
    expect(children.map((c) => c.label)).to.include.members(['Columns', 'Constraints', 'Indexes']);
  });

  it('should handle errors gracefully', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([
      { id: '1', name: 'Conn 1', host: 'localhost', port: 5432, username: 'user' }
    ]);

    const clientStub = {
      query: sandbox.stub().rejects(new Error('Connection failed')),
      on: sandbox.stub(),
      release: sandbox.stub()
    };
    connectionManagerStub.getPooledClient.resolves(clientStub);

    const element = new DatabaseTreeItem('Databases', vscode.TreeItemCollapsibleState.Collapsed, 'databases-group', '1');
    const children = await provider.getChildren(element);

    expect(children).to.be.an('array');
  });

  it('should refresh tree', () => {
    const clock = sandbox.useFakeTimers();
    const provider = new DatabaseTreeProvider(contextStub);
    const emitter = (provider as any)._onDidChangeTreeData;
    const fireSpy = sandbox.spy(emitter, 'fire');
    provider.refresh();
    clock.tick(350);
    expect(fireSpy.calledOnce).to.be.true;
    clock.restore();
  });

  it('should collapse all', () => {
    const provider = new DatabaseTreeProvider(contextStub);
    const emitter = (provider as any)._onDidChangeTreeData;
    const fireSpy = sandbox.spy(emitter, 'fire');
    provider.collapseAll();
    expect(fireSpy.calledOnce).to.be.true;
  });

  it('should handle missing connection', async () => {
    const provider = new DatabaseTreeProvider(contextStub);
    configGetStub.returns([]);
    const element = new DatabaseTreeItem('Conn 1', vscode.TreeItemCollapsibleState.Collapsed, 'connection', 'missing');
    const children = await provider.getChildren(element);
    expect(children).to.have.lengthOf(0);
  });
});
