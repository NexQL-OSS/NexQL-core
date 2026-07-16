import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { ensureNexqlFreeAuthPreflight } from '../../commands/aiAssist';
import { AccountService } from '../../features/sync/AccountService';
import { shouldShowNexqlSignInBanner } from '../../features/aiAssistant/authBanner';

describe('ensureNexqlFreeAuthPreflight', () => {
  let sandbox: sinon.SinonSandbox;
  let ensureAiSession: sinon.SinonStub;
  let showWarningMessage: sinon.SinonStub;
  let executeCommand: sinon.SinonStub;
  const context = { subscriptions: [] } as any;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    ensureAiSession = sandbox.stub();
    sandbox
      .stub(AccountService, 'getInstance')
      .returns({ ensureAiSession } as any);
    showWarningMessage = sandbox.stub(vscode.window, 'showWarningMessage');
    executeCommand = sandbox.stub(vscode.commands, 'executeCommand');
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('passes through for non nexql-free providers without auth checks', async () => {
    const ok = await ensureNexqlFreeAuthPreflight('openai', context);

    expect(ok).to.equal(true);
    expect(ensureAiSession.called).to.equal(false);
    expect(showWarningMessage.called).to.equal(false);
  });

  it('passes silently when a NexQL session already resolves', async () => {
    ensureAiSession.resolves('token');

    const ok = await ensureNexqlFreeAuthPreflight('nexql-free', context);

    expect(ok).to.equal(true);
    expect(ensureAiSession.calledOnceWithExactly()).to.equal(true);
    expect(showWarningMessage.called).to.equal(false);
  });

  it('aborts quietly when the notice is dismissed, never prompting for auth', async () => {
    ensureAiSession.resolves(undefined);
    showWarningMessage.resolves(undefined);

    const ok = await ensureNexqlFreeAuthPreflight('nexql-free', context);

    expect(ok).to.equal(false);
    expect(
      ensureAiSession.getCalls().some((c) => c.args[0]?.interactive === true),
    ).to.equal(false);
    expect(executeCommand.called).to.equal(false);
  });

  it('runs an interactive sign-in only after the user clicks Sign In', async () => {
    ensureAiSession.onFirstCall().resolves(undefined);
    ensureAiSession.onSecondCall().resolves('minted');
    showWarningMessage.resolves('Sign In' as any);

    const ok = await ensureNexqlFreeAuthPreflight('nexql-free', context);

    expect(ok).to.equal(true);
    expect(ensureAiSession.secondCall.args[0]).to.deep.equal({ interactive: true });
  });

  it('opens AI settings and aborts when the user picks Choose Provider', async () => {
    ensureAiSession.resolves(undefined);
    showWarningMessage.resolves('Choose Provider' as any);

    const ok = await ensureNexqlFreeAuthPreflight('nexql-free', context);

    expect(ok).to.equal(false);
    expect(executeCommand.calledOnceWith('postgres-explorer.aiSettings')).to.equal(true);
  });
});

describe('shouldShowNexqlSignInBanner', () => {
  it('shows only for unsigned, undismissed nexql-free users', () => {
    expect(shouldShowNexqlSignInBanner('nexql-free', false, false)).to.equal(true);
    expect(shouldShowNexqlSignInBanner('nexql-free', true, false)).to.equal(false);
    expect(shouldShowNexqlSignInBanner('nexql-free', false, true)).to.equal(false);
    expect(shouldShowNexqlSignInBanner('openai', false, false)).to.equal(false);
    expect(shouldShowNexqlSignInBanner(undefined, false, false)).to.equal(false);
  });
});
