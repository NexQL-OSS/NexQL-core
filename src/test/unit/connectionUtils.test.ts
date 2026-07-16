import { expect } from 'chai';
import * as sinon from 'sinon';
import * as pg from 'pg';
import * as vscode from 'vscode';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { SecretStorageService } from '../../services/SecretStorageService';
import { ConnectionManager } from '../../services/ConnectionManager';

describe('ConnectionUtils', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('findConnection returns matching connection', () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string) =>
        key === 'postgresExplorer.connections' ? [{ id: 'a', host: 'h' }] : undefined
    } as unknown as vscode.WorkspaceConfiguration);

    expect(ConnectionUtils.findConnection('a')).to.deep.include({ id: 'a' });
    expect(ConnectionUtils.findConnection('missing')).to.equal(undefined);
  });

  it('getConnections defaults to empty array', () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: () => undefined
    } as unknown as vscode.WorkspaceConfiguration);

    expect(ConnectionUtils.getConnections()).to.deep.equal([]);
  });

  describe('getActivePostgresNotebook', () => {
    it('returns undefined when no active editor', () => {
      sandbox.stub(vscode.window, 'activeNotebookEditor').value(undefined);
      expect(ConnectionUtils.getActivePostgresNotebook()).to.equal(undefined);
    });

    it('returns undefined when notebook type is not postgres', () => {
      sandbox.stub(vscode.window, 'activeNotebookEditor').value({
        notebook: { notebookType: 'jupyter-notebook' }
      });
      expect(ConnectionUtils.getActivePostgresNotebook()).to.equal(undefined);
    });

    it('returns editor for postgres-notebook', () => {
      const ed = { notebook: { notebookType: 'postgres-notebook' } };
      sandbox.stub(vscode.window, 'activeNotebookEditor').value(ed);
      expect(ConnectionUtils.getActivePostgresNotebook()).to.equal(ed);
    });

    it('returns editor for postgres-query', () => {
      const ed = { notebook: { notebookType: 'postgres-query' } };
      sandbox.stub(vscode.window, 'activeNotebookEditor').value(ed);
      expect(ConnectionUtils.getActivePostgresNotebook()).to.equal(ed);
    });
  });

  describe('updateNotebookMetadata', () => {
    it('merges metadata and applies workspace edit', async () => {
      const applyEdit = sandbox.stub().resolves(true);
      (vscode.workspace as any).applyEdit = applyEdit;
      const notebook = {
        uri: vscode.Uri.parse('untitled:nb'),
        metadata: { connectionId: 'c1' }
      } as vscode.NotebookDocument;
      await ConnectionUtils.updateNotebookMetadata(notebook, { databaseName: 'db2' });
      expect(applyEdit.calledOnce).to.be.true;
    });
  });

  describe('listDatabases', () => {
    it('queries pg_database and closes client', async () => {
      const mockClient = {
        query: sandbox.stub().resolves({
          rows: [{ datname: 'postgres' }, { datname: 'app' }]
        }),
        release: sandbox.stub()
      };
      sandbox.stub(ConnectionManager.getInstance(), 'getPooledClient').resolves(mockClient as any);

      const dbs = await ConnectionUtils.listDatabases({
        id: 'id1',
        host: 'localhost',
        port: 5432,
        username: 'u',
        password: 'inline'
      });

      expect(dbs).to.deep.equal(['postgres', 'app']);
      expect(mockClient.query.calledOnce).to.be.true;
      expect(mockClient.release.calledOnce).to.be.true;
    });
  });

  describe('showConnectionPicker', () => {
    it('warns and returns undefined when no connections', async () => {
      const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
      sandbox.stub(vscode.workspace, 'getConfiguration').returns({
        get: () => []
      } as unknown as vscode.WorkspaceConfiguration);

      expect(await ConnectionUtils.showConnectionPicker()).to.equal(undefined);
      expect(warn.calledWithMatch(/No database connections/)).to.be.true;
    });

    it('returns selected connection', async () => {
      const conn = { id: 'c1', name: 'N', host: 'h', port: 5432, database: 'db' };
      sandbox.stub(vscode.workspace, 'getConfiguration').returns({
        get: () => [conn]
      } as unknown as vscode.WorkspaceConfiguration);
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ connection: conn } as vscode.QuickPickItem);

      expect(await ConnectionUtils.showConnectionPicker()).to.equal(conn);
    });
  });

  describe('showDatabasePicker', () => {
    it('returns selected database', async () => {
      sandbox.stub(ConnectionUtils, 'listDatabases').resolves(['db1', 'db2']);
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ database: 'db1' } as vscode.QuickPickItem);

      expect(await ConnectionUtils.showDatabasePicker({ id: 'x' }, 'db2')).to.equal('db1');
    });

    it('returns undefined and shows error when listing databases fails', async () => {
      sandbox.stub(ConnectionUtils, 'listDatabases').rejects(new Error('conn refused'));
      const err = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

      expect(await ConnectionUtils.showDatabasePicker({ id: 'x' })).to.equal(undefined);
      expect(err.calledWithMatch(/Failed to list databases/)).to.be.true;
    });
  });
});
