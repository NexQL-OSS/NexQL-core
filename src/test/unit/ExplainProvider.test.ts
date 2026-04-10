import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { ExplainProvider } from '../../providers/ExplainProvider';

describe('ExplainProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let panel: any;
  let disposeCallback: (() => void) | undefined;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    disposeCallback = undefined;
    (ExplainProvider as any).panel = undefined;

    panel = {
      webview: {
        html: '',
        onDidReceiveMessage: sandbox.stub().returns({ dispose: () => {} }),
        postMessage: sandbox.stub().resolves(true),
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: 'vscode-resource'
      },
      reveal: sandbox.stub(),
      onDidDispose: (callback: () => void) => {
        disposeCallback = callback;
        return { dispose: () => {} };
      },
      dispose: sandbox.stub()
    };

    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel as any);
  });

  afterEach(() => {
    sandbox.restore();
    (ExplainProvider as any).panel = undefined;
  });

  it('renders a plan tree with query and extras, then reuses the panel', () => {
    const plan = [{
      Plan: {
        'Node Type': 'Nested Loop',
        'Startup Cost': 1.25,
        'Total Cost': 9.5,
        'Actual Startup Time': 0.1,
        'Actual Total Time': 0.3,
        'Actual Rows': 5,
        'Actual Loops': 2,
        'Relation Name': 'users',
        Schema: 'public',
        'Index Name': 'users_pkey',
        Filter: 'id > 10',
        'Join Filter': 'users.id = orders.user_id',
        'Hash Cond': 'users.id = orders.user_id',
        'Merge Cond': 'users.id = orders.user_id',
        'Rows Removed by Filter': 3,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Plan Rows': 12
          }
        ]
      }
    }];

    ExplainProvider.show(vscode.Uri.file('/ext'), plan, 'SELECT * FROM users');

    expect((vscode.window.createWebviewPanel as sinon.SinonStub).calledOnce).to.be.true;
    expect(panel.webview.html).to.contain('EXPLAIN ANALYZE');
    expect(panel.webview.html).to.contain('SELECT * FROM users');
    expect(panel.webview.html).to.contain('Nested Loop');
    expect(panel.webview.html).to.contain('Cost: 1.25 → 9.5');
    expect(panel.webview.html).to.contain('Actual: 0.1ms → 0.3ms');
    expect(panel.webview.html).to.contain('Rows: 5');
    expect(panel.webview.html).to.contain('Loops: 2');
    expect(panel.webview.html).to.contain('Relation Name');
    expect(panel.webview.html).to.contain('Seq Scan');
    expect(panel.reveal.calledOnce).to.be.true;

    ExplainProvider.show(vscode.Uri.file('/ext'), [{ Plan: { 'Node Type': 'Result' } }], 'SELECT 2');

    expect((vscode.window.createWebviewPanel as sinon.SinonStub).calledOnce).to.be.true;
    expect(panel.webview.html).to.contain('SELECT 2');
    expect(panel.reveal.calledTwice).to.be.true;
  });

  it('creates a fresh panel after disposal', () => {
    ExplainProvider.show(vscode.Uri.file('/ext'), [{ Plan: { 'Node Type': 'Result' } }], 'SELECT 1');
    expect((vscode.window.createWebviewPanel as sinon.SinonStub).calledOnce).to.be.true;

    disposeCallback?.();

    ExplainProvider.show(vscode.Uri.file('/ext'), [{ Plan: { 'Node Type': 'Result' } }], 'SELECT 2');
    expect((vscode.window.createWebviewPanel as sinon.SinonStub).calledTwice).to.be.true;
  });
});