import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/ConnectionManager';
import {
  ExportRequestHandler,
  ImportRequestHandler,
  ImportPickFileHandler,
  RetryCellHandler,
  ShowConnectionSwitcherHandler,
  ShowConnectionInfoHandler,
  ShowDatabaseSwitcherHandler,
  ShowErrorMessageHandler
} from '../../services/handlers/CoreHandlers';
import { ConnectionUtils } from '../../utils/connectionUtils';

describe('CoreHandlers', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('ShowConnectionSwitcherHandler updates metadata when connection changes', async () => {
    const statusBar = { update: sandbox.stub() };
    const handler = new ShowConnectionSwitcherHandler(statusBar);
    sandbox.stub(ConnectionUtils, 'showConnectionPicker').resolves({
      id: 'c2',
      name: 'b',
      database: 'db2',
      host: 'h',
      port: 5432,
      username: 'u'
    });
    const update = sandbox.stub(ConnectionUtils, 'updateNotebookMetadata').resolves();

    await handler.handle(
      { connectionId: 'c1' },
      {
        editor: { notebook: { metadata: {} } } as unknown as vscode.NotebookEditor
      }
    );

    expect(update.calledOnce).to.be.true;
    expect(statusBar.update.calledOnce).to.be.true;
  });

  it('ShowConnectionSwitcherHandler does nothing when picker returns same id', async () => {
    const handler = new ShowConnectionSwitcherHandler({ update: sandbox.stub() });
    sandbox.stub(ConnectionUtils, 'showConnectionPicker').resolves({
      id: 'c1',
      database: 'db',
      host: 'h',
      port: 5432,
      username: 'u'
    });
    const update = sandbox.stub(ConnectionUtils, 'updateNotebookMetadata').resolves();

    await handler.handle(
      { connectionId: 'c1' },
      {
        editor: { notebook: {} } as unknown as vscode.NotebookEditor
      }
    );

    expect(update.called).to.be.false;
  });

  it('ShowDatabaseSwitcherHandler updates database when picker changes', async () => {
    const statusBar = { update: sandbox.stub() };
    const handler = new ShowDatabaseSwitcherHandler(statusBar);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      database: 'postgres'
    });
    sandbox.stub(ConnectionUtils, 'showDatabasePicker').resolves('otherdb');
    const update = sandbox.stub(ConnectionUtils, 'updateNotebookMetadata').resolves();

    await handler.handle(
      { connectionId: 'c1', currentDatabase: 'postgres' },
      {
        editor: { notebook: { metadata: {} } } as unknown as vscode.NotebookEditor
      }
    );

    expect(update.calledOnce).to.be.true;
    expect(statusBar.update.calledOnce).to.be.true;
  });

  it('ShowDatabaseSwitcherHandler shows error when connection missing', async () => {
    const handler = new ShowDatabaseSwitcherHandler({ update: sandbox.stub() });
    sandbox.stub(ConnectionUtils, 'findConnection').returns(undefined);

    await handler.handle(
      { connectionId: 'c1', currentDatabase: 'postgres' },
      {
        editor: { notebook: {} } as unknown as vscode.NotebookEditor
      }
    );

    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('Connection not found')).to.be
      .true;
  });

  it('ShowDatabaseSwitcherHandler does nothing when the database stays the same', async () => {
    const statusBar = { update: sandbox.stub() };
    const handler = new ShowDatabaseSwitcherHandler(statusBar);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      database: 'postgres'
    });
    sandbox.stub(ConnectionUtils, 'showDatabasePicker').resolves('postgres');
    const update = sandbox.stub(ConnectionUtils, 'updateNotebookMetadata').resolves();

    await handler.handle(
      { connectionId: 'c1', currentDatabase: 'postgres' },
      {
        editor: { notebook: { metadata: {} } } as unknown as vscode.NotebookEditor
      }
    );

    expect(update.called).to.be.false;
    expect(statusBar.update.called).to.be.false;
  });

  it('handlers return early when no editor is provided', async () => {
    const statusBar = { update: sandbox.stub() };
    await new ShowConnectionSwitcherHandler(statusBar).handle({ connectionId: 'c1' }, {} as any);
    await new ShowDatabaseSwitcherHandler(statusBar).handle({ connectionId: 'c1', currentDatabase: 'postgres' }, {} as any);
    await new ImportPickFileHandler().handle({ table: 't', schema: 'public' }, {} as any);
    await new ImportRequestHandler().handle({ data: [{ a: 1 }] }, {} as any);
    await new RetryCellHandler().handle({}, {} as any);
    await new ShowConnectionInfoHandler().handle({}, {} as any);
  });

  it('ImportPickFileHandler returns early when no file is selected', async () => {
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'u',
      database: 'postgres'
    });
    const prevOpenDialog = (vscode.window as any).showOpenDialog;
    (vscode.window as any).showOpenDialog = async () => undefined;

    const handler = new ImportPickFileHandler();
    try {
      await handler.handle(
        { table: 'users', schema: 'public' },
        {
          editor: {
            notebook: {
              metadata: { connectionId: 'c1' }
            }
          } as any
        }
      );
    } finally {
      (vscode.window as any).showOpenDialog = prevOpenDialog;
    }

    expect((vscode.window.showErrorMessage as sinon.SinonStub).called).to.be.false;
  });

  it('ImportPickFileHandler rejects JSON files that are not arrays', async () => {
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'u',
      database: 'postgres'
    });
    const prevOpenDialog = (vscode.window as any).showOpenDialog;
    (vscode.window as any).showOpenDialog = async () => [vscode.Uri.file('/tmp/input.json')];
    sandbox.stub(vscode.workspace.fs, 'readFile').resolves(Buffer.from('{"id":1}'));

    const handler = new ImportPickFileHandler();
    try {
      await handler.handle(
        { table: 'users', schema: 'public' },
        {
          editor: {
            notebook: {
              metadata: { connectionId: 'c1' }
            }
          } as any
        }
      );
    } finally {
      (vscode.window as any).showOpenDialog = prevOpenDialog;
    }

    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('JSON file must contain an array of objects.')).to
      .be.true;
  });

  it('ImportPickFileHandler warns when CSV data has no rows', async () => {
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'u',
      database: 'postgres'
    });
    const prevOpenDialog = (vscode.window as any).showOpenDialog;
    (vscode.window as any).showOpenDialog = async () => [vscode.Uri.file('/tmp/input.csv')];
    sandbox.stub(vscode.workspace.fs, 'readFile').resolves(Buffer.from('id,name\n'));
    const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const handler = new ImportPickFileHandler();
    try {
      await handler.handle(
        { table: 'users', schema: 'public' },
        {
          editor: {
            notebook: {
              metadata: { connectionId: 'c1' }
            }
          } as any
        }
      );
    } finally {
      (vscode.window as any).showOpenDialog = prevOpenDialog;
    }

    expect(warning.calledWith('File contains no data rows.')).to.be.true;
  });

  it('ImportPickFileHandler imports CSV data and skips conflicts', async () => {
    const query = sandbox.stub();
    const release = sandbox.stub();
    query.onCall(0).resolves({});
    query.onCall(1).resolves({
      rows: [
        { column_name: 'id', column_default: null, is_identity: 'NO' },
        { column_name: 'name', column_default: null, is_identity: 'NO' }
      ]
    });
    query.onCall(2).resolves({ rowCount: 1 });
    query.onCall(3).resolves({});

    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves({ query, release })
    } as unknown as ConnectionManager);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'u',
      database: 'postgres'
    });
    const prevOpenDialog = (vscode.window as any).showOpenDialog;
    (vscode.window as any).showOpenDialog = async () => [vscode.Uri.file('/tmp/input.csv')];
    sandbox.stub(vscode.workspace.fs, 'readFile').resolves(Buffer.from('id,name\n1,"Ada, Lovelace"\n'));
    sandbox.stub(vscode.window, 'showQuickPick').resolves({
      label: 'Skip duplicates',
      value: 'skip'
    } as any);

    const handler = new ImportPickFileHandler();
    try {
      await handler.handle(
        { table: 'users', schema: 'public' },
        {
          editor: {
            notebook: {
              metadata: { connectionId: 'c1' }
            }
          } as any
        }
      );
    } finally {
      (vscode.window as any).showOpenDialog = prevOpenDialog;
    }

    expect(query.firstCall.args[0]).to.equal('BEGIN');
    expect(query.getCall(1).args[0]).to.contain('information_schema.columns');
    expect(query.getCall(2).args[0]).to.contain('INSERT INTO "public"."users"');
    expect(query.getCall(2).args[0]).to.contain('ON CONFLICT DO NOTHING');
    expect(query.getCall(2).args[1]).to.deep.equal(['1', 'Ada, Lovelace']);
    expect(query.lastCall.args[0]).to.equal('COMMIT');
    expect(release.calledOnce).to.be.true;
    expect((vscode.window.showInformationMessage as sinon.SinonStub).calledWith(sinon.match(/^Successfully imported 1 rows/))).to
      .be.true;
  });

  it('RetryCellHandler re-executes the notebook cell', async () => {
    const execute = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    const handler = new RetryCellHandler();
    await handler.handle(
      {},
      {
        editor: {
          notebook: {
            getCells: sandbox.stub().returns([])
          }
        } as any
      }
    );

    expect(execute.calledWith('notebook.cell.execute')).to.be.true;
  });

  it('ShowConnectionInfoHandler displays the active connection details', async () => {
    const config = {
      get: sandbox.stub().returns([
        { id: 'c1', name: 'Primary', host: 'localhost', port: 5432, database: 'postgres' }
      ])
    };
    sandbox.stub(vscode.workspace, 'getConfiguration').returns(config as any);

    const handler = new ShowConnectionInfoHandler();
    await handler.handle(
      {},
      {
        editor: {
          notebook: {
            metadata: { connectionId: 'c1', databaseName: 'postgres' }
          }
        } as any
      }
    );

    expect((vscode.window.showInformationMessage as sinon.SinonStub).calledWith(
      'Connection: Primary | Host: localhost:5432 | Database: postgres'
    )).to.be.true;
  });

  it('ImportRequestHandler imports rows in batches', async () => {
    const handler = new ImportRequestHandler();
    const query = sandbox.stub();
    const release = sandbox.stub();
    const getPooled = sandbox.stub().resolves({ query, release });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: getPooled
    } as unknown as ConnectionManager);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'u',
      database: 'postgres'
    });

    query.onCall(0).resolves({});
    query.onCall(1).resolves({
      rows: [
        { column_name: 'a', column_default: null, is_identity: 'NO' },
        { column_name: 'b', column_default: null, is_identity: 'NO' }
      ]
    });
    query.onCall(2).resolves({ rowCount: 1 });
    query.onCall(3).resolves({});

    await handler.handle(
      {
        table: 't',
        schema: 'public',
        data: [{ a: 1, b: 'x' }]
      },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(query.firstCall.args[0]).to.equal('BEGIN');
    expect(query.getCall(1).args[0]).to.contain('information_schema.columns');
    expect(query.getCall(2).args[0]).to.contain('INSERT INTO');
    expect(query.getCall(2).args[1]).to.deep.equal([1, 'x']);
    expect(query.getCall(3).args[0]).to.equal('COMMIT');
    expect(release.calledOnce).to.be.true;
  });

  it('ImportRequestHandler shows error when notebook has no connectionId', async () => {
    const handler = new ImportRequestHandler();
    await handler.handle(
      { table: 't', schema: 'public', data: [{ a: 1 }] },
      {
        editor: {
          notebook: { metadata: {} }
        } as unknown as vscode.NotebookEditor
      }
    );
    expect(
      (vscode.window.showErrorMessage as sinon.SinonStub).calledWith('No active connection found for this notebook.')
    ).to.be.true;
  });

  it('ImportRequestHandler shows error when connection is missing from settings', async () => {
    const handler = new ImportRequestHandler();
    sandbox.stub(ConnectionUtils, 'findConnection').returns(undefined);
    await handler.handle(
      { table: 't', schema: 'public', data: [{ a: 1 }] },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1' } }
        } as unknown as vscode.NotebookEditor
      }
    );
    expect(
      (vscode.window.showErrorMessage as sinon.SinonStub).calledWith('Connection configuration not found.')
    ).to.be.true;
  });

  it('ImportRequestHandler rolls back and shows error when insert fails', async () => {
    const handler = new ImportRequestHandler();
    const query = sandbox.stub();
    const release = sandbox.stub();
    const getPooled = sandbox.stub().resolves({ query, release });
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: getPooled
    } as unknown as ConnectionManager);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'c1',
      host: 'localhost',
      port: 5432,
      username: 'u',
      database: 'postgres'
    });

    query.onCall(0).resolves({});
    query.onCall(1).rejects(new Error('constraint failed'));

    await handler.handle(
      { table: 't', schema: 'public', data: [{ a: 1 }] },
      {
        editor: {
          notebook: { metadata: { connectionId: 'c1' } }
        } as unknown as vscode.NotebookEditor
      }
    );

    expect(query.getCall(2).args[0]).to.equal('ROLLBACK');
    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith(sinon.match(/Import failed: constraint failed/))).to.be
      .true;
    expect(release.calledOnce).to.be.true;
  });

  it('ImportRequestHandler warns when no data', async () => {
    const messages: string[] = [];
    const prev = vscode.window.showWarningMessage;
    (vscode.window as any).showWarningMessage = async (msg: string) => {
      messages.push(msg);
      return undefined;
    };
    const handler = new ImportRequestHandler();
    sandbox.stub(ConnectionUtils, 'findConnection').returns({ id: 'c1' });
    try {
      await handler.handle(
        { table: 't', schema: 'public', data: [] },
        {
          editor: {
            notebook: { metadata: { connectionId: 'c1' } }
          } as unknown as vscode.NotebookEditor
        }
      );
      expect(messages).to.include('No data received for import.');
    } finally {
      (vscode.window as any).showWarningMessage = prev;
    }
  });

  it('ExportRequestHandler copies CSV to clipboard', async () => {
    const handler = new ExportRequestHandler();
    const prevPick = vscode.window.showQuickPick;
    (vscode.window as any).showQuickPick = async () => 'Copy to Clipboard';
    const prevEnv = vscode.env;
    const writeText = sandbox.stub().resolves();
    (vscode as any).env = {
      clipboard: { writeText }
    };
    try {
      await handler.handle({
        rows: [{ id: 1, name: 'a' }],
        columns: ['id', 'name']
      });
      expect(writeText.calledOnce).to.be.true;
    } finally {
      (vscode.window as any).showQuickPick = prevPick;
      (vscode as any).env = prevEnv;
    }
  });

  it('ExportRequestHandler saves CSV when save dialog returns uri', async () => {
    const handler = new ExportRequestHandler();
    const prevPick = vscode.window.showQuickPick;
    const prevSave = vscode.window.showSaveDialog;
    (vscode.window as any).showQuickPick = async () => 'Save as CSV';
    const uri = vscode.Uri.file('/tmp/out.csv');
    (vscode.window as any).showSaveDialog = async () => uri;
    const writeFile = sandbox.stub(vscode.workspace.fs, 'writeFile').resolves();
    try {
      await handler.handle({
        rows: [{ id: 1 }],
        columns: ['id']
      });
      expect(writeFile.calledOnce).to.be.true;
    } finally {
      (vscode.window as any).showQuickPick = prevPick;
      (vscode.window as any).showSaveDialog = prevSave;
    }
  });

  it('ExportRequestHandler saves JSON when selected', async () => {
    const handler = new ExportRequestHandler();
    const prevPick = vscode.window.showQuickPick;
    const prevSave = vscode.window.showSaveDialog;
    (vscode.window as any).showQuickPick = async () => 'Save as JSON';
    const uri = vscode.Uri.file('/tmp/out.json');
    (vscode.window as any).showSaveDialog = async () => uri;
    const writeFile = sandbox.stub(vscode.workspace.fs, 'writeFile').resolves();
    try {
      await handler.handle({
        rows: [{ id: 1 }],
        columns: ['id']
      });
      expect(writeFile.calledOnce).to.be.true;
    } finally {
      (vscode.window as any).showQuickPick = prevPick;
      (vscode.window as any).showSaveDialog = prevSave;
    }
  });

  it('ShowErrorMessageHandler forwards message', async () => {
    const handler = new ShowErrorMessageHandler();
    await handler.handle({ message: 'boom' });
    expect((vscode.window.showErrorMessage as sinon.SinonStub).calledWith('boom')).to.be.true;
  });
});
