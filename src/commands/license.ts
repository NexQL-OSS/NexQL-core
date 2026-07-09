import * as vscode from 'vscode';
import { LicenseService } from '../services/LicenseService';
import { FREE_QUOTAS, ProFeature, featureLabel } from '../services/featureGates';
import { QuotaService } from '../services/QuotaService';
import { remainingPercentLabel } from '../services/aiUsage';

const PRICING_URL = 'https://nexql.astrx.dev/#pricing';
// Server-issued keys use the PGST- prefix (api/_lib/license-key.js); NXQL- is
// accepted for forward compatibility with rebranded keys.
const KEY_HINT = /^(NXQL|PGST)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const isWellFormedHint = (v: string): boolean => KEY_HINT.test(v.trim().toUpperCase());

/** Prompt for a license key and activate it. */
export async function cmdLicenseActivate(prefillKey?: string): Promise<void> {
  const key =
    prefillKey ||
    (await vscode.window.showInputBox({
      title: 'Activate NexQL License',
      prompt: 'Paste your license key (e.g. PGST-XXXX-XXXX-XXXX-XXXX)',
      placeHolder: 'PGST-XXXX-XXXX-XXXX-XXXX',
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
      'Open Settings',
    );
    if (choice === 'Activate License') {
      await cmdLicenseActivate();
    } else if (choice === 'View Plans') {
      await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
    } else if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'license' });
    }
    return;
  }

  const label = status.tier[0].toUpperCase() + status.tier.slice(1);
  const offlineNote = status.offline ? ' (offline — using cached license)' : '';
  const choice = await vscode.window.showInformationMessage(
    `NexQL ${label} active${offlineNote}.`,
    'Deactivate',
    'View Plans',
    'Open Settings',
  );
  if (choice === 'Open Settings') {
    await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'license' });
  } else if (choice === 'Deactivate') {
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

/** Quick pick listing remaining free usage for every metered feature. */
export async function cmdLicenseShowUsage(): Promise<void> {
  const svc = LicenseService.getInstance();
  const quotas = QuotaService.getInstance();
  const now = new Date();

  let aiUsage: { used: number; limit: number; remaining: number } | null = null;
  try {
    const { fetchAiUsage } = await import('../services/aiUsage');
    const { extensionContext } = await import('../extension');
    aiUsage = await fetchAiUsage(extensionContext);
  } catch {
    // Silent
  }

  const tier = svc.getTier();
  const aiLimit = aiUsage ? aiUsage.limit : (tier === 'singularity' ? 10_000_000 : (tier === 'sponsor' ? 3_000_000 : 600_000));
  const aiRemaining = aiUsage ? aiUsage.remaining : aiLimit;
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysUntilReset = Math.ceil((nextMonth.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const aiResetHint = `resets in ${daysUntilReset}d`;

  const items: vscode.QuickPickItem[] = [];

  items.push({
    label: 'AI Chat Assistant',
    description: `${remainingPercentLabel(aiRemaining, aiLimit)} left this month`,
    detail: aiResetHint,
  });

  (Object.keys(FREE_QUOTAS) as ProFeature[]).forEach((feature) => {
    if (tier === 'free') {
      const status = quotas.peek(feature, now);
      if (status) {
        const word = status.period === 'week' ? 'this week' : 'today';
        items.push({
          label: featureLabel(feature),
          description: `${status.remaining}/${status.limit} left ${word}`,
          detail: quotas.resetHint(feature, now),
        });
      }
    } else {
      items.push({
        label: featureLabel(feature),
        description: 'unlimited',
      });
    }
  });

  const OPEN_SETTINGS_LABEL = '$(gear) Manage license & usage in Settings';
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: OPEN_SETTINGS_LABEL, description: 'Full usage view in Settings → License' },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: svc.isPaid() ? `NexQL ${tier[0].toUpperCase() + tier.slice(1)} Usage` : 'NexQL Free Usage',
    placeHolder: 'Remaining usage per feature',
  });
  if (picked?.label === OPEN_SETTINGS_LABEL) {
    await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'license' });
  } else if (picked && !svc.isPaid()) {
    await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
  }
}
