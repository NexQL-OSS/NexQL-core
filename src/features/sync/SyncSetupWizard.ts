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

export type CloudSignInMode = 'license' | 'browser';

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

  async signInCloud(
    mode: CloudSignInMode = 'license',
    onStatus?: (message: string) => void,
  ): Promise<{ ok: boolean; email?: string; error?: string }> {
    try {
      const account = AccountService.getInstance(this.context);
      const result = mode === 'browser'
        ? await account.signInWithDeviceFlow(onStatus)
        : await account.signInWithLicense();
      return { ok: true, email: result.email ?? undefined };
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
    mode: 'create' | 'unlock',
    secretKey?: string,
    options?: { passphrase?: string; legacyEmail?: string },
  ): Promise<{ ok: boolean; secretKey?: string; generation?: string; error?: string }> {
    const vault = VaultService.getInstance(this.context);
    if (mode === 'create') {
      const { secretKey: created, generation } = await vault.createVault({
        passphrase: options?.passphrase,
      });
      return { ok: true, secretKey: created, generation };
    }
    if (!secretKey) {
      return { ok: false, error: 'Secret key required to unlock.' };
    }
    try {
      await vault.unlock(secretKey, options?.legacyEmail);
      return { ok: true, generation: vault.getGeneration() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Unlock failed' };
    }
  }

  async completeSetup(
    providerId: SyncProviderId,
    flags: { syncConnections: boolean; syncQueries: boolean; syncNotebooks: boolean; syncPasswords: boolean },
    vaultMode: 'create' | 'unlock',
    postgresConnectionId?: string,
  ): Promise<WizardCompleteResult> {
    if (!allowedSyncProviders().includes(providerId)) {
      const tier = syncProviderMinTier(providerId);
      return { ok: false, error: `Requires NexQL ${TIER_DISPLAY[tier]}.` };
    }

    if (providerId === 'postgres' && postgresConnectionId) {
      await vscode.workspace
        .getConfiguration()
        .update('postgresExplorer.sync.postgresConnectionId', postgresConnectionId, vscode.ConfigurationTarget.Global);
    }

    await ensureDeviceName(this.context);

    const controller = SyncController.getInstance();
    const vault = VaultService.getInstance(this.context);
    const gistId = providerId === 'gist'
      ? await this.context.secrets.get('postgresExplorer.sync.gistId')
      : undefined;

    const accountEmail = await AccountService.getInstance(this.context).getAccountEmail();

    await controller.saveConfig({
      providerId,
      gistId,
      syncConnections: flags.syncConnections,
      syncQueries: flags.syncQueries,
      syncNotebooks: flags.syncNotebooks,
      syncPasswords: flags.syncPasswords,
      paused: false,
      accountEmail: accountEmail?.trim(),
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

  async exportRecoveryKit(generation: string, secretKey: string, customPassphrase?: boolean): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('pgstudio-recovery-kit.txt'),
      filters: { Text: ['txt'] },
    });
    if (uri) {
      const secretLine = customPassphrase
        ? 'Secret: (your custom passphrase — not stored here)'
        : `Secret: ${secretKey}`;
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(
          `PgStudio Sync Recovery Kit\nVault ID: ${generation}\n${secretLine}\n\nKeep this safe. Without the secret, encrypted data cannot be recovered.`,
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
