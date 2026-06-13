import * as vscode from 'vscode';
import { SyncController } from './SyncController';
import { LicenseService } from '../../services/LicenseService';
import { SYNC_BOOTSTRAP_PROMPTED_KEY } from './constants';
import { meetsTier } from '../../services/featureGates';

/** One-time nudge into cloud sync setup after activating a paid license. */
export async function maybePromptSyncBootstrap(context: vscode.ExtensionContext): Promise<void> {
  const prompted = context.globalState.get<boolean>(SYNC_BOOTSTRAP_PROMPTED_KEY, false);
  if (prompted) {
    return;
  }
  const tier = LicenseService.getInstance().getTier();
  if (!meetsTier(tier, 'sponsor')) {
    return;
  }
  const config = SyncController.getInstance().getConfig();
  if (config.providerId) {
    return;
  }

  await context.globalState.update(SYNC_BOOTSTRAP_PROMPTED_KEY, true);

  const buttons: string[] = ['Set Up Cloud Sync', 'Later'];
  if (tier === 'singularity') {
    buttons.splice(1, 0, 'Invite Teammates');
  }

  const choice = await vscode.window.showInformationMessage(
    'Your NexQL plan includes encrypted multi-device sync. Set it up now?',
    ...buttons,
  );

  if (choice === 'Set Up Cloud Sync') {
    await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync', wizard: 'cloud' });
  } else if (choice === 'Invite Teammates') {
    await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync', wizard: 'cloud' });
  }
}
