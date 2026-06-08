import { expect } from 'chai';
import * as vscode from 'vscode';

describe('NexQL extension (smoke)', () => {
  it('exposes the extension id after activation', async () => {
    const ext = vscode.extensions.getExtension('ric-v.postgres-explorer');
    expect(ext).to.not.equal(undefined);
    await ext!.activate();
    expect(ext!.isActive).to.equal(true);
  });

  it('registers at least one contributed command', async () => {
    const cmds = await vscode.commands.getCommands(true);
    expect(cmds.some((c) => c.startsWith('postgres-explorer.'))).to.equal(true);
  });

  it('executes a contributed command without throwing', async () => {
    await vscode.commands.executeCommand('postgres-explorer.refreshConnections');
  });
});
