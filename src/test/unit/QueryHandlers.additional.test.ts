import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ErrorHandlers } from '../../commands/helper';
import { ConnectionManager } from '../../services/ConnectionManager';
import { ConnectionUtils } from '../../utils/connectionUtils';
import {
  FkLookupHandler,
  ExecuteUpdateBackgroundHandler,
  ExecuteUpdateHandler,
  DeleteRowsHandler,
  ScriptDeleteHandler,
  SaveChangesHandler
} from '../../services/handlers/QueryHandlers';

describe('QueryHandlers (additional error branches)', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('ExecuteUpdateBackgroundHandler reports when notebook metadata has no connection', async () => {
    const err = sandbox.stub(ErrorHandlers, 'handleCommandError').resolves();
    const handler = new ExecuteUpdateBackgroundHandler();
    await handler.handle({ statements: ['SELECT 1'] }, { editor: { notebook: { metadata: {} } } as any } as any);
    expect(err.called).to.be.true;
    err.restore();
  });

  it('ExecuteUpdateHandler shows error when applyEdit fails', async () => {
    const prev = (vscode.workspace as any).applyEdit;
    (vscode.workspace as any).applyEdit = sandbox.stub().rejects(new Error('apply-fail'));
    const handler = new ExecuteUpdateHandler();
    try {
      await handler.handle({ statements: ['UPDATE t SET a = 1'], cellIndex: 0 }, { editor: { notebook: { uri: vscode.Uri.parse('untitled:nb'), metadata: {} } } } as any);
    } finally {
      (vscode.workspace as any).applyEdit = prev;
    }
    expect((vscode.window.showErrorMessage as any).called).to.be.true;
  });

  it('DeleteRowsHandler shows error when primary keys missing', async () => {
    const handler = new DeleteRowsHandler();
    await handler.handle({ tableInfo: { schema: 'public', table: 'users' }, rows: [{ id: 1 }] }, { editor: { notebook: { metadata: { connectionId: 'conn-1', databaseName: 'postgres' } } } } as any);
    expect((vscode.window.showErrorMessage as any).called).to.be.true;
  });

  it('ScriptDeleteHandler forwards errors to ErrorHandlers', async () => {
    const prev = (vscode.workspace as any).applyEdit;
    (vscode.workspace as any).applyEdit = sandbox.stub().rejects(new Error('boom'));
    const err = sandbox.stub(ErrorHandlers, 'handleCommandError').resolves();
    const handler = new ScriptDeleteHandler();
    try {
      await handler.handle({ schema: 's', table: 't', primaryKeys: ['id'], rows: [{ id: 1 }], cellIndex: 0 }, { editor: { notebook: { uri: vscode.Uri.parse('untitled:nb'), metadata: {} } } } as any);
    } finally {
      (vscode.workspace as any).applyEdit = prev;
    }
    expect(err.called).to.be.true;
  });

  it('SaveChangesHandler warns when no connection in notebook metadata', async () => {
    const handler = new SaveChangesHandler();
    await handler.handle({ tableInfo: { schema: 'public', table: 'users' }, updates: [], deletions: [] }, { editor: { notebook: { metadata: {} } } } as any);
    expect((vscode.window.showErrorMessage as any).called).to.be.true;
  });

  it('FkLookupHandler posts matching rows and clamps the limit', async () => {
    const query = sandbox.stub().resolves({
      rows: [{ id: 1, name: 'Ada' }],
      fields: [{ name: 'id' }, { name: 'name' }]
    });
    const release = sandbox.stub();
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves({ query, release })
    } as any);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'conn-1',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'postgres'
    } as any);
    const postMessage = sandbox.stub().resolves(true);

    const handler = new FkLookupHandler();
    await handler.handle(
      {
        requestId: 'req-1',
        fkSchema: 'public',
        fkTable: 'users',
        fkColumn: 'name',
        searchText: '  Ada  ',
        limit: 250
      },
      {
        editor: {
          notebook: {
            metadata: {
              connectionId: 'conn-1',
              databaseName: 'postgres'
            }
          }
        } as any,
        postMessage
      }
    );

    expect(query.calledOnce).to.be.true;
    const [sql, params] = query.firstCall.args;
    expect(sql).to.contain('SELECT "name"');
    expect(sql).to.contain('FROM "public"."users"');
    expect(sql).to.contain('ILIKE $2');
    expect(params).to.deep.equal(['Ada', '%Ada%', 100]);
    expect(postMessage.calledOnceWithMatch({
      type: 'fkLookupResponse',
      requestId: 'req-1',
      rows: [{ id: 1, name: 'Ada' }],
      columns: ['id', 'name']
    })).to.be.true;
    expect(release.calledOnce).to.be.true;
  });

  it('FkLookupHandler returns an empty response when connection lookup fails', async () => {
    sandbox.stub(ConnectionUtils, 'findConnection').returns(undefined);
    const postMessage = sandbox.stub().resolves(true);

    const handler = new FkLookupHandler();
    await handler.handle(
      {
        requestId: 'req-2',
        fkSchema: 'public',
        fkTable: 'users',
        fkColumn: 'name',
        searchText: 'Ada',
        limit: 10
      },
      {
        editor: {
          notebook: {
            metadata: {
              connectionId: 'conn-1',
              databaseName: 'postgres'
            }
          }
        } as any,
        postMessage
      }
    );

    expect(postMessage.calledOnceWithMatch({
      type: 'fkLookupResponse',
      requestId: 'req-2',
      rows: [],
      columns: []
    })).to.be.true;
    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith(sinon.match(/^FK lookup failed:/))).to.be
      .true;
  });

  it('FkLookupHandler ignores requests without an editor or connection metadata', async () => {
    const handler = new FkLookupHandler();
    const postMessage = sandbox.stub();

    await handler.handle({ requestId: 'req-3' }, {} as any);
    await handler.handle(
      { requestId: 'req-4' },
      {
        editor: {
          notebook: { metadata: {} }
        } as any,
        postMessage
      }
    );

    expect(postMessage.called).to.be.false;
  });

  it('handlers return early when no editor provided', async () => {
    // Call handlers with empty context to hit early return branches
    await new ExecuteUpdateBackgroundHandler().handle({}, {} as any);
    await new ExecuteUpdateHandler().handle({}, {} as any);
    await new DeleteRowsHandler().handle({}, {} as any);
    await new ScriptDeleteHandler().handle({}, {} as any);
    await new SaveChangesHandler().handle({}, {} as any);
  });

  it('ExecuteUpdateBackgroundHandler handles per-statement query errors and reports counts', async () => {
    const query = sandbox.stub();
    query.onCall(0).resolves({ rowCount: 1 });
    query.onCall(1).rejects(new Error('stmt-fail'));
    const release = sandbox.stub();
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient: sandbox.stub().resolves({ query, release }) } as any);
    const err = sandbox.stub(ErrorHandlers, 'handleCommandError').resolves();

    await new ExecuteUpdateBackgroundHandler().handle({ statements: ['s1', 's2'] }, { editor: { notebook: { metadata: { connectionId: 'c1', host: 'h', port: 1, username: 'u', databaseName: 'db' } } } } as any);

    // should have attempted both statements and recorded an error
    expect(query.calledTwice).to.be.true;
    expect(err.called).to.be.true;
    expect((vscode.window.showInformationMessage as any).called).to.be.true;
    err.restore();
  });

  it('DeleteRowsHandler supports legacy single `row` payload and rolls back on failure', async () => {
    const query = sandbox.stub();
    query.onCall(0).resolves({}); // BEGIN
    query.onCall(1).rejects(new Error('delete-fail'));
    query.onCall(2).resolves({}); // ROLLBACK
    const release = sandbox.stub();
    const getSessionClient = sandbox.stub().resolves({ query });
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getSessionClient } as any);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({ host: 'h', port: 1, username: 'u', database: 'db' } as any);

    const handler = new DeleteRowsHandler();
    await handler.handle(
      {
        tableInfo: { schema: 'public', table: 'users', primaryKeys: ['id'] },
        row: { id: 1 }
      },
      {
        editor: {
          notebook: { uri: { toString: () => 'notebook-uri' }, metadata: { connectionId: 'conn-1', databaseName: 'postgres' } }
        }
      } as any
    );

    expect(query.called).to.be.true;
    expect(query.calledWith('ROLLBACK')).to.be.true;
  });

  it('ExecuteUpdateBackgroundHandler with all statements failing reports errors but no info message', async () => {
    const query = sandbox.stub().rejects(new Error('fail-all'));
    const release = sandbox.stub();
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient: sandbox.stub().resolves({ query, release }) } as any);
    const err = sandbox.stub(ErrorHandlers, 'handleCommandError').resolves();

    await new ExecuteUpdateBackgroundHandler().handle({ statements: ['s1', 's2'] }, { editor: { notebook: { metadata: { connectionId: 'c1', host: 'h', port: 1, username: 'u', databaseName: 'db' } } } } as any);

    expect(err.called).to.be.true;
    expect((vscode.window.showInformationMessage as any).called).to.be.false;
    err.restore();
  });
});
