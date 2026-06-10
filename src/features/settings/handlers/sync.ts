import * as vscode from 'vscode';
import { SyncController } from '../../sync/SyncController';
import {
  allowedSyncProviders,
  isProFeatureEnabled,
  ProFeature,
  requirePro,
} from '../../../services/featureGates';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';

const PROVIDER_LABELS: Record<string, string> = {
  gist: 'GitHub Gist',
  onedrive: 'OneDrive',
  gdrive: 'Google Drive',
  cloud: 'NexQL Cloud',
  postgres: 'Shared Postgres',
};

const AUTO_SYNC_KEY = 'postgresExplorer.sync.auto';
const PULL_INTERVAL_KEY = 'postgresExplorer.sync.pullIntervalMinutes';
const MIN_PULL_INTERVAL_MINUTES = 1;
const MAX_PULL_INTERVAL_MINUTES = 1440;

export class SyncSectionHandler implements SettingsSectionHandler {
  readonly section = 'sync';

  constructor(private readonly host: SettingsHubHostContext) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        this.sendState();
        break;
      case 'now':
        await this.syncNow();
        break;
      case 'pauseResume':
        await this.pauseResume();
        break;
      case 'signOut':
        await this.signOut();
        break;
      case 'setup':
        await this.launchSetup();
        break;
      case 'saveFlags':
        await this.saveFlags(message.flags as Record<string, boolean>);
        break;
      case 'updateAuto':
        await this.updateAuto(!!message.auto, Number(message.pullIntervalMinutes));
        break;
      case 'items':
        this.sendItems();
        break;
      case 'pending':
        this.sendPending();
        break;
      case 'stopSyncingItem':
        await this.stopSyncingItem(String(message.itemId ?? ''), String(message.itemName ?? ''));
        break;
      case 'resumeItem':
        await SyncController.getInstance().setItemExcluded(String(message.itemId ?? ''), false);
        this.sendItems();
        break;
      case 'share':
        await vscode.commands.executeCommand('postgres-explorer.sync.share');
        break;
      case 'importShares':
        await vscode.commands.executeCommand('postgres-explorer.sync.importShares');
        this.sendItems();
        break;
    }
  }

  private sendItems(): void {
    this.host.post({
      type: 'sync/items',
      items: SyncController.getInstance().listSyncedItems(),
    });
  }

  private sendPending(): void {
    const pending = SyncController.getInstance().listPendingActivities();
    this.host.post({
      type: 'sync/pending',
      pending,
      pendingCount: pending.length,
    });
  }

  /** Per-item de-sync: the user chooses between keeping or deleting the cloud copy. */
  private async stopSyncingItem(itemId: string, itemName: string): Promise<void> {
    if (!itemId) {
      return;
    }
    const label = itemName || itemId;
    const choice = await vscode.window.showWarningMessage(
      `Stop syncing "${label}"?`,
      {
        modal: true,
        detail:
          'Keep cloud copy: the item stays in cloud storage and on other devices, but this device stops syncing it.\n\n' +
          'Remove from cloud: the cloud copy is deleted and other devices remove theirs on next sync. The local copy stays on this device.',
      },
      'Keep Cloud Copy',
      'Remove from Cloud',
    );
    const controller = SyncController.getInstance();
    if (choice === 'Keep Cloud Copy') {
      await controller.setItemExcluded(itemId, true);
    } else if (choice === 'Remove from Cloud') {
      try {
        const removed = await controller.removeFromCloud(itemId);
        if (!removed) {
          void vscode.window.showWarningMessage(
            'Could not remove the item from cloud storage (vault locked or item not synced yet).',
          );
        }
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Failed to remove from cloud: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.sendItems();
  }

  private sendState(): void {
    // Backup (manual, own Postgres) is available on every tier; automatic
    // multi-device sync needs Sponsor+.
    const enabled = isProFeatureEnabled(ProFeature.CloudBackup);
    const autoAllowed = isProFeatureEnabled(ProFeature.CloudSync);
    const controller = SyncController.getInstance();
    const config = controller.getConfig();
    const wsConfig = vscode.workspace.getConfiguration();

    this.host.post({
      type: 'sync/state',
      sync: {
        featureEnabled: enabled,
        autoAllowed,
        allowedProviders: allowedSyncProviders(),
        configured: !!config.providerId,
        status: controller.getStatus(),
        conflicts: controller.getConflictCount(),
        providerId: config.providerId ?? null,
        providerLabel: config.providerId ? (PROVIDER_LABELS[config.providerId] ?? config.providerId) : null,
        accountEmail: config.accountEmail ?? null,
        paused: config.paused,
        sharingAvailable: config.providerId === 'cloud' && isProFeatureEnabled(ProFeature.SyncSharing),
        flags: {
          syncConnections: config.syncConnections,
          syncQueries: config.syncQueries,
          syncNotebooks: config.syncNotebooks,
          syncPasswords: config.syncPasswords,
        },
        auto: wsConfig.get<boolean>(AUTO_SYNC_KEY, true),
        pullIntervalMinutes: wsConfig.get<number>(PULL_INTERVAL_KEY, 5),
      },
    });
  }

  private async syncNow(): Promise<void> {
    if (!(await requirePro(ProFeature.CloudBackup))) {
      this.sendState();
      return;
    }
    this.host.post({ type: 'sync/running' });
    const result = await SyncController.getInstance().runSync();
    this.host.post({ type: 'sync/runComplete', result: result ?? null });
    this.sendState();
    this.sendPending();
    this.sendItems();
  }

  private async pauseResume(): Promise<void> {
    if (!(await requirePro(ProFeature.CloudBackup))) {
      this.sendState();
      return;
    }
    const controller = SyncController.getInstance();
    const config = controller.getConfig();
    await controller.saveConfig({ ...config, paused: !config.paused });
    this.sendState();
  }

  private async signOut(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Sign out of sync? Local data is kept; remote vault remains.',
      'Sign Out',
    );
    if (confirm === 'Sign Out') {
      await SyncController.getInstance().signOut();
    }
    this.sendState();
  }

  private async launchSetup(): Promise<void> {
    // Device-flow OAuth + vault creation stay on the existing wizard; the hub
    // just launches it and refreshes status when it returns.
    await vscode.commands.executeCommand('postgres-explorer.sync.setup');
    this.sendState();
  }

  private async saveFlags(flags: Record<string, boolean> | undefined): Promise<void> {
    if (!flags) {
      return;
    }
    const controller = SyncController.getInstance();
    const config = controller.getConfig();
    await controller.saveConfig({
      ...config,
      syncConnections: !!flags.syncConnections,
      syncQueries: !!flags.syncQueries,
      syncNotebooks: !!flags.syncNotebooks,
      syncPasswords: !!flags.syncPasswords,
    });
    this.sendState();
  }

  private async updateAuto(auto: boolean, pullIntervalMinutes: number): Promise<void> {
    if (auto && !(await requirePro(ProFeature.CloudSync))) {
      this.sendState();
      return;
    }
    const wsConfig = vscode.workspace.getConfiguration();
    await wsConfig.update(AUTO_SYNC_KEY, auto, vscode.ConfigurationTarget.Global);
    if (Number.isFinite(pullIntervalMinutes) && pullIntervalMinutes >= MIN_PULL_INTERVAL_MINUTES) {
      const clamped = Math.min(Math.round(pullIntervalMinutes), MAX_PULL_INTERVAL_MINUTES);
      await wsConfig.update(PULL_INTERVAL_KEY, clamped, vscode.ConfigurationTarget.Global);
    }
    this.sendState();
  }
}
