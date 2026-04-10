import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { ErrorService, getErrorExplanation } from '../../services/ErrorService';

describe('ErrorService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns PostgreSQL error explanations when known', () => {
    expect(getErrorExplanation('42P01')).to.contain('Table not found');
    expect(getErrorExplanation('42601')).to.contain('Syntax error');
    expect(getErrorExplanation('00000')).to.equal(undefined);
  });

  it('shows a simple error when no action is supplied', async () => {
    const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);

    await ErrorService.getInstance().showError('Something went wrong');

    expect(showErrorMessageStub.calledOnceWithExactly('Something went wrong')).to.be.true;
    expect(executeCommandStub.called).to.be.false;
  });

  it('runs the action command when the user selects the error action', async () => {
    const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves('Retry' as any);
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);

    await ErrorService.getInstance().showError('Something went wrong', 'Retry', 'postgres-explorer.retry');

    expect(showErrorMessageStub.calledOnceWithExactly('Something went wrong', 'Retry')).to.be.true;
    expect(executeCommandStub.calledOnceWithExactly('postgres-explorer.retry')).to.be.true;
  });

  it('logs and reports command failures', async () => {
    const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    const errorStub = sandbox.stub(console, 'error');

    await ErrorService.getInstance().handleCommandError(new Error('boom'), 'save changes');

    expect(errorStub.calledOnce).to.be.true;
    expect(String(errorStub.firstCall.args[0])).to.contain('Failed to save changes');
    expect(showErrorMessageStub.calledOnceWithExactly('Failed to save changes: boom')).to.be.true;
  });
});