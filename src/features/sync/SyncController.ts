import * as vscode from 'vscode';
import { SavedQueriesService } from '../savedQueries/SavedQueriesService';
import { TelemetryService } from '../../services/TelemetryService';
import {
  isProFeatureEnabled,
  isSyncProviderAllowed,
  ProFeature,
  requirePro,
  syncProviderMinTier,
  TIER_DISPLAY,
} from '../../services/featureGates';
import { AccountService } from './AccountService';
import { VaultService } from './VaultService';
import { buildSyncChangeSummary, formatCountsLine } from './syncChangeStats';
import { attachEncryptedBlobs, mergeSyncState, tombstoneMeta } from './SyncEngine';
import { getOrCreateDeviceId, getDeviceName } from './deviceId';
import { NotebookSyncService } from './NotebookSyncService';
import { ConnectionSyncService } from './ConnectionSyncService';
import { SyncIndex } from './SyncIndex';
import { contentHash } from './envelope';
import {
  SYNC_BACKOFF_INITIAL_MS,
  SYNC_BACKOFF_MAX_MS,
  SYNC_BASE_MANIFEST_KEY,
  SYNC_CONFIG_KEY,
  SYNC_DEBOUNCE_MS,
  SYNC_LAST_CONFLICTS_KEY,
  SYNC_LAST_ERROR_KEY,
  SYNC_LAST_SYNC_AT_KEY,
  SYNC_PERIODIC_MS,
  CLOUD_INACTIVE_RETENTION_DAYS,
  SYNC_PREVIEW_CACHE_KEY,
} from './constants';
import type {
  SyncConfig,
  SyncItemMeta,
  SyncProvider,
  SyncProviderId,
  SyncRunResult,
  SyncRunOptions,
  SyncPreviewResult,
  SyncStatus,
  SyncActivityView,
  SyncedItemView,
  CloudQuotaView,
  SyncDeviceView,
  InboundEntry,
} from './types';
import { GistSyncProvider, OversizedItemError } from './providers/GistSyncProvider';
import { OneDriveSyncProvider } from './providers/OneDriveSyncProvider';
import { GoogleDriveSyncProvider } from './providers/GoogleDriveSyncProvider';
import { CloudSyncProvider } from './providers/CloudSyncProvider';
import { PostgresSyncProvider } from './providers/PostgresSyncProvider';
import { bindSyncActivityLog, recordSyncActivity, SyncActivityLog } from './SyncActivityLog';
import { readNotebookSyncId } from './notebookSyncId';
import { buildPreviewFromMerge, mergeBaseManifestPartial } from './syncPreviewUtils';
import type { SyncStatusBar } from '../../activation/statusBar';

function metaKey(m: SyncItemMeta): string {
  return `${m.kind}:${m.id}`;
}

export class SyncController implements vscode.Disposable {
  private static instance: SyncController;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private periodicTimer: ReturnType<typeof setInterval> | undefined;
  private backoffMs = SYNC_BACKOFF_INITIAL_MS;
  private status: SyncStatus = 'not_configured';
  private conflictCount = 0;
  private syncInFlight = false;
  /** Serializes sync runs so manual Sync Now waits instead of no-oping. */
  private syncTail: Promise<unknown> = Promise.resolve();
  private statusBar: SyncStatusBar | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  static getInstance(context?: vscode.ExtensionContext, outputChannel?: vscode.OutputChannel): SyncController {
    if (!SyncController.instance) {
      if (!context || !outputChannel) {
        throw new Error('SyncController not initialized');
      }
      SyncController.instance = new SyncController(context, outputChannel);
    }
    return SyncController.instance;
  }

  static resetInstanceForTests(): void {
    SyncController.instance = undefined as unknown as SyncController;
  }

