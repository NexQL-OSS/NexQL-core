import type { MergeConflict, MergeResult, SyncItemMeta, SyncPushItem } from './types';
import { TOMBSTONE_RETENTION_MS } from './constants';

export interface LocalItem {
  meta: SyncItemMeta;
  plaintext: Buffer;
}

/** Remote item with lazy blob access — blobs are only fetched when applied. */
export interface RemoteItem {
  meta: SyncItemMeta;
  getBlob(): Promise<Buffer | undefined>;
}

function metaKey(m: SyncItemMeta): string {
  return `${m.kind}:${m.id}`;
}

/** Compare revisions: primary comparator revision, tiebreaker updatedAt. */
export function compareRevisions(a: SyncItemMeta, b: SyncItemMeta): number {
  if (a.revision !== b.revision) {
    return a.revision - b.revision;
  }
  return a.updatedAt - b.updatedAt;
}

export function pickWinner(local: SyncItemMeta, remote: SyncItemMeta): 'local' | 'remote' {
  const cmp = compareRevisions(local, remote);
  return cmp >= 0 ? 'local' : 'remote';
}

function isTombstoneExpired(meta: SyncItemMeta, now: number): boolean {
  return meta.deleted && now - meta.updatedAt > TOMBSTONE_RETENTION_MS;
}

function pruneTombstones(manifest: SyncItemMeta[], now: number): SyncItemMeta[] {
  return manifest.filter((m) => !isTombstoneExpired(m, now));
}

/**
 * Three-way merge: base manifest vs local vs remote.
 * Pure logic — no vscode imports. Remote blobs are fetched lazily and only
 * for items that actually need to be applied locally.
 */
