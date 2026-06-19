import * as vscode from 'vscode';
import { SyncController } from '../../sync/SyncController';
import { defaultDeviceName, getDeviceName } from '../../sync/deviceId';
import { saveDeviceDisplayName } from '../../sync/deviceRename';
import { SyncSetupWizard } from '../../sync/SyncSetupWizard';
import { WorkspaceSharingService } from '../../sync/WorkspaceSharingService';
import { LicenseService } from '../../../services/LicenseService';
import {
  allowedSyncProviders,
  isProFeatureEnabled,
  ProFeature,
  requirePro,
  TIER_DISPLAY,
} from '../../../services/featureGates';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';
import { ConnectionUtils } from '../../../utils/connectionUtils';
import { DatabaseTreeItem } from '../../../providers/DatabaseTreeProvider';
import { cmdNewNotebook } from '../../../commands/notebook';

const PROVIDER_LABELS: Record<string, string> = {
  cloud: 'NexQL Cloud',
  postgres: 'Shared Postgres',
};

const AUTO_SYNC_KEY = 'postgresExplorer.sync.auto';
const PULL_INTERVAL_KEY = 'postgresExplorer.sync.pullIntervalMinutes';
const MIN_PULL_INTERVAL_MINUTES = 1;
const MAX_PULL_INTERVAL_MINUTES = 1440;
const REPAIR_CONFIRM = 'REPLACE';

export class SyncSectionHandler implements SettingsSectionHandler {
  readonly section = 'sync';

