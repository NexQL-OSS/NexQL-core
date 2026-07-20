import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as connectionModule from '../../commands/connection';
import * as databaseCommands from '../../commands/database';
import * as helper from '../../commands/helper';
import { ConnectionManager } from '../../services/ConnectionManager';

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

function createDbConnection() {
  const release = sinon.stub();
  const query = sinon.stub().resolves({ rows: [] });
  return {
    client: { query },
    metadata: {
      connectionId: 'c1',
      databaseName: 'appdb',
      name: 'Primary',
      host: 'localhost',
      port: 5432,
      username: 'postgres'
    },
    connection: {
      id: 'c1',
      name: 'Primary',
      host: 'localhost',
      port: 5432,
      username: 'postgres'
    },
    release,
    query
  };
}

describe('database commands', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('shows the dashboard, refreshes the tree, and disconnects a database', async () => {
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
    const refreshStub = sandbox.stub();
    const infoStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    const item = { label: 'appdb', databaseName: 'appdb', connectionId: 'c1' } as any;
    const context = { extensionUri: vscode.Uri.file('/ext') } as any;

    await databaseCommands.cmdDatabaseDashboard(item, context);
    expect(executeCommandStub.calledOnceWithExactly('postgres-explorer.showDashboard', item)).to.be.true;

    await databaseCommands.cmdRefreshDatabase(item, context, { refresh: refreshStub } as any);
    expect(refreshStub.calledOnceWithExactly(item)).to.be.true;

    await databaseCommands.cmdDisconnectDatabase(item, context);
    expect(infoStub.calledOnceWithExactly('Disconnected from appdb (Session cleared)')).to.be.true;
  });

  it('creates, deletes, and generates database notebooks', async () => {
    const builder = createBuilderStub(sandbox);
    const pooledClient = {
      query: sandbox.stub().resolves({ rows: [{ create_sql: 'CREATE DATABASE "appdb";' }] }),
      release: sandbox.stub()
    };
    const getPooledClientStub = sandbox.stub().resolves(pooledClient as any);

    sandbox.stub(connectionModule, 'getConnectionWithPassword').resolves({
      id: 'c1',
      name: 'Primary',
      host: 'localhost',
      port: 5432,
      username: 'postgres'
    } as any);
    sandbox.stub(connectionModule, 'createMetadata').callsFake((_config: any, databaseName: string) => ({
      connectionId: 'c1',
      databaseName,
      name: 'Primary',
      host: 'localhost',
      port: 5432,
      username: 'postgres'
    }));
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient: getPooledClientStub } as any);

    const item = { connectionId: 'c1', label: 'appdb', databaseName: 'appdb' } as any;
    const context = {} as any;

    await databaseCommands.cmdCreateDatabase(item, context);
    await databaseCommands.cmdDeleteDatabase(item, context);
    await databaseCommands.cmdGenerateCreateScript(item, context);

    expect((connectionModule.getConnectionWithPassword as sinon.SinonStub).callCount).to.equal(3);
    expect(getPooledClientStub.callCount).to.equal(3);
    expect(pooledClient.release.callCount).to.equal(3);
    expect(builder.show.callCount).to.equal(3);
    expect(builder.addSql.getCall(0).args[0]).to.include('CREATE DATABASE new_database;');
    expect(builder.addSql.getCall(2).args[0]).to.include('DROP DATABASE IF EXISTS "appdb";');
    expect(builder.addSql.getCall(3).args[0]).to.include('CREATE DATABASE "appdb"');
  });

  it('opens query, maintenance, and configuration notebooks', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);

    const item = { label: 'appdb', databaseName: 'appdb', connectionId: 'c1' } as any;
    const context = {} as any;

    await databaseCommands.cmdQueryTool(item, context);
    await databaseCommands.cmdMaintenanceDatabase(item, context);
    await databaseCommands.cmdShowConfiguration(item, context);

    expect(builder.showNew.calledOnce).to.be.true;
    expect(builder.show.calledTwice).to.be.true;
    expect(dbConnection.release.callCount).to.equal(3);
    expect(builder.addMarkdown.getCalls().some((call) => String(call.args[0]).includes('Query Tool: `appdb`'))).to.be.true;
    expect(builder.addMarkdown.getCalls().some((call) => String(call.args[0]).includes('Database Maintenance: `appdb`'))).to.be.true;
    expect(builder.addMarkdown.getCalls().some((call) => String(call.args[0]).includes('Database Configuration: `appdb`'))).to.be.true;
  });

  it('opens a psql terminal with the resolved connection', async () => {
    sandbox.stub(connectionModule, 'getConnectionWithPassword').resolves({
      host: 'localhost',
      port: 5432,
      username: 'postgres'
    } as any);

    const terminal = {
      show: sandbox.stub(),
      sendText: sandbox.stub()
    };
    const createTerminalStub = sandbox.stub(vscode.window, 'createTerminal').returns(terminal as any);

    const item = { connectionId: 'c1', label: 'appdb', databaseName: 'appdb' } as any;
    await databaseCommands.cmdPsqlTool(item, {} as any);

    expect(createTerminalStub.calledOnceWithExactly('PSQL: appdb')).to.be.true;
    expect(terminal.show.calledOnce).to.be.true;
    expect(terminal.sendText.calledOnceWithExactly('psql -h localhost -p 5432 -U postgres -d "appdb"')).to.be.true;
  });

  it('builds database object notebooks for each quick-pick branch', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    const getDatabaseConnectionStub = sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const quickPickStub = sandbox.stub(vscode.window, 'showQuickPick');

    quickPickStub.onCall(0).resolves(undefined);
    quickPickStub.onCall(1).resolves({ label: 'Schema' } as any);
    quickPickStub.onCall(2).resolves({ label: 'User' } as any);
    quickPickStub.onCall(3).resolves({ label: 'Role' } as any);
    quickPickStub.onCall(4).resolves({ label: 'Extension' } as any);

    const item = { connectionId: 'c1', label: 'appdb', databaseName: 'appdb' } as any;
    const context = { extensionUri: vscode.Uri.file('/ext') } as any;

    await databaseCommands.cmdAddObjectInDatabase(item, context);
    await databaseCommands.cmdAddObjectInDatabase(item, context);
    await databaseCommands.cmdAddObjectInDatabase(item, context);
    await databaseCommands.cmdAddObjectInDatabase(item, context);
    await databaseCommands.cmdAddObjectInDatabase(item, context);

    expect(getDatabaseConnectionStub.callCount).to.equal(5);
    expect(dbConnection.release.callCount).to.equal(5);
    expect(quickPickStub.callCount).to.equal(5);
    expect(builder.show.callCount).to.equal(4);
    expect(builder.addSql.callCount).to.be.greaterThan(0);
  });
});