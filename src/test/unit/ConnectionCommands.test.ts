import { expect } from 'chai';
import * as sinon from 'sinon';
import * as pg from 'pg';
import * as vscode from 'vscode';

import * as pgPassUtils from '../../utils/pgPassUtils';
import { ConnectionManager } from '../../services/ConnectionManager';
import { SecretStorageService } from '../../services/SecretStorageService';
import { ErrorHandlers } from '../../commands/helper';
import {
  cmdConnectDatabase,
  cmdDisconnectConnection,
  cmdDisconnectDatabase,
  cmdReconnectConnection,
  createMetadata,
  getConnectionWithPassword,
  revealInExplorer,
  showConnectionSafety,
  validateCategoryItem,
  validateItem,
  validateRoleItem,
} from '../../commands/connection';
import { DatabaseTreeItem, DatabaseTreeProvider } from '../../providers/DatabaseTreeProvider';

describe('Connection commands', () => {
  let sandbox: sinon.SinonSandbox;
  let configGetStub: sinon.SinonStub;
  let configUpdateStub: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    configGetStub = sandbox.stub().returns(undefined);
    configUpdateStub = sandbox.stub().resolves();
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
      get: configGetStub,
      update: configUpdateStub,
    } as any));
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('creates metadata and validates tree items', () => {
    const metadata = createMetadata({ id: 'c1', host: 'localhost', port: 5432, username: 'postgres', password: 'pw' }, 'db1');

    expect(metadata.connectionId).to.equal('c1');
    expect(metadata.databaseName).to.equal('db1');
    expect(metadata.custom.metadata.enableScripts).to.equal(true);

    expect(() => validateItem({} as any)).to.throw('Invalid selection');
    expect(() => validateCategoryItem({} as any)).to.throw('Invalid category selection');
    expect(() => validateRoleItem({} as any)).to.throw('Invalid role selection');
  });

  it('resolves passwords from SecretStorage and pgpass fallback', async () => {
    const connection = {
      id: 'conn-1',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'appdb',
    };
    configGetStub.returns([connection]);
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves(undefined),
    } as any);
    const resolvePgPassPasswordStub = sandbox.stub(pgPassUtils, 'resolvePgPassPassword');
    resolvePgPassPasswordStub.onFirstCall().returns(undefined);
    resolvePgPassPasswordStub.onSecondCall().returns('pgpass-secret');

    const resolved = await getConnectionWithPassword('conn-1', 'appdb');

    expect(resolved.password).to.equal('pgpass-secret');
    expect(resolvePgPassPasswordStub.calledTwice).to.be.true;
    expect(resolvePgPassPasswordStub.firstCall.args).to.deep.equal(['localhost', 5432, 'appdb', 'postgres']);
    expect(resolvePgPassPasswordStub.secondCall.args).to.deep.equal(['localhost', 5432, 'postgres', 'postgres']);
  });

  it('prefers inline passwords when present', async () => {
    const connection = {
      id: 'conn-2',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'appdb',
      password: 'inline-secret',
    };
    configGetStub.returns([connection]);
    const secret = sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves(undefined),
    } as any);
    const pgPassStub = sandbox.stub(pgPassUtils, 'resolvePgPassPassword');

    const resolved = await getConnectionWithPassword('conn-2', 'appdb');

    expect(resolved.password).to.equal('inline-secret');
    expect(secret.calledOnce).to.be.true;
    expect(pgPassStub.called).to.be.false;
  });

  it('disconnects and reconnects a connection through the tree provider', async () => {
    const context = { subscriptions: [] } as any;
    const provider = {
      markConnectionDisconnected: sandbox.stub(),
      markConnectionConnected: sandbox.stub(),
    } as unknown as DatabaseTreeProvider;
    const item = new DatabaseTreeItem('Primary', vscode.TreeItemCollapsibleState.Collapsed, 'connection', 'conn-1');
    const closeAll = sandbox.stub().resolves();
    sandbox.stub(ConnectionManager, 'getInstance').returns({ closeAllConnectionsById: closeAll } as any);
    sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options, callback) => (callback as any)({ report: sandbox.stub() } as any));
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    await cmdDisconnectConnection(item, context, provider);
    await cmdReconnectConnection(item, context, provider);

    expect(closeAll.calledOnceWithExactly('conn-1')).to.be.true;
    expect((provider.markConnectionDisconnected as sinon.SinonStub).calledOnceWithExactly('conn-1')).to.be.true;
    expect((provider.markConnectionConnected as sinon.SinonStub).calledOnceWithExactly('conn-1')).to.be.true;
    expect(showInfo.calledTwice).to.be.true;
  });

  it('reports invalid connection selections through ErrorHandlers', async () => {
    const handleCommandError = sandbox.stub(ErrorHandlers, 'handleCommandError').resolves();
    const context = { subscriptions: [] } as any;

    await cmdDisconnectConnection({} as any, context);
    await cmdReconnectConnection({} as any, context);

    expect(handleCommandError.calledTwice).to.be.true;
  });

  it('disconnects a database connection and updates the tree', async () => {
    const context = { subscriptions: [] } as any;
    configGetStub.returns([
      { id: 'conn-1', host: 'localhost', port: 5432, username: 'postgres', database: 'appdb' },
    ]);
    const provider = { refresh: sandbox.stub() } as unknown as DatabaseTreeProvider;
    const item = new DatabaseTreeItem('Primary', vscode.TreeItemCollapsibleState.Collapsed, 'connection', 'conn-1');
    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Yes' as any);
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const deletePassword = sandbox.stub().resolves();
    const closeConnection = sandbox.stub().resolves();

    sandbox.stub(SecretStorageService, 'getInstance').returns({ deletePassword } as any);
    sandbox.stub(ConnectionManager, 'getInstance').returns({ closeConnection } as any);

    await cmdDisconnectDatabase(item, context, provider);

    expect(showWarning.calledOnce).to.be.true;
    expect(configUpdateStub.calledOnce).to.be.true;
    expect(deletePassword.calledOnceWithExactly('conn-1')).to.be.true;
    expect(closeConnection.calledOnce).to.be.true;
    expect((provider.refresh as sinon.SinonStub).calledOnce).to.be.true;
    expect(showInfo.calledOnce).to.be.true;
  });

  it('connects to a database string and closes the client', async () => {
    const context = { subscriptions: [] } as any;
    const provider = { refresh: sandbox.stub() } as unknown as DatabaseTreeProvider;
    const inputBox = sandbox.stub(vscode.window, 'showInputBox').resolves('postgresql://user:pass@localhost:5432/appdb');
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const connect = sandbox.stub(pg.Client.prototype, 'connect').resolves();
    const end = sandbox.stub(pg.Client.prototype, 'end').resolves();

    await cmdConnectDatabase(new DatabaseTreeItem('Primary', vscode.TreeItemCollapsibleState.Collapsed, 'connection', 'conn-1'), context, provider);

    expect(inputBox.calledOnce).to.be.true;
    expect(connect.calledOnce).to.be.true;
    expect(end.calledOnce).to.be.true;
    expect((provider.refresh as sinon.SinonStub).calledOnce).to.be.true;
    expect(showInfo.calledOnce).to.be.true;
  });

  it('skips connect when no connection string is provided', async () => {
    const context = { subscriptions: [] } as any;
    const provider = { refresh: sandbox.stub() } as unknown as DatabaseTreeProvider;
    const inputBox = sandbox.stub(vscode.window, 'showInputBox').resolves(undefined);
    const connect = sandbox.stub(pg.Client.prototype, 'connect').resolves();

    await cmdConnectDatabase(new DatabaseTreeItem('Primary', vscode.TreeItemCollapsibleState.Collapsed, 'connection', 'conn-1'), context, provider);

    expect(inputBox.calledOnce).to.be.true;
    expect(connect.called).to.be.false;
    expect((provider.refresh as sinon.SinonStub).called).to.be.false;
  });

  it('shows connection safety and runs edit command when requested', async () => {
    sandbox.stub(vscode.window, 'activeNotebookEditor').value({
      notebook: {
        metadata: {
          connectionId: 'conn-1',
          databaseName: 'appdb',
        },
      },
    } as any);
    configGetStub.returns([
      { id: 'conn-1', name: 'Primary', host: 'localhost', port: 5432, database: 'appdb', environment: 'production', readOnlyMode: true },
    ]);
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Edit Connection' as any);
    const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);

    await showConnectionSafety();

    expect(showInfo.calledOnce).to.be.true;
    expect(executeCommand.calledOnce).to.be.true;
  });

  it('reports when there is no active notebook for connection safety', async () => {
    sandbox.stub(vscode.window, 'activeNotebookEditor').value(undefined);
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    await showConnectionSafety();

    expect(showInfo.calledOnceWithExactly('No active PostgreSQL notebook')).to.be.true;
  });

  it('reveals the current notebook connection in the explorer', async () => {
    const provider = { revealItem: sandbox.stub().resolves() } as unknown as DatabaseTreeProvider;
    sandbox.stub(vscode.window, 'activeNotebookEditor').value({
      notebook: {
        metadata: {
          connectionId: 'conn-1',
          databaseName: 'appdb',
        },
      },
    } as any);

    await revealInExplorer(provider);

    expect((provider.revealItem as sinon.SinonStub).calledOnceWithExactly('conn-1', 'appdb')).to.be.true;
  });

  it('reports when there is no active notebook to reveal', async () => {
    const provider = { revealItem: sandbox.stub().resolves() } as unknown as DatabaseTreeProvider;
    sandbox.stub(vscode.window, 'activeNotebookEditor').value(undefined);
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    await revealInExplorer(provider);

    expect(showInfo.calledOnceWithExactly('No active PostgreSQL notebook')).to.be.true;
    expect((provider.revealItem as sinon.SinonStub).called).to.be.false;
  });
});