  constructor(private readonly host: SettingsHubHostContext) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        this.sendState();
        break;
      case 'now':
        await this.syncNow('both');
        break;
      case 'pull':
        await this.syncNow('pull');
        break;
      case 'push':
        await this.syncNow('push');
        break;
      case 'preview':
        await this.previewSync(message.transientExcludedIds as string[] | undefined);
        break;
      case 'applyPreview':
        await this.applyPreview(message.transientExcludedIds as string[] | undefined);
        break;
      case 'pauseResume':
        await this.pauseResume();
        break;
      case 'signOut':
        await this.signOut();
        break;
      case 'setup':
        this.host.post({ type: 'sync/openWizard', mode: message.mode ?? 'cloud' });
        break;
      case 'wizardWelcome':
        this.sendWizardWelcome();
        break;
      case 'wizardSignIn':
        await this.wizardSignIn(message);
        break;
      case 'wizardTestBackend':
        await this.wizardTestBackend(String(message.providerId ?? 'cloud'));
        break;
      case 'wizardComplete':
        await this.wizardComplete(message);
        break;
      case 'savePostgresConnection':
        await this.savePostgresConnection(String(message.postgresConnectionId ?? ''));
        break;
      case 'openNotebook':
        await this.openNotebook(String(message.postgresConnectionId ?? ''));
        break;
      case 'saveFlags':
        await this.saveFlags(message.flags as Record<string, boolean>);
        break;
      case 'updateAuto':
        await this.updateAuto(!!message.auto, Number(message.pullIntervalMinutes));
        break;
      case 'items':
      case 'local':
        await this.sendLocalItems();
        break;
      case 'cloud':
        await this.sendLocalItems();
        break;
      case 'importCloudItem':
        await this.importCloudItem(String(message.itemId ?? ''));
        break;
      case 'deleteCloudItem':
        await this.deleteCloudItem(String(message.itemId ?? ''), String(message.itemName ?? ''));
        break;
      case 'pending':
        this.sendPending();
        break;
      case 'history':
        this.sendHistory();
        break;
      case 'conflicts':
        this.sendConflicts();
        break;
      case 'resolveConflict':
        await this.resolveConflict(message);
        break;
      case 'shares':
        await this.sendShares();
        break;
      case 'revokeShare':
        await this.revokeShare(String(message.shareId ?? ''));
        break;
      case 'devices':
        await this.sendDevices();
        break;
      case 'revokeDevice':
        await this.revokeDevice(String(message.deviceId ?? ''));
        break;
      case 'renameDevice':
        await this.renameDevice(String(message.deviceName ?? ''));
        break;
      case 'replaceLocal':
        await this.replaceLocal();
        break;
      case 'replaceRemote':
        await this.replaceRemote();
        break;
      case 'rebuildIndex':
        await this.rebuildIndex();
        break;
      case 'repair':
        await this.repair();
        break;
      case 'diagnostics':
        await SyncController.getInstance().runDiagnostics();
        this.sendState();
        break;
      case 'stopSyncingItem':
        await this.stopSyncingItem(String(message.itemId ?? ''), String(message.itemName ?? ''));
        break;
      case 'resumeItem':
        await this.resumeSyncItem(String(message.itemId ?? ''));
        break;
      case 'share':
        await vscode.commands.executeCommand('postgres-explorer.sync.inviteMember');
        break;
      case 'importShares':
        await vscode.commands.executeCommand('postgres-explorer.sync.importShares');
        this.sendItems();
        break;
    }
  }

  private sendWizardWelcome(): void {
    const wizard = new SyncSetupWizard(this.host.extensionContext);
    this.host.post({ type: 'sync/wizardWelcome', ...wizard.getWelcomeState() });
  }

  private async wizardSignIn(message: SettingsHubMessage): Promise<void> {
    const wizard = new SyncSetupWizard(this.host.extensionContext);
    const mode = message.mode === 'browser' ? 'browser' : 'license';
    const result = await wizard.signInCloud(mode, (status) => {
      this.host.post({ type: 'sync/wizardSignInStatus', status });
    });
    this.host.post({ type: 'sync/wizardSignInResult', ...result });
  }

  private async wizardTestBackend(providerId: string): Promise<void> {
    const wizard = new SyncSetupWizard(this.host.extensionContext);
    const result = await wizard.testBackend(providerId as never);
    this.host.post({ type: 'sync/wizardBackendResult', providerId, ...result });
  }

  private async wizardComplete(message: SettingsHubMessage): Promise<void> {
    const wizard = new SyncSetupWizard(this.host.extensionContext);
    const flags = (message.flags ?? {}) as Record<string, boolean>;
    const result = await wizard.completeSetup(
      String(message.providerId ?? 'cloud') as never,
      {
        syncConnections: flags.syncConnections !== false,
        syncQueries: flags.syncQueries !== false,
        syncNotebooks: flags.syncNotebooks !== false,
      },
      message.postgresConnectionId ? String(message.postgresConnectionId) : undefined,
    );
    this.host.post({ type: 'sync/wizardCompleteResult', ...result });
    this.sendState();
    this.sendItems();
  }

  private sendItems(): void {
    void this.sendLocalItems();
  }

  private async sendLocalItems(): Promise<void> {
    this.host.post({
      type: 'sync/local',
      items: await SyncController.getInstance().listLocalTabItems(),
    });
  }

  private async deleteCloudItem(itemId: string, itemName: string): Promise<void> {
    if (!itemId) {
      return;
    }
    const label = itemName || itemId;
    const confirm = await vscode.window.showWarningMessage(
      `Delete "${label}" from cloud storage?`,
      { modal: true, detail: 'This removes the item from cloud and other synced devices. This device will not receive a local copy.' },
      'Delete from cloud',
    );
    if (confirm !== 'Delete from cloud') {
      return;
    }
    const ok = await SyncController.getInstance().removeFromCloud(itemId);
    if (!ok) {
      void vscode.window.showWarningMessage('Could not delete item from cloud.');
    } else {
      void vscode.window.showInformationMessage('Item removed from cloud.');
    }
    await this.sendLocalItems();
    this.sendState();
  }

  private async sendCloudItems(): Promise<void> {
    await this.sendLocalItems();
  }

  private async resumeSyncItem(itemId: string): Promise<void> {
    if (!itemId) {
      return;
    }
    const controller = SyncController.getInstance();
    const onDevice = await controller.isPresentOnDevice(itemId);
    if (!onDevice) {
      void vscode.window.showWarningMessage(
        'This item is not on this device. Use Import to restore it from cloud.',
      );
      await this.sendLocalItems();
      return;
    }
    await controller.setItemExcluded(itemId, false);
    await this.sendLocalItems();
  }

  private async importCloudItem(itemId: string): Promise<void> {
    if (!itemId) {
      return;
    }
    const ok = await SyncController.getInstance().importCloudItem(itemId);
    if (!ok) {
      void vscode.window.showWarningMessage('Could not import item from cloud.');
    } else {
      void vscode.window.showInformationMessage('Item imported from cloud.');
    }
    await this.sendLocalItems();
    this.sendItems();
    this.sendState();
  }

  private sendPending(): void {
    const pending = SyncController.getInstance().listPendingActivities();
    this.host.post({
      type: 'sync/pending',
      pending,
      pendingCount: pending.length,
    });
  }

  private sendHistory(): void {
    this.host.post({
      type: 'sync/history',
      history: SyncController.getInstance().listInboundHistory(),
    });
  }

  private sendConflicts(): void {
    // v2 resolves conflicts automatically (last-writer-wins, loser backed up
    // locally), so there is no manual conflict queue.
    this.host.post({ type: 'sync/conflicts', conflicts: [] });
  }

  private async resolveConflict(_message: SettingsHubMessage): Promise<void> {
    this.sendConflicts();
    this.sendItems();
    this.sendState();
  }

  private async sendShares(): Promise<void> {
    try {
      const controller = SyncController.getInstance();
      const workspaces = await new WorkspaceSharingService(this.host.extensionContext).listWorkspaces();
      const incoming = controller
        .listSyncedItems()
        .filter((i) => i.spaceId?.startsWith('ws_'))
        .map((i) => ({
          id: i.id,
          name: i.name ?? i.id,
          kind: i.kind,
          workspaceName: i.workspaceName,
          role: i.role,
        }));
      this.host.post({ type: 'sync/shares', incoming, outgoing: [], workspaces });
    } catch (e) {
      this.host.post({
        type: 'sync/shares',
        incoming: [],
        outgoing: [],
        workspaces: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async revokeShare(_shareId: string): Promise<void> {
    // Workspace membership is managed via the "Manage Workspaces" command.
    await this.sendShares();
  }

  private async sendDevices(): Promise<void> {
    const controller = SyncController.getInstance();
    const localName = getDeviceName(this.host.extensionContext);
    const devices = (await controller.listCloudDevices()).map((device) => (
      device.isThisDevice
        ? { ...device, deviceName: localName || device.deviceName }
        : device
    ));
    const thisDevice = controller.getThisDeviceInfo();
    this.host.post({
      type: 'sync/devices',
      devices,
      thisDevice: {
        ...thisDevice,
        deviceName: localName || thisDevice.deviceName,
        suggestedName: localName || thisDevice.deviceName || defaultDeviceName(),
      },
    });
  }

  private async renameDevice(deviceName: string): Promise<void> {
    const trimmed = deviceName.trim();
    if (!trimmed) {
      this.host.post({
        type: 'sync/deviceRenameResult',
        ok: false,
        error: 'Enter a device name.',
      });
      return;
    }
    try {
      const { cloudOk } = await saveDeviceDisplayName(this.host.extensionContext, trimmed);
      this.host.post({
        type: 'sync/deviceRenameResult',
        ok: true,
        deviceName: trimmed,
        warning: cloudOk ? undefined : 'Saved locally; cloud update failed — will retry on next sync.',
      });
      await this.sendDevices();
    } catch (err: unknown) {
      this.host.post({
        type: 'sync/deviceRenameResult',
        ok: false,
        error: err instanceof Error ? err.message : 'Could not save device name.',
      });
    }
  }

  private async revokeDevice(deviceId: string): Promise<void> {
    if (!deviceId) {
      return;
    }
    const ok = await SyncController.getInstance().revokeCloudDevice(deviceId);
    if (!ok) {
      void vscode.window.showWarningMessage('Could not revoke device.');
    }
    await this.sendDevices();
  }

  private async replaceLocal(): Promise<void> {
    const typed = await vscode.window.showInputBox({
      title: 'Replace local with cloud',
      prompt: `Type ${REPAIR_CONFIRM} to overwrite all local sync items with the cloud copy`,
      ignoreFocusOut: true,
    });
    if (typed?.trim() !== REPAIR_CONFIRM) {
      return;
    }
    const ok = await SyncController.getInstance().replaceLocalWithCloud();
    void vscode.window.showInformationMessage(ok ? 'Local data replaced from cloud.' : 'Replace failed.');
    this.sendState();
    this.sendItems();
    this.sendPending();
    await this.sendCloudItems();
  }

  private async replaceRemote(): Promise<void> {
    const typed = await vscode.window.showInputBox({
      title: 'Replace cloud with local',
      prompt: `Type ${REPAIR_CONFIRM} to overwrite cloud with this device's data`,
      ignoreFocusOut: true,
    });
    if (typed?.trim() !== REPAIR_CONFIRM) {
      return;
    }
    const ok = await SyncController.getInstance().replaceCloudWithLocal();
    void vscode.window.showInformationMessage(ok ? 'Cloud replaced from local.' : 'Replace failed.');
    this.sendState();
    this.sendItems();
    this.sendPending();
    await this.sendCloudItems();
  }

  private async rebuildIndex(): Promise<void> {
    const typed = await vscode.window.showInputBox({
      title: 'Rebuild sync index',
      prompt: `Type ${REPAIR_CONFIRM} to rebuild the local sync index from disk`,
      ignoreFocusOut: true,
    });
    if (typed?.trim() !== REPAIR_CONFIRM) {
      return;
    }
    const count = await SyncController.getInstance().rebuildSyncIndex();
    void vscode.window.showInformationMessage(`Rebuilt index for ${count} item(s).`);
    this.sendItems();
  }

  private async repair(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Repair sync state and pull the latest from the cloud?',
      'Repair Sync',
    );
    if (confirm !== 'Repair Sync') {
      return;
    }
    const ok = await SyncController.getInstance().repair();
    void vscode.window.showInformationMessage(ok ? 'Sync repaired successfully.' : 'Sync repair failed.');
    this.sendState();
    this.sendItems();
    this.sendPending();
  }

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
    const enabled = isProFeatureEnabled(ProFeature.CloudBackup);
    const autoAllowed = isProFeatureEnabled(ProFeature.CloudSync);
    const controller = SyncController.getInstance();
    const config = controller.getConfig();
    const wsConfig = vscode.workspace.getConfiguration();
    const tier = LicenseService.getInstance().getTier();
    const pullInterval = wsConfig.get<number>(PULL_INTERVAL_KEY, 5);
    const lastSyncAt = controller.getLastSyncAt();
    const lastError = controller.getLastError();

    void controller.getCloudQuota().then((quota) => {
      this.host.post({ type: 'sync/quota', quota: quota ?? null });
    });

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
        tier,
        tierLabel: TIER_DISPLAY[tier],
        cloudDefault: tier !== 'free',
        lastSyncAt: lastSyncAt ?? null,
        lastError: lastError ?? null,
        nextPullEtaMs: lastSyncAt && autoAllowed && !config.paused
          ? Math.max(0, lastSyncAt + pullInterval * 60 * 1000 - Date.now())
          : null,
        flags: {
          syncConnections: config.syncConnections,
          syncQueries: config.syncQueries,
          syncNotebooks: config.syncNotebooks,
        },
        auto: wsConfig.get<boolean>(AUTO_SYNC_KEY, true),
        pullIntervalMinutes: pullInterval,
        postgresConnectionId: wsConfig.get<string>('postgresExplorer.sync.postgresConnectionId') ?? null,
      },
    });
  }

  private async savePostgresConnection(postgresConnectionId: string): Promise<void> {
    if (!postgresConnectionId) {
      return;
    }
    await vscode.workspace
      .getConfiguration()
      .update('postgresExplorer.sync.postgresConnectionId', postgresConnectionId, vscode.ConfigurationTarget.Global);
    this.sendState();
  }

  private async syncNow(direction: 'both' | 'pull' | 'push'): Promise<void> {
    if (!(await requirePro(ProFeature.CloudBackup))) {
      this.sendState();
      return;
    }
    this.host.post({ type: 'sync/running' });
    const controller = SyncController.getInstance();
    const result = direction === 'pull'
      ? await controller.pullOnly()
      : direction === 'push'
        ? await controller.pushOnly()
        : await controller.runSync({ userInitiated: true });
    this.host.post({ type: 'sync/runComplete', result: result ?? null });
    this.sendState();
    this.sendPending();
    this.sendItems();
    this.sendHistory();
  }

  private async previewSync(transientExcludedIds?: string[]): Promise<void> {
    if (!(await requirePro(ProFeature.CloudBackup))) {
      return;
    }
    const preview = await SyncController.getInstance().previewSync(transientExcludedIds);
    this.host.post({ type: 'sync/preview', preview: preview ?? null });
    this.sendState();
  }

  private async applyPreview(transientExcludedIds?: string[]): Promise<void> {
    if (!(await requirePro(ProFeature.CloudBackup))) {
      return;
    }
    this.host.post({ type: 'sync/running' });
    const result = await SyncController.getInstance().runSync({ transientExcludedIds });
    this.host.post({ type: 'sync/runComplete', result: result ?? null });
    this.sendState();
    this.sendPending();
    this.sendItems();
    this.sendHistory();
    this.sendConflicts();
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

  private async openNotebook(postgresConnectionId: string): Promise<void> {
    if (!postgresConnectionId) {
      void vscode.window.showErrorMessage('No database connection selected.');
      return;
    }
    const connection = ConnectionUtils.findConnection(postgresConnectionId);
    if (!connection) {
      void vscode.window.showErrorMessage('Database connection not found.');
      return;
    }
    const treeItem = new DatabaseTreeItem(
      connection.database || 'postgres',
      vscode.TreeItemCollapsibleState.None,
      'database',
      connection.id,
      connection.database || 'postgres'
    );
    await cmdNewNotebook(treeItem, this.host.extensionContext);
  }
}
