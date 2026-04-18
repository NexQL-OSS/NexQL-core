import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ConnectionManager } from '../../../services/ConnectionManager';
import { ConnectionUtils } from '../../../utils/connectionUtils';
import { FkLookupHandler } from '../../../services/handlers/FkLookupHandler';

describe('FkLookupHandler', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns FK rows and columns on success', async () => {
    const query = sandbox.stub().resolves({
      rows: [{ id: 1 }, { id: 2 }],
      fields: [{ name: 'id' }],
    });
    const release = sandbox.stub();
    sandbox.stub(ConnectionManager, 'getInstance').returns({
      getPooledClient: sandbox.stub().resolves({ query, release }),
    } as any);
    sandbox.stub(ConnectionUtils, 'findConnection').returns({
      id: 'conn-1',
      host: 'localhost',
      port: 5432,
      username: 'u',
      database: 'db',
    } as any);

    const postMessage = sandbox.stub().resolves(true);
    await new FkLookupHandler().handle(
      {
        type: 'fkLookup',
        requestId: 'req-1',
        fkSchema: 'public',
        fkTable: 'ref',
        fkColumn: 'id',
        searchText: '',
        limit: 50,
      } as any,
      {
        editor: {
          notebook: {
            metadata: { connectionId: 'conn-1' },
          },
        },
        postMessage,
      } as any,
    );

    expect(query.calledOnce).to.be.true;
    expect(
      postMessage.calledOnceWithMatch({
        type: 'fkLookupResponse',
        requestId: 'req-1',
        rows: [{ id: 1 }, { id: 2 }],
        columns: ['id'],
      }),
    ).to.be.true;
    expect(release.calledOnce).to.be.true;
  });

  it('posts empty result when connection is missing', async () => {
    sandbox.stub(ConnectionUtils, 'findConnection').returns(undefined as any);
    const postMessage = sandbox.stub().resolves(true);
    const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

    await new FkLookupHandler().handle(
      {
        type: 'fkLookup',
        requestId: 'req-2',
        fkSchema: 'public',
        fkTable: 'ref',
        fkColumn: 'id',
        searchText: '',
        limit: 50,
      } as any,
      {
        editor: {
          notebook: {
            metadata: { connectionId: 'missing' },
          },
        },
        postMessage,
      } as any,
    );

    expect(showError.calledOnce).to.be.true;
    expect(
      postMessage.calledOnceWithMatch({
        type: 'fkLookupResponse',
        requestId: 'req-2',
        rows: [],
        columns: [],
      }),
    ).to.be.true;
  });
});
