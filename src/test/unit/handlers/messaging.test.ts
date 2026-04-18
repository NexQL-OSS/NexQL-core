import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { safelyPostMessage } from '../../../services/handlers/messaging';

describe('safelyPostMessage', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns false when postMessage is undefined', async () => {
    const r = await safelyPostMessage(undefined, { x: 1 }, { contextLabel: 'Test' });
    expect(r).to.be.false;
  });

  it('returns true when delivery succeeds', async () => {
    const postMessage = sandbox.stub().resolves(true);
    const r = await safelyPostMessage(postMessage, { type: 'a' }, { contextLabel: 'Test' });
    expect(r).to.be.true;
    expect(postMessage.calledOnceWithExactly({ type: 'a' })).to.be.true;
  });

  it('returns false when postMessage returns false', async () => {
    const postMessage = sandbox.stub().resolves(false);
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    const r = await safelyPostMessage(postMessage, { type: 'a' }, { contextLabel: 'Test', notifyOnFailure: true });
    expect(r).to.be.false;
    expect(warn.calledOnce).to.be.true;
  });

  it('returns false on thrown error', async () => {
    const postMessage = sandbox.stub().rejects(new Error('closed'));
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    const r = await safelyPostMessage(postMessage, { type: 'a' }, { contextLabel: 'Test', notifyOnFailure: true });
    expect(r).to.be.false;
    expect(warn.calledOnce).to.be.true;
  });
});
