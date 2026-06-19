import * as path from 'path';
import type * as vscode from 'vscode';
import { SYNC_ITEM_INDEX_KEY } from './constants';
import type { SyncKind } from './types';

export interface SyncIndexEntry {
  kind: SyncKind;
  /** Home cloud space. Undefined = personal (account) space. */
  spaceId?: string;
  /** Display name (local-only). */
  name?: string;
  /** Absolute path of the backing file (notebooks only). */
  filePath?: string;
  /** Content hash confirmed by the last successful sync. */
  syncedHash?: string;
  /** Server version confirmed by the last successful sync (compare-and-swap base). */
  syncedVersion?: number;
  syncedAt?: number;
  /** Last content hash observed during collection. */
  lastObservedHash?: string;
  /** When the content was first observed to differ from the synced state. */
  modifiedAt?: number;
}

/** What a single observe() call reports back to the disk-mapping services. */
export interface ObservedRevision {
  /** Vestigial; the engine orders by server version + hash. Kept for callers. */
  revision: number;
  /** Local edit time (epoch ms) — used for last-writer-wins resolution. */
  updatedAt: number;
}

/**
 * Local item index keyed by sync id. Tracks file locations, display names and
 * the last-synced content hash + server version, so the git-like engine can
 * tell what is dirty and what compare-and-swap base to push with. Kept in
 * globalState; mutate via observe/update/markSynced/remove then flush().
 */
export class SyncIndex {
  private entries: Record<string, SyncIndexEntry>;
  private dirty = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.entries = { ...this.context.globalState.get<Record<string, SyncIndexEntry>>(SYNC_ITEM_INDEX_KEY, {}) };
  }

  get(id: string): SyncIndexEntry | undefined {
    return this.entries[id];
  }

  getAll(): Record<string, SyncIndexEntry> {
    return { ...this.entries };
  }

  /** True when the item lives in a team workspace (non-personal space). */
  isTeamItem(id: string): boolean {
    const spaceId = this.entries[id]?.spaceId;
    return !!spaceId && spaceId.startsWith('ws_');
  }

  /** Entries whose home space matches (undefined = personal). */
  entriesForSpace(spaceId?: string): Array<[string, SyncIndexEntry]> {
    return Object.entries(this.entries).filter(([, e]) => (e.spaceId ?? undefined) === spaceId);
  }

  findByPath(filePath: string): { id: string; entry: SyncIndexEntry } | undefined {
    const target = path.resolve(filePath);
    for (const [id, entry] of Object.entries(this.entries)) {
      if (entry.filePath && path.resolve(entry.filePath) === target) {
        return { id, entry };
      }
    }
    return undefined;
  }

  /** Server version to push as the compare-and-swap base (0 = never synced). */
  baseVersion(id: string): number {
    return this.entries[id]?.syncedVersion ?? 0;
  }

  /** True when the local content differs from what was last pushed. */
  isDirty(id: string, currentHash: string): boolean {
    const entry = this.entries[id];
    return !entry || entry.syncedHash !== currentHash;
  }

  /** Ids that have been synced at least once (used to detect local deletions). */
  syncedIds(): string[] {
    return Object.entries(this.entries)
      .filter(([, e]) => e.syncedVersion != null)
      .map(([id]) => id);
  }

  /**
   * Record an observation of a local item and return the revision/updatedAt to
   * advertise in its sync meta. `updatedAt` is held stable while content is
   * unchanged and bumped to "now" the first time changed content appears.
   */
  observe(
    id: string,
    kind: SyncKind,
    currentHash: string,
    opts: { name?: string; filePath?: string; fallbackRevision?: number; modifiedAt?: number } = {},
    now = Date.now(),
  ): ObservedRevision {
    const existing = this.entries[id];
    let updatedAt: number;
    if (existing && currentHash === existing.syncedHash) {
      updatedAt = existing.syncedAt ?? now;
    } else if (existing && currentHash === existing.lastObservedHash) {
      updatedAt = existing.modifiedAt ?? opts.modifiedAt ?? now;
    } else {
      updatedAt = opts.modifiedAt ?? now;
    }

    const next: SyncIndexEntry = {
      kind,
      spaceId: existing?.spaceId,
      name: opts.name ?? existing?.name,
      filePath: opts.filePath ?? existing?.filePath,
      syncedHash: existing?.syncedHash,
      syncedVersion: existing?.syncedVersion,
      syncedAt: existing?.syncedAt,
      lastObservedHash: currentHash,
      modifiedAt: updatedAt,
    };
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      this.entries[id] = next;
      this.dirty = true;
    }
    return { revision: existing?.syncedVersion ?? 0, updatedAt };
  }

  update(id: string, patch: Partial<SyncIndexEntry> & { kind: SyncKind }): void {
    const existing: SyncIndexEntry = this.entries[id] ?? { kind: patch.kind };
    this.entries[id] = { ...existing, ...patch };
    this.dirty = true;
  }

  remove(id: string): void {
    if (this.entries[id]) {
      delete this.entries[id];
      this.dirty = true;
    }
  }

  /** Record a successful sync of one item at the given server version. */
  markSynced(id: string, fields: { kind: SyncKind; contentHash: string; version: number; updatedAt?: number; name?: string; filePath?: string; spaceId?: string }): void {
    const existing: SyncIndexEntry = this.entries[id] ?? { kind: fields.kind };
    this.entries[id] = {
      ...existing,
      kind: fields.kind,
      spaceId: fields.spaceId ?? existing.spaceId,
      name: fields.name ?? existing.name,
      filePath: fields.filePath ?? existing.filePath,
      syncedHash: fields.contentHash,
      syncedVersion: fields.version,
      syncedAt: fields.updatedAt ?? Date.now(),
      lastObservedHash: fields.contentHash,
    };
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (this.dirty) {
      await this.context.globalState.update(SYNC_ITEM_INDEX_KEY, this.entries);
      this.dirty = false;
    }
  }
}
