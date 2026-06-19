import * as fs from 'fs';
import * as vscode from 'vscode';
import { contentHash } from './envelope';
import { SyncIndex } from './SyncIndex';
import { SyncMutex } from './SyncMutex';
import { PlaintextCodec, type BlobCodec } from './BlobCodec';
import { decideIncoming } from './SyncEngineV2';
import { ConnectionSyncService } from './ConnectionSyncService';
import { NotebookSyncService } from './NotebookSyncService';
import { CloudSyncProvider } from './providers/CloudSyncProvider';
import { PostgresSyncProvider } from './providers/PostgresSyncProvider';
import { SyncActivityLog, bindSyncActivityLog, recordSyncActivity } from './SyncActivityLog';
import { getOrCreateDeviceId } from './deviceId';
import { SavedQueriesService } from '../savedQueries/SavedQueriesService';
import {
  ProFeature,
  isProFeatureEnabled,
  isSyncProviderAllowed,
} from '../../services/featureGates';
import type { SyncStatusBar } from '../../activation/statusBar';
import {
  SYNC_CONFIG_KEY,
  SYNC_CURSOR_KEY,
  SYNC_LAST_SYNC_AT_KEY,
  SYNC_LAST_ERROR_KEY,
  SYNC_DEBOUNCE_MS,
  SYNC_PERIODIC_MS,
} from './constants';
import type {
  CloudQuotaView,
  InboundEntry,
  SyncChangeSummary,
  SyncConfig,
  SyncDelta,
  SyncDeviceView,
  SyncDirectionSummary,
  SyncItemMeta,
  SyncOp,
  RemoteItemMeta,
  SyncPreviewItem,
  SyncPreviewResult,
  SyncProviderId,
  SyncProviderV2,
  SyncRunOptions,
  SyncRunResult,
  SyncStatus,
  SyncedItemView,
} from './types';

type LocalItem = { meta: SyncItemMeta; plaintext: Buffer };

const DEFAULT_CONFIG: SyncConfig = {
  syncConnections: true,
  syncQueries: true,
  syncNotebooks: true,
  paused: false,
};

function emptyDirection(): SyncDirectionSummary {
  const z = () => ({ created: 0, updated: 0, deleted: 0 });
  return { connections: z(), queries: z(), notebooks: z() };
}

function emptySummary(): SyncChangeSummary {
  return { pushed: emptyDirection(), pulled: emptyDirection() };
}

/**
 * Git-like sync orchestrator. The server is the source of truth; this device
 * tracks a single cursor per space and reconciles via delta pull + atomic
 * compare-and-swap push. Status only reaches `synced` after a full run commits.
 */
export class SyncController implements vscode.Disposable {
  private static instance: SyncController | undefined;

  private readonly mutex = new SyncMutex();
  private readonly codec: BlobCodec = new PlaintextCodec();
  private status: SyncStatus = 'not_configured';
  private conflictCount = 0;
  private statusBar?: SyncStatusBar;
  private provider?: SyncProviderV2;
  private debounceTimer?: NodeJS.Timeout;
  private periodicTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private lastErrorNotifiedAt = 0;
  private lastSuccessfulSyncAt = 0;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  static getInstance(context?: vscode.ExtensionContext, output?: vscode.OutputChannel): SyncController {
    if (!SyncController.instance) {
      if (!context || !output) {
        throw new Error('SyncController not initialized');
      }
      SyncController.instance = new SyncController(context, output);
    }
    return SyncController.instance;
  }

  static resetInstanceForTests(): void {
    SyncController.instance = undefined;
  }