export async function mergeSyncState(
  baseManifest: SyncItemMeta[],
  localItems: LocalItem[],
  remoteItems: RemoteItem[],
  deviceId: string,
  decrypt: (blob: Buffer) => Buffer,
  now = Date.now(),
): Promise<MergeResult> {
  const baseByKey = new Map(baseManifest.map((m) => [metaKey(m), m]));
  const localByKey = new Map(localItems.map((i) => [metaKey(i.meta), i]));
  const remoteByKey = new Map(remoteItems.map((i) => [metaKey(i.meta), i]));

  const allKeys = new Set<string>([
    ...baseByKey.keys(),
    ...localByKey.keys(),
    ...remoteByKey.keys(),
  ]);

  const toPush: SyncPushItem[] = [];
  const toApply: Array<{ meta: SyncItemMeta; plaintext: Buffer }> = [];
  const conflicts: MergeConflict[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const newBaseEntries: SyncItemMeta[] = [];

  const isFirstSync = baseManifest.length === 0;

  /** Fetch + decrypt a remote blob; tombstones never need content. */
  const remotePlaintext = async (item: RemoteItem): Promise<Buffer | undefined> => {
    if (item.meta.deleted) {
      return Buffer.alloc(0);
    }
    const blob = await item.getBlob();
    return blob ? decrypt(blob) : undefined;
  };

  for (const key of allKeys) {
    const base = baseByKey.get(key);
    let local = localByKey.get(key);
    let remote = remoteByKey.get(key);

    // Expired tombstones are treated as absent — they must not drop a live
    // item on the other side.
    if (local?.meta.deleted && isTombstoneExpired(local.meta, now)) {
      local = undefined;
    }
    if (remote?.meta.deleted && isTombstoneExpired(remote.meta, now)) {
      remote = undefined;
    }

    if (!local && !remote) {
      if (base && !isTombstoneExpired(base, now)) {
        newBaseEntries.push(base);
      }
      continue;
    }

    if (isFirstSync) {
      if (local && remote) {
        if (local.meta.contentHash === remote.meta.contentHash) {
          // Identical content already on both sides (e.g. fresh device whose
          // files carry embedded sync ids). Adopt the higher revision; nothing
          // to transfer.
          newBaseEntries.push(pickWinner(local.meta, remote.meta) === 'local' ? local.meta : remote.meta);
          continue;
        }
        const winner = pickWinner(local.meta, remote.meta);
        const loser = winner === 'local' ? remote : local;
        const loserPlain = winner === 'local' ? await remotePlaintext(remote) : local.plaintext;
        const winnerPlain = winner === 'local' ? local.plaintext : await remotePlaintext(remote);
        if (winnerPlain === undefined || loserPlain === undefined) {
          skipped.push({ id: local.meta.id, reason: 'missing remote blob' });
          continue;
        }
        const conflictName = `${loser.meta.id} (conflict from ${loser.meta.deviceId})`;
        conflicts.push({
          id: loser.meta.id,
          kind: loser.meta.kind,
          localName: conflictName,
          remoteDeviceId: loser.meta.deviceId,
          winner,
          loserCopyName: conflictName,
        });
        const winnerMeta = winner === 'local' ? local.meta : remote.meta;
        if (winner === 'local') {
          toPush.push({ meta: local.meta, blob: Buffer.alloc(0) });
        } else {
          toApply.push({ meta: winnerMeta, plaintext: winnerPlain });
        }
        toApply.push({
          meta: {
            ...loser.meta,
            id: `${loser.meta.id}-conflict-${now}`,
            updatedAt: now,
            deviceId,
          },
          plaintext: loserPlain,
        });
        newBaseEntries.push(winnerMeta);
        continue;
      }
      if (local) {
        toPush.push({ meta: local.meta, blob: Buffer.alloc(0) });
        newBaseEntries.push(local.meta);
      }
      if (remote) {
        const plain = await remotePlaintext(remote);
        if (plain === undefined) {
          skipped.push({ id: remote.meta.id, reason: 'missing remote blob' });
          continue;
        }
        toApply.push({ meta: remote.meta, plaintext: plain });
        newBaseEntries.push(remote.meta);
      }
      continue;
    }

    const localChanged = local
      ? !base || local.meta.contentHash !== base.contentHash || local.meta.revision !== base.revision || local.meta.deleted !== base.deleted
      : false;
    const remoteChanged = remote
      ? !base || remote.meta.revision > (base?.revision ?? 0) || remote.meta.contentHash !== base.contentHash || remote.meta.deleted !== (base?.deleted ?? false)
      : false;

    if (!localChanged && !remoteChanged) {
      if (base) {
        newBaseEntries.push(base);
      } else if (local && remote && local.meta.contentHash === remote.meta.contentHash) {
        newBaseEntries.push(pickWinner(local.meta, remote.meta) === 'local' ? local.meta : remote.meta);
      }
      continue;
    }

    if (localChanged && !remoteChanged) {
      if (local) {
        toPush.push({ meta: local.meta, blob: Buffer.alloc(0) });
        newBaseEntries.push(local.meta);
      }
      continue;
    }

    if (!localChanged && remoteChanged) {
      if (remote) {
        const plain = await remotePlaintext(remote);
        if (plain === undefined) {
          skipped.push({ id: remote.meta.id, reason: 'missing remote blob' });
          if (base) {
            newBaseEntries.push(base);
          }
          continue;
        }
        toApply.push({ meta: remote.meta, plaintext: plain });
        newBaseEntries.push(remote.meta);
      }
      continue;
    }

    // Both changed from here on.
    if (local && remote && local.meta.contentHash === remote.meta.contentHash && local.meta.deleted === remote.meta.deleted) {
      newBaseEntries.push(pickWinner(local.meta, remote.meta) === 'local' ? local.meta : remote.meta);
      continue;
    }

    // Edit-vs-delete: the edit wins; no conflict copy of a tombstone.
    if (local && remote && local.meta.deleted !== remote.meta.deleted) {
      if (local.meta.deleted) {
        const plain = await remotePlaintext(remote);
        if (plain === undefined) {
          skipped.push({ id: remote.meta.id, reason: 'missing remote blob' });
          if (base) {
            newBaseEntries.push(base);
          }
          continue;
        }
        toApply.push({ meta: remote.meta, plaintext: plain });
        newBaseEntries.push(remote.meta);
      } else {
        toPush.push({ meta: local.meta, blob: Buffer.alloc(0) });
        newBaseEntries.push(local.meta);
      }
      continue;
    }

    if (local && remote) {
      const winner = pickWinner(local.meta, remote.meta);
      const remotePlain = await remotePlaintext(remote);
      if (remotePlain === undefined) {
        skipped.push({ id: remote.meta.id, reason: 'missing remote blob' });
        if (base) {
          newBaseEntries.push(base);
        }
        continue;
      }
      const winnerMeta = winner === 'local' ? local.meta : remote.meta;
      const loserMeta = winner === 'local' ? remote.meta : local.meta;
      const loserPlain = winner === 'local' ? remotePlain : local.plaintext;

      conflicts.push({
        id: local.meta.id,
        kind: local.meta.kind,
        localName: local.meta.id,
        remoteDeviceId: remote.meta.deviceId,
        winner,
        loserCopyName: `${local.meta.id} (conflict from ${remote.meta.deviceId})`,
      });

      if (winner === 'local') {
        toPush.push({ meta: local.meta, blob: Buffer.alloc(0) });
      } else {
        toApply.push({ meta: remote.meta, plaintext: remotePlain });
      }
      toApply.push({
        meta: {
          ...loserMeta,
          id: `${loserMeta.id}-conflict-${now}`,
          revision: Math.max(local.meta.revision, remote.meta.revision),
          updatedAt: now,
          deviceId,
        },
        plaintext: loserPlain,
      });
      newBaseEntries.push(winnerMeta);
      continue;
    }

    // Only one side present and changed.
    if (local && localChanged) {
      toPush.push({ meta: local.meta, blob: Buffer.alloc(0) });
      newBaseEntries.push(local.meta);
    } else if (remote && remoteChanged) {
      const plain = await remotePlaintext(remote);
      if (plain === undefined) {
        skipped.push({ id: remote.meta.id, reason: 'missing remote blob' });
        if (base) {
          newBaseEntries.push(base);
        }
        continue;
      }
      toApply.push({ meta: remote.meta, plaintext: plain });
      newBaseEntries.push(remote.meta);
    }
  }

  return {
    toPush,
    toApply,
    conflicts,
    skipped,
    newBaseManifest: pruneTombstones(newBaseEntries, now),
  };
}

/** Attach encrypted blobs to push items. */
export function attachEncryptedBlobs(
  toPush: SyncPushItem[],
  localItems: LocalItem[],
  encrypt: (plaintext: Buffer) => Buffer,
): SyncPushItem[] {
  const localByKey = new Map(localItems.map((i) => [metaKey(i.meta), i]));
  return toPush.map((item) => {
    const local = localByKey.get(metaKey(item.meta));
    if (!local) {
      return item;
    }
    return { meta: item.meta, blob: encrypt(local.plaintext) };
  });
}

export function bumpRevision(meta: SyncItemMeta, deviceId: string, contentHash: string, now = Date.now()): SyncItemMeta {
  return {
    ...meta,
    revision: meta.revision + 1,
    updatedAt: now,
    deviceId,
    contentHash,
    deleted: false,
  };
}

export function tombstoneMeta(meta: SyncItemMeta, deviceId: string, now = Date.now()): SyncItemMeta {
  return {
    ...meta,
    deleted: true,
    revision: meta.revision + 1,
    updatedAt: now,
    deviceId,
  };
}
