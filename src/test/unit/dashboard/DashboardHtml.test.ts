import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getHtmlForWebview } from '../../../dashboard/DashboardHtml';

describe('DashboardHtml', () => {
  let sandbox: sinon.SinonSandbox;
  let readFileStub: sinon.SinonStub;
  let joinPathStub: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    readFileStub = sandbox.stub();

    sandbox.stub(vscode.workspace, 'fs').value({
      readFile: readFileStub
    });

    joinPathStub = sandbox.stub(vscode.Uri, 'joinPath').callsFake((base, ...segments) => {
      return { fsPath: [base.fsPath, ...segments].join('/') } as vscode.Uri;
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('injects dashboard assets and escapes embedded stats safely', async () => {
    const extensionUri = { fsPath: '/ext' } as vscode.Uri;
    const webview = { cspSource: 'vscode-resource:' } as vscode.Webview;

    readFileStub.withArgs(sinon.match.has('fsPath', '/ext/templates/dashboard/index.html'))
      .resolves(new TextEncoder().encode(`
        <html>
          <head>
            <meta http-equiv="Content-Security-Policy" content="{{CSP}}">
            <style>{{INLINE_STYLES}}</style>
          </head>
          <body>
            <script type="application/json" id="dashboard-stats">{{STATS_JSON}}</script>
            <script nonce="{{NONCE}}">{{INLINE_SCRIPTS}}</script>
          </body>
        </html>
      `));
    readFileStub.withArgs(sinon.match.has('fsPath', '/ext/templates/dashboard/styles.css'))
      .resolves(new TextEncoder().encode('body { color: red; }'));
    readFileStub.withArgs(sinon.match.has('fsPath', '/ext/templates/dashboard/scripts.js'))
      .resolves(new TextEncoder().encode('console.log("ready");'));

    const html = await getHtmlForWebview(webview, extensionUri, {
      dbName: 'demo',
      owner: 'owner',
      size: '1 MB',
      activeConnections: 0,
      idleConnections: 0,
      waitingConnections: 0,
      totalConnections: 0,
      maxConnections: 100,
      extensionCount: 0,
      topTables: [],
      connectionStates: [],
      objectCounts: { schemas: 0, tables: 0, views: 0, functions: 0, sequences: 0 },
      activeQueries: [{
        pid: 1,
        usename: 'postgres',
        datname: 'demo',
        state: 'active',
        duration: '00:00:01',
        startTime: 'now',
        query: 'SELECT 1;</script><style>bad</style>'
      }],
      blockingLocks: [],
      metrics: {
        xact_commit: 0,
        xact_rollback: 0,
        blks_read: 0,
        blks_hit: 0,
        deadlocks: 0,
        conflicts: 0,
        temp_bytes: 0,
        temp_files: 0,
        checkpoints_timed: 0,
        checkpoints_req: 0,
        tuples_fetched: 0,
        tuples_returned: 0
      },
      waitEvents: [],
      longRunningQueries: 0
    });

    expect(html).to.contain('body { color: red; }');
    expect(html).to.contain('console.log("ready");');
    expect(html).to.contain('script-src \'nonce-');
    expect(html).to.contain('\\u003c/script\\u003e');
    expect(html).to.not.contain('</script><style>');
    expect(joinPathStub.called).to.be.true;
  });
});