import * as fs from 'fs';
import * as vscode from 'vscode';
import { contentHash } from './envelope';
import { SyncIndex } from './SyncIndex';
import { SyncMutex } from './SyncMutex';
import { PlaintextCodec, type BlobCodec } from './BlobCodec';
import { decideIncoming, shouldBackupBeforeDelete } from './SyncEngineV2';
import { ConnectionSyncService } from './ConnectionSyncService';
import { NotebookSyncService } from './NotebookSyncService';
import { CloudSyncProvider } from './providers/CloudSyncProvider';
import { PostgresSyncProvider } from './providers/PostgresSyncProvider';
import { WorkspaceSharingService } from './WorkspaceSharingService';
import { SyncActivityLog, bindSyncActivityLog, recordSyncActivity } from './SyncActivityLog';
import { sortUpsertsForApply } from './syncApplyOrder';
import { displayNameFromSyncBlob, detailFromSyncBlob } from './syncBlobDisplay';
import { readNotebookSyncId } from './notebookSyncId';
import { parseNotebookFileContent } from './notebookFileParse';
import { getDeviceName, getOrCreateDeviceId, setDeviceName } from './deviceId';
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
  SYNC_WORKSPACE_ROLES_KEY,
  SYNC_DEBOUNCE_MS,
  SYNC_PERIODIC_MS,
  SYNC_OPEN_CHECK_DEBOUNCE_MS,
  SYNC_SPACES_CACHE_TTL_MS,
  SYNC_PEEK_SKIP_AFTER_SYNC_MS,
} from './constants';
import type {
  CloudQuotaView,
  InboundEntry,
  SyncChangeSummary,
  SyncConfig,
  CloudItemView,
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
  SyncKind,
  SyncSpaceContext,
  SyncedItemView,
  WorkspaceRole,
  WorkspaceView,
} from './types';

type LocalItem = { meta: SyncItemMeta; plaintext: Buffer };

export type RemoteChangeHint = 'none' | 'newer' | 'deleted';