  initialize(statusBar?: SyncStatusBar): void {
    this.statusBar = statusBar;
    bindSyncActivityLog(this.context);
    VaultService.getInstance(this.context);
    AccountService.getInstance(this.context);

    const config = this.getConfig();
    this.status = config.providerId ? (config.paused ? 'paused' : 'idle') : 'not_configured';
    this.updateStatusBar();
    this.seedConnectionSnapshot();

    if (config.providerId && !config.paused) {
      void this.bootstrapVaultAndSync();
    }

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('postgresExplorer.connections')) {
          if (this.recordConnectionConfigChanges()) {
            this.scheduleInstantSync();
          }
        }
      }),
      vscode.workspace.onDidSaveNotebookDocument((doc) => {
        this.recordOpenNotebookActivity(doc, 'update');
        this.schedulePush();
      }),
      vscode.workspace.onDidChangeNotebookDocument(() => this.schedulePush()),
    );

    try {
      const notebookPattern = new vscode.RelativePattern(this.context.globalStorageUri, '**/*.pgsql');
      const notebookWatcher = vscode.workspace.createFileSystemWatcher(notebookPattern);
      notebookWatcher.onDidCreate((uri) => {
        void this.recordNotebookFileActivity(uri, 'create').then(() => {
          this.scheduleInstantSync();
        });
      });
      notebookWatcher.onDidChange((uri) => {
        void this.recordNotebookFileActivity(uri, 'update');
        this.schedulePush();
      });
      notebookWatcher.onDidDelete((uri) => {
        this.recordNotebookFileDelete(uri);
        this.scheduleInstantSync();
      });
      this.disposables.push(notebookWatcher);
    } catch {
      /* watcher unavailable — manual sync still works */
    }

    if (
      this.isAutoSyncEnabled() &&
      config.providerId &&
      !config.paused &&
      isProFeatureEnabled(ProFeature.CloudSync)
    ) {
      const intervalMin = vscode.workspace
        .getConfiguration()
        .get<number>('postgresExplorer.sync.pullIntervalMinutes', 5);
      const intervalMs = Math.max(1, intervalMin) * 60 * 1000;
      this.periodicTimer = setInterval(() => void this.runSync(), intervalMs);
    }
  }

  /** Restore cached vault key after restart, then run an initial pull/push. */
  private async bootstrapVaultAndSync(): Promise<void> {
    const config = this.getConfig();
    const vault = VaultService.getInstance();
    const account = AccountService.getInstance();

    if (!vault.isUnlocked()) {
      const loaded = await vault.tryLoadCachedKey();
      if (!loaded && config.providerId === 'cloud') {
        const token = await account.getAccessToken() ?? await account.refreshAccessToken();
        if (token) {
          const loadedAfterToken = await vault.tryLoadCachedKey();
          if (loadedAfterToken) {
            this.status = config.paused ? 'paused' : 'idle';
            this.updateStatusBar();
          }
        }
      }
      if (!vault.isUnlocked()) {
        this.status = 'locked';
        this.updateStatusBar();
        return;
      }
    }
    if (!this.isAutoSyncEnabled() || !isProFeatureEnabled(ProFeature.CloudSync)) {
      return;
    }
    setTimeout(() => void this.runSync(), 2000);
  }

  setStatusBar(statusBar: SyncStatusBar): void {
    this.statusBar = statusBar;
    this.updateStatusBar();
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getConflictCount(): number {
    return this.conflictCount;
  }

  getConfig(): SyncConfig {
    return this.context.globalState.get<SyncConfig>(SYNC_CONFIG_KEY, {
      syncConnections: true,
      syncQueries: true,
      syncNotebooks: true,
      syncPasswords: false,
      paused: false,
    });
  }

  async saveConfig(config: SyncConfig): Promise<void> {
    await this.context.globalState.update(SYNC_CONFIG_KEY, config);
    this.status = config.paused ? 'paused' : 'idle';
    this.updateStatusBar();
  }

  private isAutoSyncEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>('postgresExplorer.sync.auto', true);
  }

  private getBaseManifest(): SyncItemMeta[] {
    return this.context.globalState.get<SyncItemMeta[]>(SYNC_BASE_MANIFEST_KEY, []);
  }

  private async setBaseManifest(manifest: SyncItemMeta[]): Promise<void> {
    await this.context.globalState.update(SYNC_BASE_MANIFEST_KEY, manifest);
  }

  createProvider(providerId: SyncProviderId): SyncProvider {
    switch (providerId) {
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
      default:
        throw new Error(`Unknown provider: ${providerId}`);
    }
  }

  schedulePush(): void {
    const config = this.getConfig();
    if (
      !config.providerId ||
      config.paused ||
      !this.isAutoSyncEnabled() ||
      !isProFeatureEnabled(ProFeature.CloudSync)
    ) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => void this.runSync(), SYNC_DEBOUNCE_MS);
  }

  /** Immediate sync for structural changes (create / rename / delete). */
  scheduleInstantSync(): void {
    const config = this.getConfig();
    if (!config.providerId || config.paused) {
      return;
    }
    if (!isProFeatureEnabled(ProFeature.CloudBackup)) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    void this.runSync();
  }

  async runSync(options: SyncRunOptions = {}): Promise<SyncRunResult | SyncPreviewResult | undefined> {
    const config = this.getConfig();
    if (!config.providerId || config.paused) {
      return undefined;
    }

    if (!isSyncProviderAllowed(config.providerId)) {
      this.status = 'error';
      this.updateStatusBar();
      const tier = syncProviderMinTier(config.providerId);
      void vscode.window.showWarningMessage(
        `Your current plan does not include the "${config.providerId}" sync backend (requires NexQL ${TIER_DISPLAY[tier]}). `
        + `NexQL Cloud data is kept for ${CLOUD_INACTIVE_RETENTION_DAYS} days while inactive, then deleted. Renew or switch to a free Postgres backup.`,
        'View Plans',
      ).then((c) => {
        if (c === 'View Plans') {
          void vscode.env.openExternal(vscode.Uri.parse('https://nexql.astrx.dev/#pricing'));
        }
      });
      return undefined;
    }

    const vault = VaultService.getInstance();
    if (!vault.isUnlocked()) {
      const loaded = await vault.tryLoadCachedKey();
      if (!loaded) {
        this.status = 'locked';
        this.updateStatusBar();
        return undefined;
      }
    }

    const run = () => this.runSyncLocked(options);
    const outcome = this.syncTail.then(run, run);
    this.syncTail = outcome.then(() => undefined, () => undefined);
    return outcome as Promise<SyncRunResult | SyncPreviewResult | undefined>;
  }

  private async runSyncLocked(options: SyncRunOptions = {}): Promise<SyncRunResult | SyncPreviewResult | undefined> {
    const config = this.getConfig();
    const providerId = config.providerId;
    if (!providerId) {
      return undefined;
    }
    const direction = options.direction ?? 'both';
    const dryRun = !!options.dryRun;
    const vault = VaultService.getInstance();

    this.syncInFlight = true;
    this.status = 'syncing';
    this.updateStatusBar();
    const start = Date.now();
    const deviceId = getOrCreateDeviceId(this.context);
    const provider = this.createProvider(providerId);
    const index = new SyncIndex(this.context);

    try {
      if (!isProFeatureEnabled(ProFeature.CloudSync)) {
        const bound = await this.ensureDeviceBinding(provider, deviceId);
        if (!bound) {
          this.status = 'error';
          this.updateStatusBar();
          return undefined;
        }
      }

      const baseManifest = this.getBaseManifest();
      const excluded = new Set([
        ...(config.excludedIds ?? []),
        ...(options.transientExcludedIds ?? []),
      ]);
      const localItems = (await this.collectLocalItems(config, deviceId, index))
        .filter((i) => !excluded.has(i.meta.id));
      this.appendLocalTombstones(baseManifest, localItems, config, deviceId, index, excluded);

      const remoteSnapshot = await provider.pull();
      const remoteItems = remoteSnapshot.manifest
        .filter((meta) => !excluded.has(meta.id))
        .map((meta) => ({
          meta,
          getBlob: () => remoteSnapshot.getBlob(meta.id),
        }));

      const merge = await mergeSyncState(
        baseManifest,
        localItems,
        remoteItems,
        deviceId,
        (blob) => vault.decrypt(blob),
      );

      let encryptedPush = attachEncryptedBlobs(merge.toPush, localItems, (p) => vault.encrypt(p));
      let newBaseManifest = merge.newBaseManifest;
      let toApply = merge.toApply;

      if (excluded.size > 0) {
        encryptedPush = encryptedPush.filter((i) => !excluded.has(i.meta.id));
        toApply = merge.toApply.filter((i) => !excluded.has(i.meta.id));
      }

      const previewLists = buildPreviewFromMerge(
        baseManifest,
        localItems,
        encryptedPush,
        toApply,
        merge.conflicts,
        (id, kind) => this.resolveItemName(id, kind, index),
      );

      if (dryRun) {
        const summary = buildSyncChangeSummary(baseManifest, localItems, encryptedPush, toApply);
        const preview: SyncPreviewResult = {
          pushed: encryptedPush.length,
          pulled: toApply.length,
          conflicts: merge.conflicts.length,
          skipped: merge.skipped.length,
          durationMs: Date.now() - start,
          provider: providerId,
          summary,
          outgoing: previewLists.outgoing,
          incoming: previewLists.incoming,
          conflictItems: previewLists.conflictItems,
        };
        await this.context.globalState.update(SYNC_PREVIEW_CACHE_KEY, preview);
        this.status = this.resolveIdleStatus(merge.conflicts.length);
        this.updateStatusBar();
        return preview;
      }

      let skipped = merge.skipped.length;
      const doPush = direction === 'both' || direction === 'push';
      const doPull = direction === 'both' || direction === 'pull';

      if (doPush) {
        const pushOptions = { manifest: newBaseManifest };
        try {
          await provider.push(encryptedPush, pushOptions);
        } catch (e) {
          if (e instanceof OversizedItemError) {
            skipped += e.itemIds.length;
            for (const id of e.itemIds) {
              vscode.window.showWarningMessage(`Sync skipped oversized notebook: ${id}`);
            }
            const oversized = new Set(e.itemIds);
            encryptedPush = encryptedPush.filter((i) => !oversized.has(i.meta.id));
            const baseById = new Map(baseManifest.map((m) => [m.id, m]));
            newBaseManifest = newBaseManifest
              .map((m) => (oversized.has(m.id) ? baseById.get(m.id) : m))
              .filter((m): m is SyncItemMeta => m !== undefined);
            await provider.push(encryptedPush, { manifest: newBaseManifest });
          } else {
            throw e;
          }
        }
      }

      if (doPull) {
        await this.applyRemoteItems(toApply, config, index);
        this.logInboundApplied(toApply, index);
      }

      const syncedKeys = new Set<string>();
      if (doPush) {
        for (const item of encryptedPush) {
          syncedKeys.add(metaKey(item.meta));
        }
      }
      if (doPull) {
        for (const item of toApply) {
          syncedKeys.add(metaKey(item.meta));
        }
      }

      const conflictIds = new Set(merge.conflicts.map((c) => c.id));
      const ackKeys = this.buildAcknowledgeKeys(syncedKeys, localItems, newBaseManifest, conflictIds);
      SyncActivityLog.getInstance(this.context).acknowledge(ackKeys);

      const updatedBase = mergeBaseManifestPartial(baseManifest, newBaseManifest, syncedKeys);
      await this.setBaseManifest(updatedBase);
      index.markSynced(updatedBase);
      this.purgeStaleNotebookIndex(index, updatedBase);
      await index.flush();

      await this.context.globalState.update(SYNC_LAST_CONFLICTS_KEY, merge.conflicts);
      this.conflictCount = merge.conflicts.length + this.countConflictCopies();
      this.status = this.conflictCount > 0 ? 'conflict' : 'synced';
      this.backoffMs = SYNC_BACKOFF_INITIAL_MS;

      await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
      await this.context.globalState.update(SYNC_LAST_ERROR_KEY, undefined);

      if (merge.conflicts.length > 0) {
        const choice = await vscode.window.showWarningMessage(
          `${merge.conflicts.length} sync conflict(s) — review and resolve.`,
          'Resolve…',
        );
        if (choice === 'Resolve…') {
          void vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync', tab: 'conflicts' });
        }
      }

      const summary = buildSyncChangeSummary(
        baseManifest,
        localItems,
        doPush ? encryptedPush : [],
        doPull ? toApply : [],
      );

      const result: SyncRunResult = {
        pushed: doPush ? encryptedPush.length : 0,
        pulled: doPull ? toApply.length : 0,
        conflicts: merge.conflicts.length,
        skipped,
        durationMs: Date.now() - start,
        provider: providerId,
        summary,
      };

      this.outputChannel.appendLine(
        `sync: dir=${direction} pushed=${result.pushed} pulled=${result.pulled} conflicts=${result.conflicts} skipped=${result.skipped} durationMs=${result.durationMs} provider=${result.provider} ` +
        `push(+/~/-)=${formatCountsLine(summary.pushed)} pull(+/~/-)=${formatCountsLine(summary.pulled)}`,
      );

      TelemetryService.getInstance().trackEvent('sync_run', {
        pushed: result.pushed,
        pulled: result.pulled,
        conflicts: result.conflicts,
        skipped: result.skipped,
        durationMs: result.durationMs,
        provider: result.provider,
        direction,
      });

      this.updateStatusBar();
      return result;
    } catch (e) {
      const isNetwork = e instanceof Error && /timeout|ECONNREFUSED|ENOTFOUND|network/i.test(e.message);
      this.status = isNetwork ? 'offline' : 'error';
      this.backoffMs = Math.min(this.backoffMs * 2, SYNC_BACKOFF_MAX_MS);
      await this.context.globalState.update(
        SYNC_LAST_ERROR_KEY,
        e instanceof Error ? e.message : String(e),
      );
      this.updateStatusBar();

      TelemetryService.getInstance().trackEvent('sync_failure', {
        failureClass: isNetwork ? 'network' : 'other',
        provider: providerId,
      });

      this.outputChannel.appendLine(`sync: failed ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => void this.runSync(), this.backoffMs);
      return undefined;
    } finally {
      this.syncInFlight = false;
    }
  }

  async previewSync(transientExcludedIds?: string[]): Promise<SyncPreviewResult | undefined> {
    return this.runSync({ dryRun: true, transientExcludedIds }) as Promise<SyncPreviewResult | undefined>;
  }

  async pullOnly(): Promise<SyncRunResult | undefined> {
    return this.runSync({ direction: 'pull' });
  }

  async pushOnly(): Promise<SyncRunResult | undefined> {
    return this.runSync({ direction: 'push' });
  }

  getLastSyncAt(): number | undefined {
    return this.context.globalState.get<number>(SYNC_LAST_SYNC_AT_KEY);
  }

  getLastError(): string | undefined {
    return this.context.globalState.get<string>(SYNC_LAST_ERROR_KEY);
  }

  listInboundHistory(): InboundEntry[] {
    return SyncActivityLog.getInstance(this.context).listInbound();
  }

  async getCloudQuota(): Promise<CloudQuotaView | undefined> {
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return undefined;
    }
    const provider = this.createProvider('cloud') as CloudSyncProvider;
    return provider.getQuota();
  }

  async listCloudDevices(): Promise<SyncDeviceView[]> {
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return [];
    }
    const provider = this.createProvider('cloud') as CloudSyncProvider;
    return provider.listDevices();
  }

  async revokeCloudDevice(deviceId: string): Promise<boolean> {
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return false;
    }
    const provider = this.createProvider('cloud') as CloudSyncProvider;
    return provider.revokeDevice(deviceId);
  }

  async replaceLocalWithCloud(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId) {
      return false;
    }
    const vault = VaultService.getInstance();
    if (!vault.isUnlocked() && !(await vault.tryLoadCachedKey())) {
      return false;
    }
    const provider = this.createProvider(config.providerId);
    const index = new SyncIndex(this.context);
    const remoteSnapshot = await provider.pull();
    const toApply: Array<{ meta: SyncItemMeta; plaintext: Buffer }> = [];
    for (const meta of remoteSnapshot.manifest.filter((m) => !m.deleted)) {
      const blob = await remoteSnapshot.getBlob(meta.id);
      if (!blob) {
        continue;
      }
      toApply.push({ meta, plaintext: vault.decrypt(blob) });
    }
    await this.applyRemoteItems(toApply, config, index);
    await this.setBaseManifest(remoteSnapshot.manifest);
    index.markSynced(remoteSnapshot.manifest);
    await index.flush();
    await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
    this.status = 'synced';
    this.updateStatusBar();
    return true;
  }

  async replaceCloudWithLocal(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId) {
      return false;
    }
    const vault = VaultService.getInstance();
    if (!vault.isUnlocked() && !(await vault.tryLoadCachedKey())) {
      return false;
    }
    const deviceId = getOrCreateDeviceId(this.context);
    const index = new SyncIndex(this.context);
    const localItems = await this.collectLocalItems(config, deviceId, index);
    const pushItems = localItems.map((i) => ({
      meta: i.meta,
      blob: vault.encrypt(i.plaintext),
    }));
    const manifest = localItems.map((i) => i.meta);
    const provider = this.createProvider(config.providerId);
    await provider.push(pushItems, { manifest });
    await this.setBaseManifest(manifest);
    index.markSynced(manifest);
    await index.flush();
    await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
    this.status = 'synced';
    this.updateStatusBar();
    return true;
  }

  async rebuildSyncIndex(): Promise<number> {
    const config = this.getConfig();
    const deviceId = getOrCreateDeviceId(this.context);
    const index = new SyncIndex(this.context);
    for (const id of Object.keys(index.getAll())) {
      index.remove(id);
    }
    const items = await this.collectLocalItems(config, deviceId, index);
    for (const item of items) {
      index.update(item.meta.id, {
        kind: item.meta.kind,
        name: this.resolveItemName(item.meta.id, item.meta.kind, index),
        modifiedAt: item.meta.updatedAt,
        syncedRevision: item.meta.revision,
        lastObservedHash: item.meta.contentHash,
      });
    }
    await index.flush();
    return items.length;
  }

  async runDiagnostics(): Promise<void> {
    const config = this.getConfig();
    const lines: string[] = ['PgStudio Sync Diagnostics', '========================'];
    lines.push(`Status: ${this.status}`);
    lines.push(`Provider: ${config.providerId ?? 'none'}`);
    lines.push(`Vault unlocked: ${VaultService.getInstance().isUnlocked()}`);
    lines.push(`Device id: ${getOrCreateDeviceId(this.context)}`);
    lines.push(`Device name: ${getDeviceName(this.context) ?? '(unset)'}`);
    lines.push(`Base manifest items: ${this.getBaseManifest().length}`);
    lines.push(`Index items: ${Object.keys(new SyncIndex(this.context).getAll()).length}`);
    lines.push(`Conflicts (last run): ${this.context.globalState.get(SYNC_LAST_CONFLICTS_KEY, []).length}`);
    lines.push(`Conflict copies: ${this.countConflictCopies()}`);
    lines.push(`Pending outbound: ${this.listPendingActivities().length}`);
    lines.push(`Inbound history: ${this.listInboundHistory().length}`);
    if (config.providerId) {
      try {
        const test = await this.createProvider(config.providerId).testConnection();
        lines.push(`Provider reachable: ${test.ok}${test.error ? ` (${test.error})` : ''}`);
      } catch (e) {
        lines.push(`Provider reachable: false (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (config.providerId === 'cloud') {
      const quota = await this.getCloudQuota();
      if (quota) {
        lines.push(`Cloud quota: ${quota.bytesUsed}/${quota.bytesLimit} bytes, ${quota.itemCount} items`);
      }
    }
    const lastErr = this.getLastError();
    if (lastErr) {
      lines.push(`Last error: ${lastErr}`);
    }
    this.outputChannel.appendLine(lines.join('\n'));
    this.outputChannel.show(true);
  }

  async getItemPlaintext(id: string): Promise<string | undefined> {
    const config = this.getConfig();
    const deviceId = getOrCreateDeviceId(this.context);
    const index = new SyncIndex(this.context);
    const entry = index.get(id);
    if (!entry) {
      return undefined;
    }
    try {
      if (entry.kind === 'query') {
        const q = SavedQueriesService.getInstance().getQueries().find((x) => x.id === id);
        return q ? JSON.stringify(q, null, 2) : undefined;
      }
      if (entry.kind === 'notebook') {
        const items = await new NotebookSyncService(this.context, index).collectLocalNotebooks(deviceId);
        const match = items.find((i) => i.meta.id === id);
        return match ? match.plaintext.toString() : undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  schedulePushAfterConflict(): void {
    this.schedulePush();
  }

  private resolveItemName(id: string, kind: SyncItemMeta['kind'], index: SyncIndex): string | undefined {
    const entry = index.get(id);
    if (entry?.name) {
      return entry.name;
    }
    if (kind === 'query') {
      try {
        const q = SavedQueriesService.getInstance().getQueries().find((x) => x.id === id);
        return q?.title;
      } catch {
        return undefined;
      }
    }
    if (kind === 'connection') {
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const conn = connections.find((c) => String(c.id) === id);
      return conn?.name ?? `${conn?.host}:${conn?.port}`;
    }
    return undefined;
  }

  private logInboundApplied(
    items: Array<{ meta: SyncItemMeta; plaintext: Buffer }>,
    index: SyncIndex,
  ): void {
    const log = SyncActivityLog.getInstance(this.context);
    for (const { meta } of items) {
      if (meta.deleted) {
        continue;
      }
      log.recordInbound({
        itemId: meta.id,
        kind: meta.kind,
        name: this.resolveItemName(meta.id, meta.kind, index),
        deviceId: meta.deviceId,
        deviceName: undefined,
      });
    }
  }

  private countConflictCopies(): number {
    return this.listSyncedItems().filter((i) => /-conflict-\d+$/.test(i.id)).length;
  }

  /**
   * Free-tier single-device enforcement. First device claims the backup;
   * a different device must explicitly take it over (metered to 1/week so
   * rebinding cannot be used as manual multi-device sync).
   */
  private async ensureDeviceBinding(provider: SyncProvider, deviceId: string): Promise<boolean> {
    if (!provider.getBoundDeviceId || !provider.setBoundDeviceId) {
      return true;
    }
    const bound = await provider.getBoundDeviceId();
    if (!bound) {
      await provider.setBoundDeviceId(deviceId);
      return true;
    }
    if (bound === deviceId) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      'This backup belongs to another device. The free plan keeps backups bound to a single device — upgrade for multi-device sync, or claim the backup on this device (the other device will stop syncing).',
      'Claim Backup Here',
      'View Plans',
    );
    if (choice === 'Claim Backup Here') {
      if (!(await requirePro(ProFeature.SyncDeviceRebind))) {
        return false;
      }
      await provider.setBoundDeviceId(deviceId);
      return true;
    }
    if (choice === 'View Plans') {
      void vscode.env.openExternal(vscode.Uri.parse('https://nexql.astrx.dev/#pricing'));
    }
    return false;
  }

  private async collectLocalItems(
    config: SyncConfig,
    deviceId: string,
    index: SyncIndex,
  ): Promise<Array<{ meta: SyncItemMeta; plaintext: Buffer }>> {
    const items: Array<{ meta: SyncItemMeta; plaintext: Buffer }> = [];

    if (config.syncConnections) {
      items.push(...new ConnectionSyncService(this.context, index).collectLocalConnections(deviceId));
    }

    if (config.syncQueries) {
      const queries = SavedQueriesService.getInstance().getAllQueriesForSync();
      for (const q of queries) {
        const plaintext = Buffer.from(JSON.stringify(q));
        items.push({
          meta: {
            id: q.id,
            kind: 'query',
            contentHash: contentHash(plaintext),
            revision: q.revision ?? 1,
            updatedAt: q.updatedAt ?? q.createdAt,
            deviceId,
            deleted: !!q.deleted,
          },
          plaintext,
        });
      }
    }

    if (config.syncNotebooks) {
      items.push(...await new NotebookSyncService(this.context, index).collectLocalNotebooks(deviceId));
    }

    return items;
  }

  /**
   * Items present in the base manifest but missing from local collection were
   * deleted on this device — synthesize tombstones so the deletion propagates.
   * Queries manage their own tombstones; notebooks need on-disk evidence so a
   * notebook that is merely outside the sync folder is not deleted remotely.
   */
  private appendLocalTombstones(
    baseManifest: SyncItemMeta[],
    localItems: Array<{ meta: SyncItemMeta; plaintext: Buffer }>,
    config: SyncConfig,
    deviceId: string,
    index: SyncIndex,
    excluded: ReadonlySet<string> = new Set(),
  ): void {
    const localIds = new Set(localItems.map((i) => `${i.meta.kind}:${i.meta.id}`));
    const nbSvc = new NotebookSyncService(this.context, index);

    for (const base of baseManifest) {
      if (base.deleted || excluded.has(base.id) || localIds.has(`${base.kind}:${base.id}`)) {
        continue;
      }
      if (base.kind === 'connection' && config.syncConnections) {
        localItems.push({ meta: tombstoneMeta(base, deviceId), plaintext: Buffer.from('{}') });
      } else if (base.kind === 'notebook' && config.syncNotebooks && !nbSvc.isPresentOnDisk(base.id)) {
        localItems.push({ meta: tombstoneMeta(base, deviceId), plaintext: Buffer.from('{}') });
      }
    }
  }

  private async applyRemoteItems(
    items: Array<{ meta: SyncItemMeta; plaintext: Buffer }>,
    config: SyncConfig,
    index: SyncIndex,
  ): Promise<void> {
    const connSvc = new ConnectionSyncService(this.context, index);
    const nbSvc = new NotebookSyncService(this.context, index);
    const sqSvc = SavedQueriesService.getInstance();

    for (const { meta, plaintext } of items) {
      if (meta.deleted) {
        switch (meta.kind) {
          case 'query':
            await sqSvc.deleteQuery(meta.id);
            break;
          case 'connection':
            if (config.syncConnections) {
              await connSvc.removeConnection(meta);
            }
            break;
          case 'notebook':
            if (config.syncNotebooks) {
              await nbSvc.deleteNotebook(meta);
            }
            break;
        }
        continue;
      }

      const data = JSON.parse(plaintext.toString());

      switch (meta.kind) {
        case 'connection':
          if (config.syncConnections) {
            await connSvc.applyConnection(data, meta);
          }
          break;
        case 'query': {
          if (config.syncQueries) {
            // Conflict copies arrive under a derived id; keep payload id in step.
            const query = data.id === meta.id
              ? data
              : { ...data, id: meta.id, title: `${data.title ?? meta.id} (conflict from ${meta.deviceId})` };
            await sqSvc.saveQuery({ ...query, revision: meta.revision, updatedAt: meta.updatedAt });
          }
          break;
        }

        case 'notebook':
          if (config.syncNotebooks) {
            await nbSvc.applyNotebook(data, meta);
          }
          break;
        case 'secrets':
          if (config.syncPasswords) {
            const { SecretStorageService } = await import('../../services/SecretStorageService');
            const secrets = SecretStorageService.getInstance();
            for (const [connId, password] of Object.entries(data.passwords ?? {})) {
              await secrets.setPassword(connId, String(password));
            }
          }
          break;
      }
    }
  }

  private updateStatusBar(): void {
    const configured = !!this.getConfig().providerId;
    this.statusBar?.updateSyncStatus(this.status, this.conflictCount, configured, {
      lastSyncAt: this.getLastSyncAt(),
      pendingCount: this.listPendingActivities().length,
    });
  }

  /** Restore a non-in-progress status after preview or when sync cannot start. */
  private resolveIdleStatus(newConflictsInRun: number): SyncStatus {
    const config = this.getConfig();
    if (config.paused) {
      return 'paused';
    }
    if (newConflictsInRun > 0 || this.conflictCount > 0) {
      return 'conflict';
    }
    return this.getLastSyncAt() ? 'synced' : 'idle';
  }

  /**
   * Clear pending activities for items reconciled this run — including those
   * already up-to-date (no push/pull transfer needed).
   */
  private buildAcknowledgeKeys(
    transferredKeys: Set<string>,
    localItems: Array<{ meta: SyncItemMeta }>,
    newBaseManifest: SyncItemMeta[],
    conflictIds: ReadonlySet<string>,
  ): Set<string> {
    const keys = new Set(transferredKeys);
    const index = new SyncIndex(this.context);

    for (const key of transferredKeys) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        const kind = parts[0];
        const id = parts.slice(1).join(':');
        const entry = index.get(id);
        if (entry?.filePath) {
          keys.add(`${kind}:${entry.filePath}`);
        }
      }
    }

    const activeBase = new Set(
      newBaseManifest.filter((m) => !m.deleted).map((m) => metaKey(m)),
    );
    for (const { meta } of localItems) {
      if (meta.deleted || conflictIds.has(meta.id)) {
        continue;
      }
      const key = metaKey(meta);
      if (activeBase.has(key)) {
        keys.add(key);
        const entry = index.get(meta.id);
        if (entry?.filePath) {
          keys.add(`${meta.kind}:${entry.filePath}`);
        }
      }
    }
    return keys;
  }

  /**
   * Items known to sync on this device: base manifest (synced) plus local
   * index (not yet pushed). Names come from local sources only — the remote
   * manifest is zero-knowledge.
   */
  listPendingActivities(): SyncActivityView[] {
    return SyncActivityLog.getInstance(this.context).listPending();
  }

  private seedConnectionSnapshot(): void {
    const connections = vscode.workspace.getConfiguration().get<Record<string, unknown>[]>(
      'postgresExplorer.connections',
      [],
    );
    this.connectionSnapshot = new Map(
      connections.map((c) => [String(c.id), SyncController.connectionFingerprint(c)]),
    );
  }

  private static connectionFingerprint(conn: Record<string, unknown>): string {
    const copy = { ...conn };
    delete copy.password;
    return JSON.stringify(copy);
  }

  private static connectionNameFromFingerprint(fingerprint: string): string | undefined {
    try {
      const parsed = JSON.parse(fingerprint) as { name?: string };
      return parsed.name;
    } catch {
      return undefined;
    }
  }

  private recordOpenNotebookActivity(
    doc: vscode.NotebookDocument,
    action: 'create' | 'update',
  ): void {
    if (doc.notebookType !== 'postgres-notebook' && doc.notebookType !== 'postgres-query') {
      return;
    }
    if (doc.isUntitled || doc.uri.scheme !== 'file') {
      return;
    }
    const metadata = doc.metadata as Record<string, unknown>;
    const syncId = typeof metadata.syncId === 'string' ? metadata.syncId : undefined;
    if (!syncId) {
      return;
    }
    recordSyncActivity({
      kind: 'notebook',
      action,
      itemId: syncId,
      name: doc.uri.path.split('/').pop()?.replace(/\.pgsql$/i, ''),
    });
  }

  private recordConnectionConfigChanges(): boolean {
    const connections = vscode.workspace.getConfiguration().get<Record<string, unknown>[]>(
      'postgresExplorer.connections',
      [],
    );
    if (!this.connectionSnapshot) {
      this.connectionSnapshot = new Map(
        connections.map((c) => [String(c.id), SyncController.connectionFingerprint(c)]),
      );
      return false;
    }
    let changed = false;
    const next = new Map(
      connections.map((c) => [String(c.id), SyncController.connectionFingerprint(c)]),
    );
    for (const conn of connections) {
      const id = String(conn.id);
      const fp = next.get(id)!;
      const prev = this.connectionSnapshot.get(id);
      const name = typeof conn.name === 'string' ? conn.name : undefined;
      if (!prev) {
        recordSyncActivity({ kind: 'connection', action: 'create', itemId: id, name });
        changed = true;
      } else if (prev !== fp) {
        const prevName = SyncController.connectionNameFromFingerprint(prev);
        recordSyncActivity({
          kind: 'connection',
          action: prevName !== name ? 'rename' : 'update',
          itemId: id,
          name,
          previousName: prevName !== name ? prevName : undefined,
        });
        changed = true;
      }
    }
    for (const [id, fp] of this.connectionSnapshot) {
      if (!next.has(id)) {
        recordSyncActivity({
          kind: 'connection',
          action: 'delete',
          itemId: id,
          name: SyncController.connectionNameFromFingerprint(fp),
        });
        changed = true;
      }
    }
    this.connectionSnapshot = next;
    return changed;
  }

  private connectionSnapshot: Map<string, string> | undefined;

  private async recordNotebookFileActivity(
    uri: vscode.Uri,
    action: 'create' | 'update',
  ): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(raw).toString()) as Record<string, unknown>;
      const syncId = readNotebookSyncId(parsed);
      if (!syncId) {
        return;
      }
      const name = uri.path.split('/').pop()?.replace(/\.pgsql$/i, '');
      recordSyncActivity({
        kind: 'notebook',
        action,
        itemId: syncId,
        name,
      });
    } catch {
      /* unreadable notebook file */
    }
  }

  private recordNotebookFileDelete(uri: vscode.Uri): void {
    const index = new SyncIndex(this.context);
    const match = index.findByPath(uri.fsPath);
    if (match) {
      recordSyncActivity({
        kind: 'notebook',
        action: 'delete',
        itemId: match.id,
        name: match.entry.name ?? uri.path.split('/').pop()?.replace(/\.pgsql$/i, ''),
      });
      return;
    }
    const name = uri.path.split('/').pop()?.replace(/\.pgsql$/i, '');
    if (name) {
      recordSyncActivity({
        kind: 'notebook',
        action: 'delete',
        itemId: uri.fsPath,
        name,
      });
    }
  }

  listSyncedItems(): SyncedItemView[] {
    const config = this.getConfig();
    const excluded = new Set(config.excludedIds ?? []);
    const index = new SyncIndex(this.context);
    const indexEntries = index.getAll();
    const baseManifest = this.getBaseManifest();
    const baseActiveIds = new Set(baseManifest.filter((m) => !m.deleted).map((m) => m.id));
    const pendingIds = new Set(this.listPendingActivities().map((p) => p.itemId));
    const nbSvc = new NotebookSyncService(this.context, index);
    const byId = new Map<string, SyncedItemView>();

    const resolveItemStatus = (id: string, isExcluded: boolean): SyncedItemView['itemStatus'] => {
      if (isExcluded) {
        return 'excluded';
      }
      if (pendingIds.has(id)) {
        return 'pending';
      }
      if (baseActiveIds.has(id)) {
        return 'synced';
      }
      return 'local';
    };

    for (const meta of baseManifest) {
      const isExcluded = excluded.has(meta.id);
      byId.set(meta.id, {
        id: meta.id,
        kind: meta.kind,
        name: indexEntries[meta.id]?.name,
        updatedAt: meta.updatedAt,
        deviceId: meta.deviceId,
        revision: meta.revision,
        excluded: isExcluded,
        deleted: meta.deleted,
        itemStatus: resolveItemStatus(meta.id, isExcluded),
      });
    }
    for (const [id, entry] of Object.entries(indexEntries)) {
      if (!byId.has(id)) {
        const isExcluded = excluded.has(id);
        byId.set(id, {
          id,
          kind: entry.kind,
          name: entry.name,
          updatedAt: entry.modifiedAt ?? entry.syncedAt,
          revision: entry.syncedRevision || undefined,
          excluded: isExcluded,
          deleted: false,
          itemStatus: resolveItemStatus(id, isExcluded),
        });
      }
    }

    try {
      for (const q of SavedQueriesService.getInstance().getQueries()) {
        const view = byId.get(q.id);
        if (view && !view.name) {
          view.name = q.title;
        }
      }
    } catch {
      /* saved queries unavailable — ids shown instead */
    }
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    for (const conn of connections) {
      const view = byId.get(String(conn.id));
      if (view && !view.name) {
        view.name = conn.name ?? `${conn.host}:${conn.port}`;
      }
    }

    return [...byId.values()]
      .filter((v) => {
        if (v.deleted) {
          return false;
        }
        if (v.kind === 'notebook' && !baseActiveIds.has(v.id) && !nbSvc.isPresentOnDisk(v.id)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  /** Drop index rows for notebooks that are gone locally and no longer active in sync. */
  private purgeStaleNotebookIndex(index: SyncIndex, manifest: SyncItemMeta[]): void {
    const activeIds = new Set(
      manifest.filter((m) => !m.deleted && m.kind === 'notebook').map((m) => m.id),
    );
    const nbSvc = new NotebookSyncService(this.context, index);
    for (const id of Object.keys(index.getAll())) {
      const entry = index.get(id);
      if (entry?.kind !== 'notebook') {
        continue;
      }
      if (activeIds.has(id) || nbSvc.isPresentOnDisk(id)) {
        continue;
      }
      index.remove(id);
    }
  }

  /**
   * Resolve a local shareable item (query or notebook) to its raw payload for
   * sharing. Connections and secrets are never shareable and return undefined.
   */
  async getShareableItem(id: string): Promise<{ kind: 'query' | 'notebook'; raw: Record<string, unknown>; name: string } | undefined> {
    try {
      const query = SavedQueriesService.getInstance().getQueries().find((q) => q.id === id);
      if (query) {
        return { kind: 'query', raw: query as unknown as Record<string, unknown>, name: query.title };
      }
    } catch {
      /* saved queries unavailable */
    }
    const index = new SyncIndex(this.context);
    const entry = index.get(id);
    if (entry?.kind === 'notebook') {
      const deviceId = getOrCreateDeviceId(this.context);
      const items = await new NotebookSyncService(this.context, index).collectLocalNotebooks(deviceId);
      const match = items.find((i) => i.meta.id === id);
      if (match) {
        const raw = JSON.parse(match.plaintext.toString()) as Record<string, unknown>;
        return { kind: 'notebook', raw, name: (raw.name as string) ?? entry.name ?? 'Notebook' };
      }
    }
    return undefined;
  }

  /** Exclude/re-include an item from sync on this device. */
  async setItemExcluded(id: string, excludedFlag: boolean): Promise<void> {
    const config = this.getConfig();
    const set = new Set(config.excludedIds ?? []);
    if (excludedFlag) {
      set.add(id);
    } else {
      set.delete(id);
    }
    await this.saveConfig({ ...config, excludedIds: [...set] });
  }

  /**
   * Delete the remote copy (tombstone — other devices remove theirs on next
   * pull) while keeping the local copy and excluding it from future sync.
   */
  async removeFromCloud(id: string): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId) {
      return false;
    }
    const vault = VaultService.getInstance();
    if (!vault.isUnlocked() && !(await vault.tryLoadCachedKey())) {
      return false;
    }
    const base = this.getBaseManifest();
    const meta = base.find((m) => m.id === id && !m.deleted);
    if (!meta) {
      return false;
    }
    const deviceId = getOrCreateDeviceId(this.context);
    const tombstone = tombstoneMeta(meta, deviceId);
    const newBase = base.map((m) => (m.id === id ? tombstone : m));
    const provider = this.createProvider(config.providerId);
    await provider.push(
      [{ meta: tombstone, blob: vault.encrypt(Buffer.from('{}')) }],
      { manifest: newBase },
    );
    await this.setBaseManifest(newBase);
    const index = new SyncIndex(this.context);
    index.remove(id);
    await index.flush();
    await this.setItemExcluded(id, true);
    return true;
  }

  async signOut(): Promise<void> {
    await VaultService.getInstance().signOut();
    await AccountService.getInstance().signOut();
    if (this.getConfig().providerId === 'gist') {
      const { GistSyncProvider } = await import('./providers/GistSyncProvider');
      await GistSyncProvider.clearStoredGistId(this.context);
    }
    await this.saveConfig({
      ...this.getConfig(),
      providerId: undefined,
      gistId: undefined,
      paused: false,
    });
    SyncActivityLog.getInstance(this.context).clearAll();
    this.connectionSnapshot = undefined;
    this.status = 'not_configured';
    this.updateStatusBar();
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
