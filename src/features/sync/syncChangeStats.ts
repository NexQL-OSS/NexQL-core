import type {
  SyncChangeSummary,
  SyncDirectionSummary,
  SyncItemMeta,
  SyncKind,
  SyncKindChangeCounts,
  SyncPushItem,
} from './types';

const EMPTY_COUNTS: SyncKindChangeCounts = { created: 0, updated: 0, deleted: 0 };

export function emptySyncChangeSummary(): SyncChangeSummary {
  return {
    pushed: {
      connections: { ...EMPTY_COUNTS },
      queries: { ...EMPTY_COUNTS },
      notebooks: { ...EMPTY_COUNTS },
    },
    pulled: {
      connections: { ...EMPTY_COUNTS },
      queries: { ...EMPTY_COUNTS },
      notebooks: { ...EMPTY_COUNTS },
    },
  };
}

type TrackedKind = keyof SyncDirectionSummary;

function trackedKind(kind: SyncKind): TrackedKind | undefined {
  if (kind === 'connection') {
    return 'connections';
  }
  if (kind === 'query') {
    return 'queries';
  }
  if (kind === 'notebook') {
    return 'notebooks';
  }
  return undefined;
}

function metaKey(m: SyncItemMeta): string {
  return `${m.kind}:${m.id}`;
}

function classifyOutgoing(meta: SyncItemMeta, baseByKey: Map<string, SyncItemMeta>): keyof SyncKindChangeCounts {
  if (meta.deleted) {
    return 'deleted';
  }
  const base = baseByKey.get(metaKey(meta));
  if (!base || base.deleted) {
    return 'created';
  }
  return 'updated';
}

function classifyIncoming(meta: SyncItemMeta, localByKey: Map<string, SyncItemMeta>): keyof SyncKindChangeCounts {
  if (meta.deleted) {
    return 'deleted';
  }
  const local = localByKey.get(metaKey(meta));
  if (!local || local.deleted) {
    return 'created';
  }
  return 'updated';
}

export function buildSyncChangeSummary(
  baseManifest: SyncItemMeta[],
  localItems: Array<{ meta: SyncItemMeta }>,
  pushed: SyncPushItem[],
  pulled: Array<{ meta: SyncItemMeta }>,
): SyncChangeSummary {
  const summary = emptySyncChangeSummary();
  const baseByKey = new Map(baseManifest.map((m) => [metaKey(m), m]));
  const localByKey = new Map(localItems.map((i) => [metaKey(i.meta), i.meta]));

  for (const item of pushed) {
    const bucket = trackedKind(item.meta.kind);
    if (!bucket) {
      continue;
    }
    const action = classifyOutgoing(item.meta, baseByKey);
    summary.pushed[bucket][action] += 1;
  }

  for (const item of pulled) {
    const bucket = trackedKind(item.meta.kind);
    if (!bucket) {
      continue;
    }
    const action = classifyIncoming(item.meta, localByKey);
    summary.pulled[bucket][action] += 1;
  }

  return summary;
}

export function hasSyncChanges(summary: SyncChangeSummary): boolean {
  for (const direction of [summary.pushed, summary.pulled]) {
    for (const counts of Object.values(direction)) {
      if (counts.created > 0 || counts.updated > 0 || counts.deleted > 0) {
        return true;
      }
    }
  }
  return false;
}

/** Compact log line: `conn+2/~1/-0 query+0/~0/-0 nb+1/~0/-0` */
export function formatCountsLine(direction: SyncDirectionSummary): string {
  const fmt = (label: string, counts: SyncKindChangeCounts): string =>
    `${label}+${counts.created}/~${counts.updated}/-${counts.deleted}`;
  return [
    fmt('conn', direction.connections),
    fmt('query', direction.queries),
    fmt('nb', direction.notebooks),
  ].join(' ');
}