  initialize(statusBar?: SyncStatusBar): void {
    this.statusBar = statusBar;
    bindSyncActivityLog(this.context);
    const config = this.getConfig();
    this.status = config.providerId ? (config.paused ? 'paused' : 'idle') : 'not_configured';
    this.updateStatusBar();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('postgresExplorer.connections')) {
          recordSyncActivity({ kind: 'connection', action: 'update', itemId: 'connections', name: 'Connections' });
          this.schedulePush();
        }
      }),
      vscode.workspace.onDidSaveNotebookDocument(() => this.scheduleInstantSync()),
    );

    if (config.providerId && !config.paused && this.isAutoSyncEnabled()) {
      this.startPeriodicPull();
      void this.runSync().catch(() => undefined);
    }
  }

  setStatusBar(statusBar: SyncStatusBar): void {
    this.statusBar = statusBar;
    this.updateStatusBar();
  }

  // ── Config / cursor ─────────────────────────────────────────────────────────

  getConfig(): SyncConfig {
    return { ...DEFAULT_CONFIG, ...this.context.globalState.get<SyncConfig>(SYNC_CONFIG_KEY, {} as SyncConfig) };
  }

  async saveConfig(config: SyncConfig): Promise<void> {
    await this.context.globalState.update(SYNC_CONFIG_KEY, config);
    this.provider = undefined;
    this.status = config.providerId ? (config.paused ? 'paused' : 'idle') : 'not_configured';
    if (config.providerId && !config.paused && this.isAutoSyncEnabled()) {
      this.startPeriodicPull();
    } else {
      this.stopPeriodicPull();
    }
    this.updateStatusBar();
  }

  private cursorKey(config: SyncConfig): string {
    return `${config.providerId}:${config.spaceId ?? 'personal'}`;
  }

  private getCursor(config: SyncConfig): number {
    const all = this.context.globalState.get<Record<string, number>>(SYNC_CURSOR_KEY, {});
    return all[this.cursorKey(config)] ?? 0;
  }

  private async setCursor(config: SyncConfig, cursor: number): Promise<void> {
    const all = { ...this.context.globalState.get<Record<string, number>>(SYNC_CURSOR_KEY, {}) };
    all[this.cursorKey(config)] = cursor;
    await this.context.globalState.update(SYNC_CURSOR_KEY, all);
  }

  createProvider(providerId: SyncProviderId, spaceId?: string): SyncProviderV2 {
    switch (providerId) {
      case 'cloud':
        return new CloudSyncProvider(this.context, spaceId);
      case 'postgres':
        return new PostgresSyncProvider(this.context);
      default:
        throw new Error(`Unknown sync provider: ${providerId}`);
    }
  }

  private getProvider(config: SyncConfig): SyncProviderV2 {
    if (!this.provider) {
      this.provider = this.createProvider(config.providerId!, config.spaceId);
    }
    return this.provider;
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  getStatus(): SyncStatus {
    return this.status;
  }

  getConflictCount(): number {
    return this.conflictCount;
  }

  getLastSyncAt(): number | undefined {
    return this.context.globalState.get<number>(SYNC_LAST_SYNC_AT_KEY);
  }

  getLastError(): string | undefined {
    return this.context.globalState.get<string>(SYNC_LAST_ERROR_KEY);
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    this.statusBar?.updateSyncStatus(this.status, this.conflictCount, !!this.getConfig().providerId, {
      lastSyncAt: this.getLastSyncAt(),
      pendingCount: this.listPendingActivities().length,
    });
  }

  private isAutoSyncEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>('postgresExplorer.sync.auto', true);
  }

  // ── Scheduling ────────────────────────────────────────────────────────────────

  schedulePush(): void {
    const config = this.getConfig();
    if (!config.providerId || config.paused || !this.isAutoSyncEnabled()) {
      return;
    }
    if (!isProFeatureEnabled(ProFeature.CloudSync)) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => void this.runSync().catch(() => undefined), SYNC_DEBOUNCE_MS);
  }

  scheduleInstantSync(): void {
    const config = this.getConfig();
    if (!config.providerId || config.paused || !this.isAutoSyncEnabled()) {
      return;
    }
    if (!isProFeatureEnabled(ProFeature.CloudBackup)) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => void this.runSync().catch(() => undefined), 750);
  }

  private startPeriodicPull(): void {
    this.stopPeriodicPull();
    this.periodicTimer = setInterval(() => {
      if (isProFeatureEnabled(ProFeature.CloudSync)) {
        void this.runSync({ direction: 'pull' }).catch(() => undefined);
      }
    }, SYNC_PERIODIC_MS);
  }

  private stopPeriodicPull(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
  }

  // ── Sync run ──────────────────────────────────────────────────────────────────

  async runSync(options: SyncRunOptions = {}): Promise<SyncRunResult | SyncPreviewResult | undefined> {
    const config = this.getConfig();
    if (!config.providerId || config.paused) {
      return undefined;
    }
    if (!isSyncProviderAllowed(config.providerId)) {
      this.setStatus('error');
      return undefined;
    }
    if (options.dryRun) {
      return this.preview(config, options.transientExcludedIds);
    }

    const release = await this.mutex.acquire();
    const started = Date.now();
    try {
      this.setStatus('syncing');
      const result = await this.runLocked(config, options);
      this.conflictCount = result.conflicts;
      await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
      await this.context.globalState.update(SYNC_LAST_ERROR_KEY, undefined);
      this.lastSuccessfulSyncAt = Date.now();
      this.setStatus(result.conflicts > 0 ? 'conflict' : 'synced');
      result.durationMs = Date.now() - started;
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.context.globalState.update(SYNC_LAST_ERROR_KEY, message);
      this.output.appendLine(`[sync] run failed: ${message}`);
      this.setStatus('error');
      void this.notifySyncError(message, options.userInitiated === true);
      return undefined;
    } finally {
      release();
    }
  }

  async pullOnly(): Promise<SyncRunResult | undefined> {
    return this.runSync({ direction: 'pull', userInitiated: true }) as Promise<SyncRunResult | undefined>;
  }

  async pushOnly(): Promise<SyncRunResult | undefined> {
    return this.runSync({ direction: 'push', userInitiated: true }) as Promise<SyncRunResult | undefined>;
  }

  async previewSync(transientExcludedIds?: string[]): Promise<SyncPreviewResult | undefined> {
    return this.runSync({ dryRun: true, transientExcludedIds }) as Promise<SyncPreviewResult | undefined>;
  }

  /** The atomic heart: pull → apply → push (with one pull/re-push on conflict). */
  private async runLocked(config: SyncConfig, options: SyncRunOptions): Promise<SyncRunResult> {
    const provider = this.getProvider(config);
    const index = new SyncIndex(this.context);
    const excluded = new Set([...(config.excludedIds ?? []), ...(options.transientExcludedIds ?? [])]);
    const direction = options.direction ?? 'both';
    let cursor = this.getCursor(config);
    let pulled = 0;
    let pushed = 0;
    let conflicts = 0;

    // Phase 1 — pull + apply; commit index + cursor together.
    if (direction !== 'push') {
      const delta = await provider.pullDelta(cursor);
      pulled = await this.applyDelta(delta, config, index, excluded);
      cursor = delta.cursor;
      await this.commitPhase(config, index, cursor);
    }

    // Phase 2 — push dirty + deletions.
    if (direction !== 'pull') {
      const ops = await this.buildOps(config, index, excluded);
      if (ops.length) {
        const result = await provider.pushBatch(ops);
        this.recordAccepted(result.accepted, ops, index);
        pushed = result.accepted.length;
        cursor = result.cursor;
        await this.commitPhase(config, index, cursor);

        if (result.rejected.length) {
          // Concurrent writer — pull their changes, then re-push once (git-style).
          const delta2 = await provider.pullDelta(cursor);
          pulled += await this.applyDelta(delta2, config, index, excluded);
          cursor = delta2.cursor;
          await this.commitPhase(config, index, cursor);

          const ops2 = await this.buildOps(config, index, excluded);
          if (ops2.length) {
            const retry = await provider.pushBatch(ops2);
            this.recordAccepted(retry.accepted, ops2, index);
            pushed += retry.accepted.length;
            cursor = retry.cursor;
            await this.commitPhase(config, index, cursor);
            conflicts = retry.rejected.length;
          }
        }
      }
    }

    this.acknowledgeActivities(index);

    return {
      pushed,
      pulled,
      conflicts,
      skipped: 0,
      durationMs: 0,
      provider: config.providerId!,
      summary: emptySummary(),
    };
  }

  private async preview(config: SyncConfig, transientExcludedIds?: string[]): Promise<SyncPreviewResult> {
    const provider = this.getProvider(config);
    const index = new SyncIndex(this.context);
    const excluded = new Set([...(config.excludedIds ?? []), ...(transientExcludedIds ?? [])]);
    const delta = await provider.pullDelta(this.getCursor(config));
    const localItems = await this.collectLocalItems(config, excluded, index);
    const localById = new Map(localItems.map((i) => [i.meta.id, i]));

    const incoming: SyncPreviewItem[] = [
      ...delta.upserts
        .filter((u) => !excluded.has(u.meta.id))
        .map((u) => ({
          id: u.meta.id,
          kind: u.meta.kind,
          changeType: (localById.has(u.meta.id) ? 'update' : 'create') as 'update' | 'create',
          deviceId: u.meta.deviceId,
        })),
      ...delta.deletes
        .filter((id) => !excluded.has(id))
        .map((id) => ({ id, kind: (index.get(id)?.kind ?? 'query'), changeType: 'delete' as const })),
    ];

    const ops = await this.buildOps(config, index, excluded);
    const outgoing: SyncPreviewItem[] = ops.map((op) => ({
      id: op.itemId,
      kind: op.kind,
      name: index.get(op.itemId)?.name,
      changeType: op.op === 'delete' ? 'delete' : (index.baseVersion(op.itemId) ? 'update' : 'create'),
    }));

    return {
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      skipped: 0,
      durationMs: 0,
      provider: config.providerId!,
      summary: emptySummary(),
      outgoing,
      incoming,
      conflictItems: [],
    };
  }

  // ── Collect / build ops ────────────────────────────────────────────────────────

  private async collectLocalItems(
    config: SyncConfig,
    excluded: ReadonlySet<string>,
    index: SyncIndex,
  ): Promise<LocalItem[]> {
    const deviceId = getOrCreateDeviceId(this.context);
    const items: LocalItem[] = [];

    if (config.syncConnections) {
      items.push(...new ConnectionSyncService(this.context, index).collectLocalConnections(deviceId));
    }
    if (config.syncQueries) {
      for (const q of SavedQueriesService.getInstance().getQueries()) {
        const plaintext = Buffer.from(JSON.stringify(q));
        const hash = contentHash(plaintext);
        const { updatedAt } = index.observe(q.id, 'query', hash, { name: q.title });
        items.push({
          meta: { id: q.id, kind: 'query', contentHash: hash, revision: 0, updatedAt, deviceId, deleted: false },
          plaintext,
        });
      }
    }
    if (config.syncNotebooks) {
      items.push(...(await new NotebookSyncService(this.context, index).collectLocalNotebooks(deviceId)));
    }
    return items.filter((i) => !excluded.has(i.meta.id));
  }

  /** Upserts for dirty local items + deletes for items removed since last sync. */
  private async buildOps(config: SyncConfig, index: SyncIndex, excluded: ReadonlySet<string>): Promise<SyncOp[]> {
    const localItems = await this.collectLocalItems(config, excluded, index);
    const presentIds = new Set(localItems.map((i) => i.meta.id));
    const ops: SyncOp[] = [];

    for (const { meta, plaintext } of localItems) {
      if (index.isDirty(meta.id, meta.contentHash)) {
        ops.push({
          op: 'upsert',
          itemId: meta.id,
          kind: meta.kind,
          baseVersion: index.baseVersion(meta.id),
          contentHash: meta.contentHash,
          blob: this.codec.encode(plaintext),
        });
      }
    }

    // Deletions: synced before, gone locally now.
    const kindEnabled = (k: string) =>
      (k === 'connection' && config.syncConnections) ||
      (k === 'query' && config.syncQueries) ||
      (k === 'notebook' && config.syncNotebooks);
    for (const id of index.syncedIds()) {
      const entry = index.get(id);
      if (!entry || excluded.has(id) || presentIds.has(id) || !kindEnabled(entry.kind)) {
        continue;
      }
      ops.push({ op: 'delete', itemId: id, kind: entry.kind, baseVersion: index.baseVersion(id) });
    }
    return ops;
  }

  private recordAccepted(
    accepted: Array<{ itemId: string; version: number }>,
    ops: SyncOp[],
    index: SyncIndex,
  ): void {
    const opById = new Map(ops.map((o) => [o.itemId, o]));
    for (const { itemId, version } of accepted) {
      const op = opById.get(itemId);
      if (!op) {
        continue;
      }
      if (op.op === 'delete') {
        index.remove(itemId);
      } else {
        index.markSynced(itemId, { kind: op.kind, contentHash: op.contentHash!, version });
      }
    }
  }

  // ── Apply incoming delta ───────────────────────────────────────────────────────

  private async applyDelta(
    delta: SyncDelta,
    config: SyncConfig,
    index: SyncIndex,
    excluded: ReadonlySet<string>,
  ): Promise<number> {
    const connSvc = new ConnectionSyncService(this.context, index);
    const nbSvc = new NotebookSyncService(this.context, index);
    const sqSvc = SavedQueriesService.getInstance();
    const localItems = await this.collectLocalItems(config, excluded, index);
    const localById = new Map(localItems.map((i) => [i.meta.id, i]));
    let applied = 0;

    // Permanent deletes — never resurrected.
    for (const id of delta.deletes) {
      if (excluded.has(id)) {
        continue;
      }
      const kind = index.get(id)?.kind ?? localById.get(id)?.meta.kind;
      const metaStub: SyncItemMeta = { id, kind: kind ?? 'query', contentHash: '', revision: 0, updatedAt: 0, deviceId: '', deleted: true };
      try {
        if (kind === 'connection' && config.syncConnections) {
          await connSvc.removeConnection(metaStub);
        } else if (kind === 'notebook' && config.syncNotebooks) {
          await nbSvc.deleteNotebook(metaStub);
        } else if (kind === 'query' && config.syncQueries) {
          await sqSvc.deleteQuery(id);
        }
      } catch (e) {
        this.output.appendLine(`[sync] delete ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      index.remove(id);
      applied += 1;
    }

    // Upserts — last-writer-wins, loser backed up locally.
    for (const { meta, blob } of delta.upserts) {
      if (excluded.has(meta.id)) {
        continue;
      }
      const local = localById.get(meta.id);
      const decision = decideIncoming(
        !!local,
        local ? index.isDirty(meta.id, local.meta.contentHash) : false,
        local ? local.meta.contentHash === meta.contentHash : false,
        local?.meta.updatedAt ?? 0,
        meta.updatedAt,
      );

      if (decision.applyRemote) {
        if (decision.backupLocal && local) {
          this.backupLocal(local, meta.kind);
        }
        const plaintext = this.codec.decode(blob);
        try {
          await this.applyOne(meta, plaintext, config, connSvc, nbSvc, sqSvc);
          applied += 1;
        } catch (e) {
          this.output.appendLine(`[sync] apply ${meta.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Always adopt the server version so we push the correct CAS base next.
      index.markSynced(meta.id, {
        kind: meta.kind,
        contentHash: meta.contentHash,
        version: meta.version,
        updatedAt: meta.updatedAt,
      });
    }

    return applied;
  }

  private async applyOne(
    meta: RemoteItemMeta,
    plaintext: Buffer,
    config: SyncConfig,
    connSvc: ConnectionSyncService,
    nbSvc: NotebookSyncService,
    sqSvc: SavedQueriesService,
  ): Promise<void> {
    const data = JSON.parse(plaintext.toString());
    // Disk-mapping services predate v2; adapt the remote meta to their shape.
    const shim: SyncItemMeta = {
      id: meta.id,
      kind: meta.kind,
      contentHash: meta.contentHash,
      revision: meta.version,
      updatedAt: meta.updatedAt,
      deviceId: meta.deviceId,
      deleted: false,
    };
    switch (meta.kind) {
      case 'connection':
        if (config.syncConnections) {
          await connSvc.applyConnection(data, shim);
        }
        break;
      case 'query':
        if (config.syncQueries) {
          await sqSvc.saveQuery({ ...data, id: meta.id });
        }
        break;
      case 'notebook':
        if (config.syncNotebooks) {
          await nbSvc.applyNotebook(data, shim);
        }
        break;
    }
    SyncActivityLog.getInstance(this.context).recordInbound({
      itemId: meta.id,
      kind: meta.kind,
      deviceId: meta.deviceId,
    });
  }

  /** Persist index changes before advancing the server cursor. */
  private async commitPhase(config: SyncConfig, index: SyncIndex, cursor: number): Promise<void> {
    await index.flush();
    await this.setCursor(config, cursor);
  }

  private notifySyncError(message: string, userInitiated: boolean): void {
    const now = Date.now();
    const firstSinceSuccess = this.lastSuccessfulSyncAt === 0 || now - this.lastSuccessfulSyncAt > 60_000;
    if (!userInitiated && !firstSinceSuccess) {
      return;
    }
    if (now - this.lastErrorNotifiedAt < 60_000) {
      return;
    }
    this.lastErrorNotifiedAt = now;
    void vscode.window
      .showErrorMessage(`Sync failed: ${message}`, 'Repair Sync')
      .then((action) => {
        if (action === 'Repair Sync') {
          void vscode.commands.executeCommand('postgres-explorer.sync.repair');
        }
      });
  }

  private purgeOrphanPending(index: SyncIndex): void {
    const log = SyncActivityLog.getInstance(this.context);
    const acked: string[] = [];
    for (const p of log.listPending()) {
      if (!index.get(p.itemId)) {
        acked.push(`${p.kind}:${p.itemId}`);
      }
    }
    if (acked.length) {
      log.acknowledge(acked);
    }
  }

  /** Preserve a local copy that lost a conflict so nothing is silently dropped. */
  private backupLocal(local: LocalItem, kind: string): void {
    try {
      if (kind === 'notebook') {
        const entry = new SyncIndex(this.context).get(local.meta.id);
        const filePath = entry?.filePath;
        if (filePath && fs.existsSync(filePath)) {
          fs.copyFileSync(filePath, `${filePath}.backup-${Date.now()}`);
          return;
        }
      }
      if (kind === 'query') {
        const data = JSON.parse(local.plaintext.toString());
        void SavedQueriesService.getInstance().saveQuery({
          ...data,
          id: `${local.meta.id}-backup-${Date.now()}`,
          title: `${data.title ?? 'Query'} (local backup)`,
        });
      }
    } catch (e) {
      this.output.appendLine(`[sync] backup ${local.meta.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private acknowledgeActivities(index: SyncIndex): void {
    // Clear pending entries whose local content matches what was last synced.
    const log = SyncActivityLog.getInstance(this.context);
    const acked: string[] = [];
    for (const p of log.listPending()) {
      const entry = index.get(p.itemId);
      if (p.action === 'delete') {
        // Acked once the tombstone is pushed (entry removed by recordAccepted)
        // or when the item never reached the cloud (no syncedVersion) — there
        // is nothing left to delete remotely, so the queue entry is obsolete.
        if (!entry || entry.syncedVersion == null) {
          acked.push(`${p.kind}:${p.itemId}`);
        }
      } else if (!entry) {
        // Orphan: the item id is no longer tracked (e.g. its syncId was
        // regenerated). Nothing left to push — drop the stale pending entry so
        // it stops showing as a phantom "Update" forever.
        acked.push(`${p.kind}:${p.itemId}`);
      } else if (entry.syncedHash && entry.syncedHash === entry.lastObservedHash) {
        acked.push(`${p.kind}:${p.itemId}`);
      }
    }
    if (acked.length) {
      log.acknowledge(acked);
    }
  }

  // ── Clear & re-sync (git-style hard reset) ────────────────────────────────────

  /** Wipe local synced state and pull everything fresh from the cloud. */
  async replaceLocalWithCloud(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId) {
      return false;
    }
    const release = await this.mutex.acquire();
    try {
      this.setStatus('syncing');
      const index = new SyncIndex(this.context);
      for (const id of Object.keys(index.getAll())) {
        index.remove(id);
      }
      await index.flush();
      await this.setCursor(config, 0);
      await this.runLocked(config, { direction: 'pull' });
      // Local state was wiped and rebuilt from cloud — any queued outbound
      // changes referenced the old local items and are now meaningless.
      SyncActivityLog.getInstance(this.context).clearPending();
      await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
      this.setStatus('synced');
      return true;
    } catch (e) {
      this.output.appendLine(`[sync] replaceLocalWithCloud failed: ${e instanceof Error ? e.message : String(e)}`);
      this.setStatus('error');
      return false;
    } finally {
      release();
    }
  }

  /** Wipe cloud state and push everything from this device. */
  async replaceCloudWithLocal(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId) {
      return false;
    }
    const release = await this.mutex.acquire();
    try {
      this.setStatus('syncing');
      const provider = this.getProvider(config);
      await provider.resetSpace();
      const index = new SyncIndex(this.context);
      for (const id of Object.keys(index.getAll())) {
        index.update(id, { kind: index.get(id)!.kind, syncedHash: undefined, syncedVersion: undefined });
      }
      await index.flush();
      await this.setCursor(config, 0);
      await this.runLocked(config, { direction: 'push' });
      // Local is now the source of truth — everything was force-pushed, so no
      // outbound change can still be pending. Flush the queue unconditionally.
      SyncActivityLog.getInstance(this.context).clearPending();
      await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
      this.setStatus('synced');
      return true;
    } catch (e) {
      this.output.appendLine(`[sync] replaceCloudWithLocal failed: ${e instanceof Error ? e.message : String(e)}`);
      this.setStatus('error');
      return false;
    } finally {
      release();
    }
  }

  // ── Settings-hub queries ───────────────────────────────────────────────────────

  listPendingActivities() {
    return SyncActivityLog.getInstance(this.context).listPending();
  }

  listInboundHistory(): InboundEntry[] {
    return SyncActivityLog.getInstance(this.context).listInbound();
  }

  listSyncedItems(): SyncedItemView[] {
    const config = this.getConfig();
    const index = new SyncIndex(this.context);
    const excluded = new Set(config.excludedIds ?? []);
    const entries = index.getAll();
    const views: SyncedItemView[] = [];

    const present = new Set<string>();
    if (config.syncConnections) {
      for (const c of vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || []) {
        present.add(String(c.id));
      }
    }
    if (config.syncQueries) {
      for (const q of SavedQueriesService.getInstance().getQueries()) {
        present.add(q.id);
      }
    }

    for (const [id, entry] of Object.entries(entries)) {
      const synced = entry.syncedVersion != null;
      const dirty = entry.lastObservedHash != null && entry.lastObservedHash !== entry.syncedHash;
      views.push({
        id,
        kind: entry.kind,
        name: entry.name,
        updatedAt: entry.modifiedAt ?? entry.syncedAt,
        excluded: excluded.has(id),
        itemStatus: excluded.has(id) ? 'excluded' : dirty ? 'pending' : synced ? 'synced' : 'local',
      });
    }
    return views;
  }

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

  /** Stop syncing an item and delete it from the cloud (and other devices). */
  async removeFromCloud(id: string): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId) {
      return false;
    }
    const release = await this.mutex.acquire();
    try {
      const index = new SyncIndex(this.context);
      const entry = index.get(id);
      if (!entry) {
        return false;
      }
      const provider = this.getProvider(config);
      const result = await provider.pushBatch([
        { op: 'delete', itemId: id, kind: entry.kind, baseVersion: index.baseVersion(id) },
      ]);
      if (result.accepted.length) {
        index.remove(id);
        await index.flush();
        await this.setCursor(config, result.cursor);
        await this.setItemExcluded(id, true);
        return true;
      }
      return false;
    } catch (e) {
      this.output.appendLine(`[sync] removeFromCloud failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      release();
    }
  }

  async rebuildSyncIndex(): Promise<number> {
    const index = new SyncIndex(this.context);
    for (const id of Object.keys(index.getAll())) {
      index.remove(id);
    }
    await index.flush();
    const config = this.getConfig();
    await this.setCursor(config, 0);
    const items = await this.collectLocalItems(config, new Set(config.excludedIds ?? []), index);
    return items.length;
  }

  /**
   * Rebuild local sync metadata from disk, purge orphan queue entries, and
   * force a clean delta re-pull — without wiping local files or cloud data.
   */
  async repair(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId) {
      return false;
    }
    const release = await this.mutex.acquire();
    try {
      this.setStatus('syncing');
      const index = new SyncIndex(this.context);
      for (const id of Object.keys(index.getAll())) {
        index.remove(id);
      }
      await index.flush();
      await this.setCursor(config, 0);
      await this.collectLocalItems(config, new Set(config.excludedIds ?? []), index);
      await index.flush();
      this.purgeOrphanPending(index);
      await this.runLocked(config, { direction: 'pull' });
      await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
      await this.context.globalState.update(SYNC_LAST_ERROR_KEY, undefined);
      this.lastSuccessfulSyncAt = Date.now();
      this.setStatus('synced');
      return true;
    } catch (e) {
      this.output.appendLine(`[sync] repair failed: ${e instanceof Error ? e.message : String(e)}`);
      this.setStatus('error');
      return false;
    } finally {
      release();
    }
  }

  async runDiagnostics(): Promise<void> {
    const config = this.getConfig();
    this.output.show(true);
    this.output.appendLine('── PgStudio Sync diagnostics ──');
    this.output.appendLine(`provider: ${config.providerId ?? 'none'}`);
    this.output.appendLine(`status: ${this.status} | conflicts: ${this.conflictCount}`);
    this.output.appendLine(`cursor: ${this.getCursor(config)}`);
    this.output.appendLine(`lastSyncAt: ${this.getLastSyncAt() ?? 'never'}`);
    this.output.appendLine(`lastError: ${this.getLastError() ?? 'none'}`);
    if (config.providerId) {
      try {
        const test = await this.getProvider(config).testConnection();
        this.output.appendLine(`connection: ${test.ok ? 'ok' : `failed — ${test.error}`}`);
      } catch (e) {
        this.output.appendLine(`connection: error — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ── Cloud-only helpers ──────────────────────────────────────────────────────────

  async getCloudQuota(): Promise<CloudQuotaView | undefined> {
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return undefined;
    }
    return (this.getProvider(config) as CloudSyncProvider).getQuota();
  }

  async listCloudDevices(): Promise<SyncDeviceView[]> {
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return [];
    }
    return (this.getProvider(config) as CloudSyncProvider).listDevices();
  }

  async revokeCloudDevice(deviceId: string): Promise<boolean> {
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return false;
    }
    return (this.getProvider(config) as CloudSyncProvider).revokeDevice(deviceId);
  }

  // ── Sharing support (read item content for workspace sharing) ────────────────────

  async getShareableItem(id: string): Promise<{ kind: 'query' | 'notebook'; raw: Record<string, unknown>; name: string } | undefined> {
    const query = SavedQueriesService.getInstance().getQuery(id);
    if (query) {
      return { kind: 'query', raw: query as unknown as Record<string, unknown>, name: query.title };
    }
    const entry = new SyncIndex(this.context).get(id);
    if (entry?.kind === 'notebook' && entry.filePath && fs.existsSync(entry.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(entry.filePath).toString());
      return {
        kind: 'notebook',
        raw: { name: entry.name ?? id, cells: parsed.cells ?? [], databaseName: parsed.metadata?.databaseName },
        name: entry.name ?? id,
      };
    }
    return undefined;
  }

  async getItemPlaintext(id: string): Promise<string | undefined> {
    const item = await this.getShareableItem(id);
    return item ? JSON.stringify(item.raw, null, 2) : undefined;
  }

  async signOut(): Promise<void> {
    const config = this.getConfig();
    if (config.providerId === 'cloud') {
      await (await import('./AccountService')).AccountService.getInstance(this.context).signOut();
    }
    await this.saveConfig({ ...config, providerId: undefined, paused: false });
    this.stopPeriodicPull();
    this.setStatus('not_configured');
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.stopPeriodicPull();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
