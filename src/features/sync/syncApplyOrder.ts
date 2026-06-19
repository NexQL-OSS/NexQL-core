import type { RemoteItemMeta, SyncKind } from './types';
import { SYNC_KIND_APPLY_ORDER } from './types';

/** Sort upserts so connections apply before dependent notebooks. */
export function sortUpsertsForApply<T extends { meta: RemoteItemMeta }>(upserts: T[]): T[] {
  return [...upserts].sort(
    (a, b) => (SYNC_KIND_APPLY_ORDER[a.meta.kind] ?? 99) - (SYNC_KIND_APPLY_ORDER[b.meta.kind] ?? 99),
  );
}

export function syncKindOrder(kind: SyncKind): number {
  return SYNC_KIND_APPLY_ORDER[kind] ?? 99;
}