export interface OpenCheckOpts {
  kind?: SyncKind;
  label?: string;
  reloadUri?: vscode.Uri;
  onReload?: () => void;
}

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
  private debounceTimer?: NodeJS.Timeout;
  private periodicTimer?: NodeJS.Timeout;
  private readonly openCheckTimers = new Map<string, NodeJS.Timeout>();
  private readonly openCheckOpts = new Map<string, OpenCheckOpts>();
  private readonly dismissedOpenChecks = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private lastErrorNotifiedAt = 0;
  private lastSuccessfulSyncAt = 0;
  private workspaceRoles = new Map<string, WorkspaceRole>();
  private workspaceNames = new Map<string, string>();
  private spacesCache: { expiresAt: number; spaces: SyncSpaceContext[] } | null = null;

  private readonly _onDidCompleteSync = new vscode.EventEmitter<void>();
  readonly onDidCompleteSync = this._onDidCompleteSync.event;

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
    this.loadPersistedWorkspaceRoles();
    const lastSyncAt = this.context.globalState.get<number>(SYNC_LAST_SYNC_AT_KEY);
    if (lastSyncAt) {
      this.lastSuccessfulSyncAt = lastSyncAt;
    }
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
      vscode.workspace.onDidOpenNotebookDocument((doc) => {
        if (doc.notebookType !== 'postgres-notebook' && doc.notebookType !== 'postgres-query') {
          return;
        }
        const itemId = this.resolveNotebookSyncId(doc);
        if (itemId) {
          this.scheduleOpenCheck(itemId, { kind: 'notebook', reloadUri: doc.uri });
        }
      }),
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
    this.status = config.providerId ? (config.paused ? 'paused' : 'idle') : 'not_configured';
    if (config.providerId && !config.paused && this.isAutoSyncEnabled()) {
      this.startPeriodicPull();
    } else {
      this.stopPeriodicPull();
    }
    this.updateStatusBar();
  }

  private cursorKey(providerId: SyncProviderId, spaceId?: string): string {
    return `${providerId}:${spaceId ?? 'personal'}`;
  }

  private getCursorForSpace(providerId: SyncProviderId, spaceId?: string): number {
    const all = this.context.globalState.get<Record<string, number>>(SYNC_CURSOR_KEY, {});
    return all[this.cursorKey(providerId, spaceId)] ?? 0;
  }

  private async setCursorForSpace(providerId: SyncProviderId, spaceId: string | undefined, cursor: number): Promise<void> {
    const all = { ...this.context.globalState.get<Record<string, number>>(SYNC_CURSOR_KEY, {}) };
    all[this.cursorKey(providerId, spaceId)] = cursor;
    await this.context.globalState.update(SYNC_CURSOR_KEY, all);
  }

  /** @deprecated Use getCursorForSpace — kept for diagnostics on personal space. */
  private getCursor(config: SyncConfig): number {
    return this.getCursorForSpace(config.providerId!, undefined);
  }

  /** @deprecated Use setCursorForSpace — resets personal-space cursor only. */
  private async setCursor(config: SyncConfig, cursor: number): Promise<void> {
    await this.setCursorForSpace(config.providerId!, undefined, cursor);
  }

  private async resetAllCursors(config: SyncConfig): Promise<void> {
    const spaces = await this.resolveSyncSpaces(config);
    for (const space of spaces) {
      await this.setCursorForSpace(config.providerId!, space.spaceId, 0);
    }
  }

  async resolveSyncSpaces(config: SyncConfig): Promise<SyncSpaceContext[]> {
    const personalOnly: SyncSpaceContext[] = [{ spaceId: undefined, name: 'Personal', role: 'owner' }];
    if (config.providerId !== 'cloud' || !isProFeatureEnabled(ProFeature.SyncSharing)) {
      return personalOnly;
    }
    if (this.spacesCache && Date.now() < this.spacesCache.expiresAt) {
      return this.spacesCache.spaces;
    }
    try {
      const service = new WorkspaceSharingService(this.context);
      const workspaces = await service.listWorkspaces();
      const spaces = this.applyWorkspaceRoster(workspaces);
      this.spacesCache = { expiresAt: Date.now() + SYNC_SPACES_CACHE_TTL_MS, spaces };
      return spaces;
    } catch (e) {
      this.output.appendLine(`[sync] list workspaces failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return personalOnly;
  }

  invalidateSpacesCache(): void {
    this.spacesCache = null;
  }

  private loadPersistedWorkspaceRoles(): void {
    const persisted = this.context.globalState.get<{
      roles: Record<string, WorkspaceRole>;
      names: Record<string, string>;
    }>(SYNC_WORKSPACE_ROLES_KEY);
    if (!persisted) {
      return;
    }
    for (const [id, role] of Object.entries(persisted.roles)) {
      this.workspaceRoles.set(id, role);
    }
    for (const [id, name] of Object.entries(persisted.names)) {
      this.workspaceNames.set(id, name);
    }
  }

  private async persistWorkspaceRoles(): Promise<void> {
    const roles: Record<string, WorkspaceRole> = {};
    const names: Record<string, string> = {};
    for (const [id, role] of this.workspaceRoles) {
      roles[id] = role;
    }
    for (const [id, name] of this.workspaceNames) {
      names[id] = name;
    }
    await this.context.globalState.update(SYNC_WORKSPACE_ROLES_KEY, { roles, names, savedAt: Date.now() });
  }

  private applyWorkspaceRoster(workspaces: WorkspaceView[]): SyncSpaceContext[] {
    const spaces: SyncSpaceContext[] = [{ spaceId: undefined, name: 'Personal', role: 'owner' }];
    this.workspaceRoles.clear();
    this.workspaceNames.clear();
    for (const w of workspaces) {
      this.workspaceRoles.set(w.spaceId, w.role);
      this.workspaceNames.set(w.spaceId, w.name);
      spaces.push({ spaceId: w.spaceId, name: w.name, role: w.role });
    }
    void this.persistWorkspaceRoles();
    return spaces;
  }

  getRoleForSpace(spaceId?: string): WorkspaceRole | undefined {
    if (!spaceId) {
      return 'owner';
    }
    return this.workspaceRoles.get(spaceId);
  }

  getWorkspaceName(spaceId: string): string | undefined {
    return this.workspaceNames.get(spaceId);
  }

  isItemReadOnly(id: string, index: SyncIndex = new SyncIndex(this.context)): boolean {
    const entry = index.get(id);
    if (!entry?.spaceId) {
      return false;
    }
    return this.getRoleForSpace(entry.spaceId) === 'viewer';
  }

  listTeamItems(): Array<{ id: string; entry: import('./SyncIndex').SyncIndexEntry }> {
    const index = new SyncIndex(this.context);
    return Object.entries(index.getAll())
      .filter(([, e]) => !!e.spaceId && e.spaceId.startsWith('ws_'))
      .map(([id, entry]) => ({ id, entry }));
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

  private getProvider(config: SyncConfig, spaceId?: string): SyncProviderV2 {
    return this.createProvider(config.providerId!, spaceId);
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

  // ── Pull-on-open ──────────────────────────────────────────────────────────────

  scheduleOpenCheck(itemId: string, opts: OpenCheckOpts = {}): void {
    if (!this.canRunOpenCheck()) {
      return;
    }
    if (this.dismissedOpenChecks.has(itemId)) {
      return;
    }

    const merged: OpenCheckOpts = { ...this.openCheckOpts.get(itemId), ...opts };
    this.openCheckOpts.set(itemId, merged);

    const existing = this.openCheckTimers.get(itemId);
    if (existing) {
      clearTimeout(existing);
    }

    this.openCheckTimers.set(
      itemId,
      setTimeout(() => {
        this.openCheckTimers.delete(itemId);
        const pending = this.openCheckOpts.get(itemId) ?? opts;
        void this.runOpenCheck(itemId, pending).catch(() => undefined);
      }, SYNC_OPEN_CHECK_DEBOUNCE_MS),
    );
  }

  async peekRemoteChanges(itemId: string): Promise<RemoteChangeHint> {
    if (!this.canRunOpenCheck()) {
      return 'none';
    }
    if (
      this.lastSuccessfulSyncAt > 0
      && Date.now() - this.lastSuccessfulSyncAt < SYNC_PEEK_SKIP_AFTER_SYNC_MS
    ) {
      return 'none';
    }

    const index = new SyncIndex(this.context);
    const entry = index.get(itemId);
    if (!entry || entry.syncedVersion == null) {
      return 'none';
    }
    if (
      entry.syncedHash != null
      && entry.lastObservedHash != null
      && entry.syncedHash !== entry.lastObservedHash
    ) {
      return 'none';
    }
    if (this.status === 'syncing') {
      return 'none';
    }

    const release = await this.mutex.acquire();
    try {
      const config = this.getConfig();
      const spaceId = entry.spaceId;
      const provider = this.getProvider(config, spaceId);
      const delta = await provider.pullDelta(this.getCursorForSpace(config.providerId!, spaceId));

      if (delta.deletes.includes(itemId)) {
        return 'deleted';
      }

      const upsert = delta.upserts.find((u) => u.meta.id === itemId);
      if (upsert && upsert.meta.version > entry.syncedVersion) {
        return 'newer';
      }
      return 'none';
    } catch {
      return 'none';
    } finally {
      release();
    }
  }

  async confirmPullAndReload(opts: OpenCheckOpts = {}): Promise<void> {
    const result = await this.pullOnly();
    if (result === undefined) {
      void vscode.window.showWarningMessage('Sync pull failed. Try syncing from settings or use Repair sync.');
      return;
    }
    await this.reloadAfterPull(opts);
  }

  private canRunOpenCheck(): boolean {
    const config = this.getConfig();
    if (!config.providerId || config.paused || !this.isAutoSyncEnabled()) {
      return false;
    }
    if (!isProFeatureEnabled(ProFeature.CloudSync)) {
      return false;
    }
    return isSyncProviderAllowed(config.providerId);
  }

  private resolveNotebookSyncId(doc: vscode.NotebookDocument): string | undefined {
    const fromMeta = readNotebookSyncId(doc.metadata as Record<string, unknown>);
    if (fromMeta) {
      return fromMeta;
    }
    if (doc.uri.scheme === 'file') {
      return new SyncIndex(this.context).findByPath(doc.uri.fsPath)?.id;
    }
    return undefined;
  }

  private async runOpenCheck(itemId: string, opts: OpenCheckOpts): Promise<void> {
    const change = await this.peekRemoteChanges(itemId);
    if (change === 'none') {
      return;
    }

    const label = opts.label ?? itemId;
    const message = change === 'deleted'
      ? `Remote copy of "${label}" was deleted. Pull changes?`
      : `Remote changes available for "${label}" — pull latest?`;

    const choice = await vscode.window.showInformationMessage(message, 'Pull');
    if (choice !== 'Pull') {
      return;
    }

    await this.confirmPullAndReload(opts);
  }

  private async reloadAfterPull(opts: OpenCheckOpts): Promise<void> {
    if (opts.onReload) {
      opts.onReload();
      return;
    }

    const uri = opts.reloadUri;
    if (!uri || uri.scheme !== 'file') {
      return;
    }

    const open = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!open) {
      return;
    }

    if (!open.isDirty) {
      await vscode.commands.executeCommand('workbench.action.revert');
      return;
    }

    const reload = 'Reload';
    const choice = await vscode.window.showInformationMessage(
      'Remote changes were pulled. Reload the notebook to see them?',
      reload,
    );
    if (choice !== reload) {
      return;
    }

    const doc = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(doc, { preserveFocus: true });
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
      this._onDidCompleteSync.fire();
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

  /** The atomic heart: pull → apply → push per space (with one pull/re-push on conflict). */
  private async runLocked(config: SyncConfig, options: SyncRunOptions): Promise<SyncRunResult> {
    const spaces = await this.resolveSyncSpaces(config);
    const index = new SyncIndex(this.context);
    const excluded = new Set([...(config.excludedIds ?? []), ...(options.transientExcludedIds ?? [])]);
    let pulled = 0;
    let pushed = 0;
    let conflicts = 0;

    for (const space of spaces) {
      const partial = await this.runLockedForSpace(config, space, index, excluded, options);
      pulled += partial.pulled;
      pushed += partial.pushed;
      conflicts += partial.conflicts;
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

  private async runLockedForSpace(
    config: SyncConfig,
    space: SyncSpaceContext,
    index: SyncIndex,
    excluded: ReadonlySet<string>,
    options: SyncRunOptions,
  ): Promise<Pick<SyncRunResult, 'pulled' | 'pushed' | 'conflicts'>> {
    const provider = this.getProvider(config, space.spaceId);
    const direction = options.direction ?? 'both';
    let cursor = this.getCursorForSpace(config.providerId!, space.spaceId);
    let pulled = 0;
    let pushed = 0;
    let conflicts = 0;

    if (direction !== 'push') {
      const delta = await provider.pullDelta(cursor);
      pulled = await this.applyDelta(delta, config, space, index, excluded, options);
      cursor = delta.cursor;
      await this.commitPhase(config.providerId!, space.spaceId, index, cursor);
    }

    if (direction !== 'pull' && space.role !== 'viewer') {
      const ops = await this.buildOps(config, space, index, excluded);
      if (ops.length) {
        const result = await provider.pushBatch(ops);
        this.recordAccepted(result.accepted, ops, index, space.spaceId);
        pushed = result.accepted.length;
        cursor = result.cursor;
        await this.commitPhase(config.providerId!, space.spaceId, index, cursor);

        if (result.rejected.length) {
          const delta2 = await provider.pullDelta(cursor);
          pulled += await this.applyDelta(delta2, config, space, index, excluded);
          cursor = delta2.cursor;
          await this.commitPhase(config.providerId!, space.spaceId, index, cursor);

          const ops2 = await this.buildOps(config, space, index, excluded);
          if (ops2.length) {
            const retry = await provider.pushBatch(ops2);
            this.recordAccepted(retry.accepted, ops2, index, space.spaceId);
            pushed += retry.accepted.length;
            cursor = retry.cursor;
            await this.commitPhase(config.providerId!, space.spaceId, index, cursor);
            conflicts = retry.rejected.length;
          }
        }
      }
    }

    return { pulled, pushed, conflicts };
  }

  private async preview(config: SyncConfig, transientExcludedIds?: string[]): Promise<SyncPreviewResult> {
    const index = new SyncIndex(this.context);
    const excluded = new Set([...(config.excludedIds ?? []), ...(transientExcludedIds ?? [])]);
    const spaces = await this.resolveSyncSpaces(config);
    const incoming: SyncPreviewItem[] = [];
    const outgoing: SyncPreviewItem[] = [];

    for (const space of spaces) {
      const provider = this.getProvider(config, space.spaceId);
      const delta = await provider.pullDelta(this.getCursorForSpace(config.providerId!, space.spaceId));
      const localItems = await this.collectLocalItems(config, space, excluded, index);
      const localById = new Map(localItems.map((i) => [i.meta.id, i]));

      incoming.push(
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
      );

      if (space.role !== 'viewer') {
        const ops = await this.buildOps(config, space, index, excluded);
        outgoing.push(
          ...ops.map((op) => ({
            id: op.itemId,
            kind: op.kind,
            name: index.get(op.itemId)?.name,
            changeType: (op.op === 'delete' ? 'delete' : (index.baseVersion(op.itemId) ? 'update' : 'create')) as 'delete' | 'update' | 'create',
          })),
        );
      }
    }

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

  private belongsToSpace(index: SyncIndex, id: string, spaceId?: string): boolean {
    return (index.get(id)?.spaceId ?? undefined) === spaceId;
  }

  private async collectLocalItems(
    config: SyncConfig,
    space: SyncSpaceContext,
    excluded: ReadonlySet<string>,
    index: SyncIndex,
  ): Promise<LocalItem[]> {
    const deviceId = getOrCreateDeviceId(this.context);
    const items: LocalItem[] = [];

    if (config.syncConnections && space.spaceId === undefined) {
      items.push(...new ConnectionSyncService(this.context, index).collectLocalConnections(deviceId));
    }
    if (config.syncQueries) {
      for (const q of SavedQueriesService.getInstance().getQueries()) {
        if (!this.belongsToSpace(index, q.id, space.spaceId)) {
          continue;
        }
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
      const notebooks = await new NotebookSyncService(this.context, index).collectLocalNotebooks(deviceId);
      items.push(...notebooks.filter((i) => this.belongsToSpace(index, i.meta.id, space.spaceId)));
    }
    return items.filter((i) => !excluded.has(i.meta.id));
  }

  /** Upserts for dirty local items + deletes for items removed since last sync. */
  private async buildOps(
    config: SyncConfig,
    space: SyncSpaceContext,
    index: SyncIndex,
    excluded: ReadonlySet<string>,
  ): Promise<SyncOp[]> {
    const localItems = await this.collectLocalItems(config, space, excluded, index);
    const presentIds = new Set(localItems.map((i) => i.meta.id));
    const ops: SyncOp[] = [];

    for (const { meta, plaintext } of localItems) {
      if (this.isItemReadOnly(meta.id, index)) {
        continue;
      }
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

    const kindEnabled = (k: string) =>
      (k === 'connection' && config.syncConnections) ||
      (k === 'query' && config.syncQueries) ||
      (k === 'notebook' && config.syncNotebooks);
    for (const id of index.syncedIds()) {
      const entry = index.get(id);
      if (!entry || (entry.spaceId ?? undefined) !== space.spaceId) {
        continue;
      }
      if (excluded.has(id) || presentIds.has(id) || !kindEnabled(entry.kind) || this.isItemReadOnly(id, index)) {
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
    spaceId?: string,
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
        index.markSynced(itemId, { kind: op.kind, contentHash: op.contentHash!, version, spaceId });
      }
    }
  }

  // ── Apply incoming delta ───────────────────────────────────────────────────────

  private async applyDelta(
    delta: SyncDelta,
    config: SyncConfig,
    space: SyncSpaceContext,
    index: SyncIndex,
    excluded: ReadonlySet<string>,
    options: SyncRunOptions = {},
  ): Promise<number> {
    const connSvc = new ConnectionSyncService(this.context, index);
    const nbSvc = new NotebookSyncService(this.context, index);
    const sqSvc = SavedQueriesService.getInstance();
    const localItems = await this.collectLocalItems(config, space, excluded, index);
    const localById = new Map(localItems.map((i) => [i.meta.id, i]));
    const skipExcluded = options.forceRemote === true;
    let applied = 0;

    // Permanent deletes — never resurrected.
    for (const id of delta.deletes) {
      if (!skipExcluded && excluded.has(id)) {
        continue;
      }
      const kind = index.get(id)?.kind ?? localById.get(id)?.meta.kind;
      const local = localById.get(id);
      if (
        local
        && shouldBackupBeforeDelete(true, index.isDirty(id, local.meta.contentHash))
      ) {
        this.backupLocal(local, kind ?? local.meta.kind);
      }
      const metaStub: SyncItemMeta = { id, kind: kind ?? 'query', contentHash: '', revision: 0, updatedAt: 0, deviceId: '', deleted: true };
      try {
        if (kind === 'connection' && config.syncConnections) {
          await connSvc.removeConnection(metaStub);
        } else if (kind === 'notebook' && config.syncNotebooks) {
          await nbSvc.deleteNotebook(metaStub);
        } else if (kind === 'query' && config.syncQueries) {
          await sqSvc.deleteQuery(id, { fromRemote: true });
        }
      } catch (e) {
        this.output.appendLine(`[sync] delete ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      index.remove(id);
      applied += 1;
    }

    // Upserts — last-writer-wins, loser backed up locally. Connections before notebooks.
    for (const { meta, blob } of sortUpsertsForApply(delta.upserts)) {
      if (!skipExcluded && excluded.has(meta.id)) {
        continue;
      }
      const local = localById.get(meta.id);
      const decision = options.forceRemote
        ? { applyRemote: true, backupLocal: false }
        : decideIncoming(
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
        spaceId: space.spaceId,
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
  private async commitPhase(
    providerId: SyncProviderId,
    spaceId: string | undefined,
    index: SyncIndex,
    cursor: number,
  ): Promise<void> {
    await index.flush();
    await this.setCursorForSpace(providerId, spaceId, cursor);
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

  /** Wipe local copies of sync-enabled item kinds before a cloud-authoritative pull. */
  private async wipeLocalSyncData(config: SyncConfig): Promise<void> {
    const index = new SyncIndex(this.context);
    const nbSvc = new NotebookSyncService(this.context, index);

    if (config.syncNotebooks) {
      const localNotebooks = await nbSvc.collectLocalNotebooks('wipe');
      for (const { meta } of localNotebooks) {
        await nbSvc.deleteNotebook(meta);
      }
    }

    if (config.syncQueries) {
      const sqSvc = SavedQueriesService.getInstance();
      for (const query of [...sqSvc.getQueries()]) {
        await sqSvc.deleteQuery(query.id, { fromRemote: true });
      }
    }

    if (config.syncConnections) {
      const wsConfig = vscode.workspace.getConfiguration();
      await wsConfig.update('postgresExplorer.connections', [], vscode.ConfigurationTarget.Global);
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
      await this.wipeLocalSyncData(config);
      const index = new SyncIndex(this.context);
      for (const id of Object.keys(index.getAll())) {
        index.remove(id);
      }
      await index.flush();
      await this.resetAllCursors(config);
      await this.runLocked(config, { direction: 'pull', forceRemote: true });
      SyncActivityLog.getInstance(this.context).clearPending();
      await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
      this.setStatus('synced');
      this._onDidCompleteSync.fire();
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
      const spaces = await this.resolveSyncSpaces(config);
      for (const space of spaces) {
        const provider = this.getProvider(config, space.spaceId);
        await provider.resetSpace();
      }
      const index = new SyncIndex(this.context);
      for (const id of Object.keys(index.getAll())) {
        index.update(id, { kind: index.get(id)!.kind, syncedHash: undefined, syncedVersion: undefined });
      }
      await index.flush();
      await this.resetAllCursors(config);
      await this.runLocked(config, { direction: 'push', forceRemote: false });
      SyncActivityLog.getInstance(this.context).clearPending();
      await this.context.globalState.update(SYNC_LAST_SYNC_AT_KEY, Date.now());
      this.setStatus('synced');
      this._onDidCompleteSync.fire();
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
      const spaceId = entry.spaceId;
      views.push({
        id,
        kind: entry.kind,
        name: entry.name,
        updatedAt: entry.modifiedAt ?? entry.syncedAt,
        excluded: excluded.has(id),
        itemStatus: excluded.has(id) ? 'excluded' : dirty ? 'pending' : synced ? 'synced' : 'local',
        spaceId,
        workspaceName: spaceId ? this.getWorkspaceName(spaceId) : undefined,
        role: spaceId ? this.getRoleForSpace(spaceId) : 'owner',
      });
    }
    return views;
  }

  /** Ids of sync items that exist on this device (ignores excluded flag). */
  async getPresentOnDeviceIds(): Promise<Set<string>> {
    const config = this.getConfig();
    const index = new SyncIndex(this.context);
    const items = await this.collectLocalItems(
      config,
      { spaceId: undefined, name: 'Personal', role: 'owner' },
      new Set(),
      index,
    );
    return new Set(items.map((i) => i.meta.id));
  }

  async isPresentOnDevice(itemId: string): Promise<boolean> {
    const present = await this.getPresentOnDeviceIds();
    return present.has(itemId);
  }

  /** Local tab: items on this device plus cloud-only entries. */
  async listLocalTabItems(): Promise<SyncedItemView[]> {
    const presentIds = await this.getPresentOnDeviceIds();
    const onDevice = this.listSyncedItems()
      .filter((item) => presentIds.has(item.id))
      .map((item) => ({
        ...item,
        presence: 'local' as const,
      }));
    const onDeviceIds = new Set(onDevice.map((item) => item.id));
    const cloud = await this.listCloudItems();
    const cloudOnly: SyncedItemView[] = cloud
      .filter((item) => !presentIds.has(item.id))
      .filter((item) => !onDeviceIds.has(item.id))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        detail: item.detail,
        updatedAt: item.updatedAt,
        excluded: false,
        itemStatus: 'local' as const,
        presence: 'cloud-only' as const,
        spaceId: item.spaceId,
        workspaceName: item.workspaceName,
        role: 'owner' as const,
      }));
    return [...onDevice, ...cloudOnly].sort(
      (a, b) => (a.presence === 'cloud-only' ? 1 : 0) - (b.presence === 'cloud-only' ? 1 : 0)
        || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
    );
  }

  /** Snapshot of items stored in the cloud (personal space), with local comparison. */
  async listCloudItems(): Promise<CloudItemView[]> {
    const config = this.getConfig();
    if (!config.providerId) {
      return [];
    }
    const index = new SyncIndex(this.context);
    const excluded = new Set(config.excludedIds ?? []);
    const localItems = await this.collectLocalItems(
      config,
      { spaceId: undefined, name: 'Personal', role: 'owner' },
      new Set(),
      index,
    );
    const localById = new Map(localItems.map((i) => [i.meta.id, i]));
    const views: CloudItemView[] = [];

    try {
      const provider = this.getProvider(config, undefined);
      const delta = await provider.pullDelta(0);
      const deleted = new Set(delta.deletes);
      for (const { meta, blob } of delta.upserts) {
        if (deleted.has(meta.id)) {
          continue;
        }
        const plaintext = this.codec.decode(blob);
        const local = localById.get(meta.id);
        const onDevice = !!local;
        let localStatus: CloudItemView['localStatus'];
        if (!onDevice) {
          localStatus = 'absent';
        } else if (excluded.has(meta.id)) {
          localStatus = 'excluded';
        } else if (local!.meta.contentHash === meta.contentHash) {
          localStatus = 'synced';
        } else {
          localStatus = 'different';
        }
        views.push({
          id: meta.id,
          kind: meta.kind,
          name: displayNameFromSyncBlob(meta.kind, plaintext),
          detail: detailFromSyncBlob(meta.kind, plaintext),
          updatedAt: meta.updatedAt,
          localStatus,
        });
      }
    } catch (e) {
      this.output.appendLine(`[sync] listCloudItems failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    views.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
    return views;
  }

  /** Pull and apply a single cloud item onto this device. */
  async importCloudItem(itemId: string): Promise<boolean> {
    const config = this.getConfig();
    if (!config.providerId || !itemId) {
      return false;
    }
    const release = await this.mutex.acquire();
    try {
      this.setStatus('syncing');
      const provider = this.getProvider(config, undefined);
      const delta = await provider.pullDelta(0);
      const match = [...delta.upserts].reverse().find((u) => u.meta.id === itemId);
      if (!match || delta.deletes.includes(itemId)) {
        return false;
      }
      const index = new SyncIndex(this.context);
      const connSvc = new ConnectionSyncService(this.context, index);
      const nbSvc = new NotebookSyncService(this.context, index);
      const sqSvc = SavedQueriesService.getInstance();
      const plaintext = this.codec.decode(match.blob);
      await this.applyOne(match.meta, plaintext, config, connSvc, nbSvc, sqSvc);
      await this.setItemExcluded(itemId, false);
      index.markSynced(match.meta.id, {
        kind: match.meta.kind,
        contentHash: match.meta.contentHash,
        version: match.meta.version,
        updatedAt: match.meta.updatedAt,
      });
      await index.flush();
      this._onDidCompleteSync.fire();
      this.setStatus('synced');
      return true;
    } catch (e) {
      this.output.appendLine(`[sync] importCloudItem ${itemId} failed: ${e instanceof Error ? e.message : String(e)}`);
      this.setStatus('error');
      return false;
    } finally {
      release();
    }
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
      const provider = this.getProvider(config, entry.spaceId);
      const result = await provider.pushBatch([
        { op: 'delete', itemId: id, kind: entry.kind, baseVersion: index.baseVersion(id) },
      ]);
      if (result.accepted.length) {
        index.remove(id);
        await index.flush();
        await this.setCursorForSpace(config.providerId!, entry.spaceId, result.cursor);
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
    await this.resetAllCursors(config);
    const personal: SyncSpaceContext = { spaceId: undefined, name: 'Personal', role: 'owner' };
    const items = await this.collectLocalItems(config, personal, new Set(config.excludedIds ?? []), index);
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
      await this.resetAllCursors(config);
      const personal: SyncSpaceContext = { spaceId: undefined, name: 'Personal', role: 'owner' };
      await this.collectLocalItems(config, personal, new Set(config.excludedIds ?? []), index);
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

  getThisDeviceInfo(): { deviceId: string; deviceName: string } {
    return {
      deviceId: getOrCreateDeviceId(this.context),
      deviceName: getDeviceName(this.context) ?? '',
    };
  }

  /** Persist a friendly device label locally and on NexQL Cloud when configured. */
  async renameThisDevice(deviceName: string): Promise<boolean> {
    const trimmed = deviceName.trim();
    if (!trimmed) {
      return false;
    }
    await setDeviceName(this.context, trimmed);
    return this.pushDeviceNameToCloud(trimmed);
  }

  /** Push the current device label to NexQL Cloud (no-op when sync is not on cloud). */
  async pushDeviceNameToCloud(deviceName: string): Promise<boolean> {
    const trimmed = deviceName.trim();
    if (!trimmed) {
      return false;
    }
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return true;
    }
    try {
      const deviceId = getOrCreateDeviceId(this.context);
      return await (this.getProvider(config) as CloudSyncProvider).updateDeviceName(deviceId, trimmed);
    } catch {
      return false;
    }
  }

  // ── Sharing support (read item content for workspace sharing) ────────────────────

  async getShareableItem(id: string): Promise<{ kind: 'query' | 'notebook'; raw: Record<string, unknown>; name: string } | undefined> {
    const query = SavedQueriesService.getInstance().getQuery(id);
    if (query) {
      return { kind: 'query', raw: query as unknown as Record<string, unknown>, name: query.title };
    }
    const entry = new SyncIndex(this.context).get(id);
    if (entry?.kind === 'notebook' && entry.filePath && fs.existsSync(entry.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(entry.filePath).toString()) as Record<string, unknown>;
      const { cells, databaseName } = parseNotebookFileContent(parsed);
      return {
        kind: 'notebook',
        raw: { name: entry.name ?? id, cells, databaseName },
        name: entry.name ?? id,
      };
    }
    return undefined;
  }

  async getItemPlaintext(id: string): Promise<string | undefined> {
    const item = await this.getShareableItem(id);
    return item ? JSON.stringify(item.raw, null, 2) : undefined;
  }

  /** Push a scrubbed item into a team workspace space (used by share-with-team). */
  async pushItemToTeamSpace(
    itemId: string,
    targetSpaceId: string,
    kind: SyncKind,
    plaintext: Buffer,
    opts: { removeFromPersonal?: boolean } = {},
  ): Promise<boolean> {
    const config = this.getConfig();
    if (config.providerId !== 'cloud') {
      return false;
    }
    const index = new SyncIndex(this.context);
    const entry = index.get(itemId);
    const hash = contentHash(plaintext);

    if (opts.removeFromPersonal && entry && !entry.spaceId && entry.syncedVersion != null) {
      const personal = this.getProvider(config, undefined);
      const del = await personal.pushBatch([
        { op: 'delete', itemId, kind: entry.kind, baseVersion: index.baseVersion(itemId) },
      ]);
      if (del.accepted.length) {
        await this.setCursorForSpace(config.providerId!, undefined, del.cursor);
      }
    }

    const team = this.getProvider(config, targetSpaceId);
    const baseVersion = entry?.spaceId === targetSpaceId ? index.baseVersion(itemId) : 0;
    const result = await team.pushBatch([
      {
        op: 'upsert',
        itemId,
        kind,
        baseVersion,
        contentHash: hash,
        blob: this.codec.encode(plaintext),
      },
    ]);
    if (!result.accepted.length) {
      return false;
    }
    const version = result.accepted.find((a) => a.itemId === itemId)?.version ?? result.accepted[0].version;
    index.update(itemId, { kind, spaceId: targetSpaceId });
    index.markSynced(itemId, { kind, contentHash: hash, version, spaceId: targetSpaceId });
    await index.flush();
    await this.setCursorForSpace(config.providerId!, targetSpaceId, result.cursor);
    return true;
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
    for (const timer of this.openCheckTimers.values()) {
      clearTimeout(timer);
    }
    this.openCheckTimers.clear();
    this.openCheckOpts.clear();
    this._onDidCompleteSync.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
