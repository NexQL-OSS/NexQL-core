import { expect } from 'chai';
import * as sinon from 'sinon';
import { JSDOM } from 'jsdom';

import { createActionBar } from '../../renderer/components/ActionBar';
import { createErrorPanel } from '../../renderer/components/ErrorPanel';
import { createTopBar } from '../../renderer/components/TopBar';
import { createTransactionBanner } from '../../renderer/components/TransactionBanner';
import { createBreadcrumb, createButton, createTab } from '../../renderer/components/ui';

describe('renderer surface components', () => {
  let dom: JSDOM;
  let windowRef: any;
  let documentRef: any;
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: 'http://localhost/' });
    windowRef = dom.window;
    documentRef = windowRef.document;

    (global as any).window = windowRef;
    (global as any).document = documentRef;
    (global as any).HTMLElement = windowRef.HTMLElement;
    (global as any).MouseEvent = windowRef.MouseEvent;
    (global as any).Event = windowRef.Event;
  });

  afterEach(() => {
    sandbox.restore();
    dom.window.close();
  });

  it('creates reusable buttons, tabs, and breadcrumbs', () => {
    const button = createButton('Save');
    expect(button.innerText).to.equal('Save');
    expect(button.style.padding).to.equal('6px 12px');
    button.onmouseover?.(new windowRef.Event('mouseover') as any);
    expect(button.style.background).to.contain('var(--vscode-button-secondaryHoverBackground)');
    button.onmouseout?.(new windowRef.Event('mouseout') as any);
    expect(button.style.background).to.contain('var(--vscode-button-secondaryBackground)');

    const smallButton = createButton('Small', true);
    expect(smallButton.style.padding).to.equal('4px 8px');
    expect(smallButton.style.fontSize).to.equal('11px');

    const tabClick = sandbox.spy();
    const activeTab = createTab('SQL', 'sql-tab', true, tabClick);
    expect(activeTab.textContent).to.equal('SQL');
    expect(activeTab.style.opacity).to.equal('1');
    activeTab.click();
    expect(tabClick.calledOnce).to.be.true;

    const inactiveTab = createTab('History', 'history-tab', false, () => {});
    expect(inactiveTab.style.opacity).to.equal('0.6');

    const connectionDropdown = sandbox.spy();
    const databaseDropdown = sandbox.spy();
    const breadcrumb = createBreadcrumb(
      [
        { label: 'Local', id: 'connection', type: 'connection' },
        { label: 'postgres', id: 'database', type: 'database' },
        { label: 'public', id: 'schema', type: 'schema' },
        { label: 'users', id: 'object', type: 'object', isLast: true },
      ],
      { onConnectionDropdown: connectionDropdown, onDatabaseDropdown: databaseDropdown }
    );

    expect(breadcrumb.children).to.have.lengthOf(7);
    expect(breadcrumb.children[0].textContent).to.contain('🗄️');
    expect(breadcrumb.children[2].textContent).to.contain('🗃️');
    (breadcrumb.children[0] as HTMLElement).click();
    (breadcrumb.children[2] as HTMLElement).click();
    expect(connectionDropdown.calledOnce).to.be.true;
    expect(databaseDropdown.calledOnce).to.be.true;
  });

  it('creates error panels and action bars with working callbacks', () => {
    const explain = sandbox.spy();
    const fix = sandbox.spy();
    const retry = sandbox.spy();

    const panel = createErrorPanel({
      errorCode: '23505',
      errorMessage: 'duplicate key value',
      explanation: 'The row already exists.',
      onExplainError: explain,
      onFixWithAI: fix,
      onRetry: retry,
    });

    expect(panel.textContent).to.contain('ERROR 23505');
    expect(panel.textContent).to.contain('The row already exists.');
    expect(panel.querySelectorAll('button')).to.have.lengthOf(3);
    panel.querySelectorAll('button')[0].click();
    panel.querySelectorAll('button')[1].click();
    panel.querySelectorAll('button')[2].click();
    expect(explain.calledOnce).to.be.true;
    expect(fix.calledOnce).to.be.true;
    expect(retry.calledOnce).to.be.true;

    const minimalPanel = createErrorPanel({
      errorMessage: 'simple failure',
      onExplainError: () => {},
      onFixWithAI: () => {},
      onRetry: () => {},
    });
    expect(minimalPanel.querySelector('p')).to.be.null;

    const selectAll = sandbox.spy();
    const copy = sandbox.spy();
    const importData = sandbox.spy();
    const exportData = sandbox.spy();
    const sendToChat = sandbox.spy();
    const analyze = sandbox.spy();
    const optimize = sandbox.spy();

    const actionBar = createActionBar({
      onSelectAll: selectAll,
      onCopy: copy,
      onImport: importData,
      onExport: exportData,
      onSendToChat: sendToChat,
      onAnalyzeWithAI: analyze,
      onOptimize: optimize,
    });

    const buttons = Array.from(actionBar.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.map(btn => btn.textContent)).to.deep.equal([
      '☐ Select All',
      '⎘ Copy',
      '⬆ Import',
      '↓ Export',
      '✦ Send to Chat',
      '◎ Analyze with AI',
      '⚡ Optimize',
    ]);
    buttons[0].click();
    buttons[1].click();
    buttons[2].click();
    buttons[3].click();
    buttons[4].click();
    buttons[5].click();
    buttons[6].click();
    expect(selectAll.calledOnce).to.be.true;
    expect(copy.calledOnce).to.be.true;
    expect(importData.calledOnce).to.be.true;
    expect(exportData.calledOnce).to.be.true;
    expect(exportData.firstCall.args[0]).to.equal(buttons[3]);
    expect(sendToChat.calledOnce).to.be.true;
    expect(analyze.calledOnce).to.be.true;
    expect(optimize.calledOnce).to.be.true;
  });

  it('creates top bars and transaction banners', () => {
    const postMessage = sandbox.spy();
    const connectedTopBar = createTopBar(
      {
        connectionName: 'Local DB',
        host: 'localhost',
        database: 'app',
        isConnected: true,
        onRunAll: sandbox.spy(),
        onClearOutputs: sandbox.spy(),
        onAddCodeCell: sandbox.spy(),
        onAddMarkdownCell: sandbox.spy(),
      },
      postMessage
    );

    expect(documentRef.getElementById('topbar-disconnected-style')).to.exist;
    expect(connectedTopBar.textContent).to.contain('Local DB · app');
    const connectionPill = connectedTopBar.lastElementChild as HTMLButtonElement;
    expect(connectionPill.title).to.contain('Host: localhost');
    connectionPill.click();
    expect(postMessage.calledOnceWithExactly({ type: 'showConnectionInfo' })).to.be.true;

    const disconnectedTopBar = createTopBar(
      {
        connectionName: 'Local DB',
        host: 'localhost',
        database: 'app',
        isConnected: false,
        onRunAll: sandbox.spy(),
        onClearOutputs: sandbox.spy(),
        onAddCodeCell: sandbox.spy(),
        onAddMarkdownCell: sandbox.spy(),
      },
      sandbox.spy()
    );
    expect(disconnectedTopBar.textContent).to.contain('Not connected');
    expect(disconnectedTopBar.querySelector('.topbar-dot-disconnected')).to.exist;

    const commit = sandbox.spy();
    const rollback = sandbox.spy();
    const singularBanner = createTransactionBanner({ statementCount: 1, onCommit: commit, onRollback: rollback });
    const pluralBanner = createTransactionBanner({ statementCount: 2, onCommit: commit, onRollback: rollback });

    expect(documentRef.getElementById('transaction-banner-pulse-amber')).to.exist;
    expect(singularBanner.textContent).to.contain('1 statement');
    expect(pluralBanner.textContent).to.contain('2 statements');
    (singularBanner.querySelectorAll('button')[0] as HTMLButtonElement).click();
    (singularBanner.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(commit.calledOnce).to.be.true;
    expect(rollback.calledOnce).to.be.true;
    expect(singularBanner.dataset.transactionBanner).to.equal('true');
  });
});