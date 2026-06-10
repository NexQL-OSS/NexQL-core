import type { SyncItemMeta, SyncPushItem } from './types';

/** Merge push items into a remote manifest when no authoritative manifest is supplied. */
export function mergeRemoteManifest(remote: SyncItemMeta[], items: SyncPushItem[]): SyncItemMeta[] {
  const map = new Map(remote.map((m) => [m.id, m]));
  for (const item of items) {
    map.set(item.meta.id, item.meta);
  }
  return Array.from(map.values());
}

/** Resolve the manifest to publish: prefer the post-merge base when provided. */
export function resolvePushManifest(
  remote: SyncItemMeta[],
  items: SyncPushItem[],
  options?: { manifest?: SyncItemMeta[] },
): SyncItemMeta[] {
  return options?.manifest ?? mergeRemoteManifest(remote, items);
}

/** Active (non-tombstone) item ids in a manifest. */
export function activeManifestIds(manifest: SyncItemMeta[]): Set<string> {
  return new Set(manifest.filter((m) => !m.deleted).map((m) => m.id));
}

/** Manifest written to remote storage — tombstones stay in local base for merge only. */
export function publishableManifest(manifest: SyncItemMeta[]): SyncItemMeta[] {
  return manifest.filter((m) => !m.deleted);
}

export const SYNC_BLOB_PREFIX = 'item-';
export const SYNC_BLOB_SUFFIX = '.bin';

export function syncBlobName(id: string): string {
  return `${SYNC_BLOB_PREFIX}${id}${SYNC_BLOB_SUFFIX}`;
}

export function parseSyncBlobId(filename: string): string | undefined {
  if (!filename.startsWith(SYNC_BLOB_PREFIX) || !filename.endsWith(SYNC_BLOB_SUFFIX)) {
    return undefined;
  }
  return filename.slice(SYNC_BLOB_PREFIX.length, -SYNC_BLOB_SUFFIX.length);
}
