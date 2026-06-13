import type { MergeConflict, SyncItemMeta, SyncKind, SyncPreviewItem, SyncPushItem } from './types';

function metaKey(m: SyncItemMeta): string {
  return `${m.kind}:${m.id}`;
}

function classifyOutgoing(meta: SyncItemMeta, baseByKey: Map<string, SyncItemMeta>): SyncPreviewItem['changeType'] {
  if (meta.deleted) {
    return 'delete';
  }
  const base = baseByKey.get(metaKey(meta));
  if (!base || base.deleted) {
    return 'create';
  }
  return 'update';
}

function classifyIncoming(meta: SyncItemMeta, localByKey: Map<string, SyncItemMeta>): SyncPreviewItem['changeType'] {
  if (meta.deleted) {
    return 'delete';
  }
  const local = localByKey.get(metaKey(meta));
  if (!local || local.deleted) {
    return 'create';
  }
  return 'update';
}

export function buildPreviewFromMerge(
  baseManifest: SyncItemMeta[],
  localItems: Array<{ meta: SyncItemMeta }>,
  toPush: SyncPushItem[],
  toApply: Array<{ meta: SyncItemMeta }>,
  conflicts: MergeConflict[],
  nameFor: (id: string, kind: SyncKind) => string | undefined,
): { outgoing: SyncPreviewItem[]; incoming: SyncPreviewItem[]; conflictItems: SyncPreviewItem[] } {
  const baseByKey = new Map(baseManifest.map((m) => [metaKey(m), m]));
  const localByKey = new Map(localItems.map((i) => [metaKey(i.meta), i.meta]));

  const outgoing: SyncPreviewItem[] = toPush.map((item) => ({
    id: item.meta.id,
    kind: item.meta.kind,
    name: nameFor(item.meta.id, item.meta.kind),
    changeType: classifyOutgoing(item.meta, baseByKey),
    deviceId: item.meta.deviceId,
  }));

  const incoming: SyncPreviewItem[] = toApply.map(({ meta }) => ({
    id: meta.id,
    kind: meta.kind,
    name: nameFor(meta.id, meta.kind),
    changeType: classifyIncoming(meta, localByKey),
    deviceId: meta.deviceId,
  }));

  const conflictItems: SyncPreviewItem[] = conflicts.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.localName,
    changeType: 'conflict',
    deviceId: c.remoteDeviceId,
  }));

  return { outgoing, incoming, conflictItems };
}

export function mergeBaseManifestPartial(
  oldBase: SyncItemMeta[],
  newBase: SyncItemMeta[],
  syncedKeys: Set<string>,
): SyncItemMeta[] {
  const result = new Map(oldBase.map((m) => [metaKey(m), m]));
  for (const m of newBase) {
    const key = metaKey(m);
    if (syncedKeys.has(key)) {
      result.set(key, m);
    }
  }
  return [...result.values()];
}

export function isConflictCopyId(id: string): boolean {
  return /-conflict-\d+$/.test(id);
}
