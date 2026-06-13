import * as vscode from 'vscode';
import { LicenseService } from '../../services/LicenseService';
import { TIER_DISPLAY, allowedSyncProviders, syncProviderMinTier } from '../../services/featureGates';
import { SyncController } from './SyncController';
import { AccountService } from './AccountService';
import { VaultService } from './VaultService';
import { GistSyncProvider } from './providers/GistSyncProvider';
import { OneDriveSyncProvider } from './providers/OneDriveSyncProvider';
import { GoogleDriveSyncProvider } from './providers/GoogleDriveSyncProvider';
import { CloudSyncProvider } from './providers/CloudSyncProvider';
import { PostgresSyncProvider } from './providers/PostgresSyncProvider';
import { ensureDeviceName } from './deviceId';
import type { SyncProviderId } from './types';

export interface WizardCompleteResult {
  ok: boolean;
  error?: string;
  pushed?: number;
  pulled?: number;
}

/**
 * Settings-hub onboarding wizard — cloud-first path with Advanced backends.
 */
export class SyncSetupWizard {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getWelcomeState(): { tier: string; tierLabel: string; cloudAllowed: boolean } {
    const tier = LicenseService.getInstance().getTier();
    return {
      tier,
      tierLabel: TIER_DISPLAY[tier],
      cloudAllowed: allowedSyncProviders().includes('cloud'),
    };
  }

  async signInCloud(): Promise<{ ok: boolean; email?: string; error?: string }> {
    try {
      const { email } = await AccountService.getInstance(this.context).signInWithDeviceFlow();
      return { ok: true, email: email ?? undefined };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async testBackend(providerId: SyncProviderId): Promise<{ ok: boolean; error?: string }> {
    const provider = this.createProvider(providerId);
    if (providerId === 'gist') {
      await (provider as GistSyncProvider).ensureAuth();
    } else if (providerId === 'onedrive') {
      await (provider as OneDriveSyncProvider).ensureAuth();
    } else if (providerId === 'gdrive') {
      await (provider as GoogleDriveSyncProvider).ensureAuth();
    } else if (providerId === 'cloud') {
      const signedIn = await AccountService.getInstance(this.context).isSignedIn();
      if (!signedIn) {
        return { ok: false, error: 'Sign in to NexQL Cloud first.' };
      }
    }
    const test = await provider.testConnection();
    return test.ok ? { ok: true } : { ok: false, error: test.error ?? 'Connection failed' };
  }

  async setupVault(
    email: string,
    mode: 'create' | 'unlock',
    secretKey?: string,
  ): Promise<{ ok: boolean; secretKey?: string; error?: string }> {
    const entitlementEmail = await AccountService.getInstance(this.context).getAccountEmail();
    const resolvedEmail = email.trim() || entitlementEmail || '';
    if (!resolvedEmail) {
      return { ok: false, error: 'Account email is required.' };
    }
    if (entitlementEmail && VaultService.normalizeEmail(entitlementEmail) !== VaultService.normalizeEmail(resolvedEmail)) {
      const proceed = await vscode.window.showWarningMessage(
        'Vault email differs from your NexQL account email. Continue anyway?',
        'Continue',
        'Cancel',
      );
      if (proceed !== 'Continue') {
        return { ok: false, error: 'Cancelled.' };
      }
    }

    const vault = VaultService.getInstance(this.context);
    if (mode === 'create') {
      const { secretKey: created } = await vault.createVault(resolvedEmail);
      return { ok: true, secretKey: created };
    }
    if (!secretKey) {
      return { ok: false, error: 'Secret key required to unlock.' };
    }
    try {
      await vault.unlock(secretKey, resolvedEmail);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Unlock failed' };
    }
  }

  async completeSetup(
    providerId: SyncProviderId,
    flags: { syncConnections: boolean; syncQueries: boolean; syncNotebooks: boolean; syncPasswords: boolean },
    accountEmail: string,
    vaultMode: 'create' | 'unlock',
  ): Promise<WizardCompleteResult> {
    if (!allowedSyncProviders().includes(providerId)) {
      const tier = syncProviderMinTier(providerId);
      return { ok: false, error: `Requires NexQL ${TIER_DISPLAY[tier]}.` };
    }

    await ensureDeviceName(this.context);

    const controller = SyncController.getInstance();
    const vault = VaultService.getInstance(this.context);
    const gistId = providerId === 'gist'
      ? await this.context.secrets.get('postgresExplorer.sync.gistId')
      : undefined;

    await controller.saveConfig({
      providerId,
      gistId,
      syncConnections: flags.syncConnections,
      syncQueries: flags.syncQueries,
      syncNotebooks: flags.syncNotebooks,
      syncPasswords: flags.syncPasswords,
      paused: false,
      accountEmail: accountEmail.trim(),
      vaultGeneration: vault.getGeneration(),
    });

    if (providerId === 'gist' && vaultMode === 'unlock') {
      const provider = new GistSyncProvider(this.context);
      await provider.linkToRemoteStorage({ mode: 'unlock', vaultGeneration: vault.getGeneration() });
    }

    const result = await controller.runSync();
    if (providerId === 'cloud') {
      try {
        const { SharingService } = await import('./SharingService');
        await new SharingService(this.context).registerPublicKey();
      } catch {
        /* best-effort */
      }
    }

    return {
      ok: true,
      pushed: result?.pushed,
      pulled: result?.pulled,
    };
  }

  async exportRecoveryKit(email: string, secretKey: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('pgstudio-recovery-kit.txt'),
      filters: { Text: ['txt'] },
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(
          `PgStudio Sync Recovery Kit\nEmail: ${email}\nSecret Key: ${secretKey}\n\nKeep this file safe. Without the secret key, encrypted data cannot be recovered.`,
        ),
      );
    }
  }

  private createProvider(id: SyncProviderId) {
    switch (id) {
      case 'gist':
        return new GistSyncProvider(this.context);
      case 'onedrive':
        return new OneDriveSyncProvider(this.context);
      case 'gdrive':
        return new GoogleDriveSyncProvider(this.context);
      case 'cloud':
        return new CloudSyncProvider(this.context);
      case 'postgres':
        return new PostgresSyncProvider(this.context);
    }
  }
}
