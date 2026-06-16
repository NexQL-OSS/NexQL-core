import * as path from 'path';
import type * as vscode from 'vscode';
import { SYNC_ITEM_INDEX_KEY } from './constants';
import type { SyncItemMeta, SyncKind } from './types';

export interface SyncIndexEntry {
  kind: SyncKind;
  /** Display name (local-only; never uploaded in plaintext). */
  name?: string;
  /** Absolute path of the backing file (notebooks only). */
  filePath?: string;
  /** Revision confirmed by the last successful sync (0 = never synced). */
  syncedRevision: number;
  syncedHash?: string;
  syncedAt?: number;
  /** Last content hash observed during collection. */
  lastObservedHash?: string;
  /** When the content was first observed to differ from the synced state. */
  modifiedAt?: number;
}

export interface ObservedRevision {
  revision: number;
  updatedAt: number;
}

/**
 * Pure revision decision: stable identity across sync runs.
 * - Unchanged since last sync → reuse synced revision/timestamp.
 * - Changed → synced revision + 1 (idempotent until the next successful sync).
 */
export function decideRevision(
  entry: SyncIndexEntry | undefined,
  currentHash: string,
  fallbackRevision: number | undefined,
  now: number,
): ObservedRevision {
  if (!entry || entry.syncedRevision === 0) {
    return { revision: Math.max(1, fallbackRevision ?? 1), updatedAt: entry?.modifiedAt ?? now };
  }
  if (currentHash === entry.syncedHash) {
    return { revision: entry.syncedRevision, updatedAt: entry.syncedAt ?? now };
  }
  const modifiedAt = currentHash === entry.lastObservedHash ? (entry.modifiedAt ?? now) : now;
  return { revision: entry.syncedRevision + 1, updatedAt: modifiedAt };
}

/**
 * Local item index keyed by sync id. Tracks file locations, display names and
 * per-item revisions so identity stays stable across devices and sync runs.
 * Kept in globalState; mutate via observe/update/markSynced then flush().
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

  findByPath(filePath: string): { id: string; entry: SyncIndexEntry } | undefined {
    const target = path.resolve(filePath);
    for (const [id, entry] of Object.entries(this.entries)) {
      if (entry.filePath && path.resolve(entry.filePath) === target) {
        return { id, entry };
      }
    }
    return undefined;
  }

  /**
   * Record an observation of a local item and return the revision/updatedAt
   * to advertise in its sync meta.
   */
  observe(
    id: string,
    kind: SyncKind,
    currentHash: string,
    opts: { name?: string; filePath?: string; fallbackRevision?: number; modifiedAt?: number } = {},
    now = Date.now(),
  ): ObservedRevision {
    const existing = this.entries[id];
    const decision = decideRevision(existing, currentHash, opts.fallbackRevision, opts.modifiedAt ?? now);
    const next: SyncIndexEntry = {
      kind,
      name: opts.name ?? existing?.name,
      filePath: opts.filePath ?? existing?.filePath,
      syncedRevision: existing?.syncedRevision ?? 0,
      syncedHash: existing?.syncedHash,
      syncedAt: existing?.syncedAt,
      lastObservedHash: currentHash,
      modifiedAt: currentHash === existing?.lastObservedHash ? existing?.modifiedAt : (opts.modifiedAt ?? now),
    };
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      this.entries[id] = next;
      this.dirty = true;
    }
    return decision;
  }

  update(id: string, patch: Partial<SyncIndexEntry> & { kind: SyncKind }): void {
    const existing: SyncIndexEntry = this.entries[id] ?? { kind: patch.kind, syncedRevision: 0 };
    this.entries[id] = { ...existing, ...patch };
    this.dirty = true;
  }

  remove(id: string): void {
    if (this.entries[id]) {
      delete this.entries[id];
      this.dirty = true;
    }
  }

  /** Record the outcome of a successful sync run. */
  markSynced(manifest: SyncItemMeta[]): void {
    for (const meta of manifest) {
      if (meta.deleted) {
        this.remove(meta.id);
        continue;
      }
      const existing: SyncIndexEntry = this.entries[meta.id] ?? { kind: meta.kind, syncedRevision: 0 };
      this.entries[meta.id] = {
        ...existing,
        syncedRevision: meta.revision,
        syncedHash: meta.contentHash,
        syncedAt: meta.updatedAt,
        lastObservedHash: meta.contentHash,
      };
      this.dirty = true;
    }
  }

  async flush(): Promise<void> {
    if (this.dirty) {
      await this.context.globalState.update(SYNC_ITEM_INDEX_KEY, this.entries);
      this.dirty = false;
    }
  }
}
