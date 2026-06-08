import * as vscode from 'vscode';
import { LicenseService } from '../services/LicenseService';

const PRICING_URL = 'https://nexql.astrx.dev/#pricing';
const KEY_HINT = /^NXQL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const isWellFormedHint = (v: string): boolean => KEY_HINT.test(v.trim().toUpperCase());

/** Prompt for a license key and activate it. */
export async function cmdLicenseActivate(prefillKey?: string): Promise<void> {
  const key =
    prefillKey ||
    (await vscode.window.showInputBox({
      title: 'Activate NexQL License',
      prompt: 'Paste your license key (e.g. NXQL-XXXX-XXXX-XXXX-XXXX)',
      placeHolder: 'NXQL-XXXX-XXXX-XXXX-XXXX',
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value || isWellFormedHint(value) ? undefined : 'That does not look like a NexQL key.',
    }));

  if (!key) {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Activating license…' },
    () => LicenseService.getInstance().activate(key),
  );

  if (result.ok) {
    vscode.window.showInformationMessage(result.message);
  } else {
    const choice = await vscode.window.showErrorMessage(result.message, 'View Plans');
    if (choice === 'View Plans') {
      await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
    }
  }
}

/** Show current license status with manage actions. */
export async function cmdLicenseManage(): Promise<void> {
  const svc = LicenseService.getInstance();
  const status = svc.getStatus();

  if (status.tier === 'free') {
    const choice = await vscode.window.showInformationMessage(
      'NexQL Free — no license active.',
      'Activate License',
      'View Plans',
    );
    if (choice === 'Activate License') {
      await cmdLicenseActivate();
    } else if (choice === 'View Plans') {
      await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
    }
    return;
  }

  const label = status.tier[0].toUpperCase() + status.tier.slice(1);
  const offlineNote = status.offline ? ' (offline — using cached license)' : '';
  const choice = await vscode.window.showInformationMessage(
    `NexQL ${label} active${offlineNote}.`,
    'Deactivate',
    'View Plans',
  );
  if (choice === 'Deactivate') {
    const confirm = await vscode.window.showWarningMessage(
      'Remove the license from this machine? Your subscription is not cancelled.',
      { modal: true },
      'Deactivate',
    );
    if (confirm === 'Deactivate') {
      await svc.deactivate();
      vscode.window.showInformationMessage('License removed from this machine.');
    }
  } else if (choice === 'View Plans') {
    await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
  }
}

export async function cmdLicenseOpenUpgrade(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
}
