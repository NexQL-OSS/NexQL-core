import type { SyncKind } from './types';

/**
 * Item kinds that may be shared with other team members. Connections and the
 * secrets bundle are never shareable — sharing must not leak hosts, usernames
 * or passwords.
 */
export const SHAREABLE_KINDS: ReadonlySet<SyncKind> = new Set<SyncKind>(['query', 'notebook']);

export function isShareableKind(kind: SyncKind): boolean {
  return SHAREABLE_KINDS.has(kind);
}

export interface SharedItemPayload {
  kind: SyncKind;
  /** Scrubbed item content (no connection ids, hosts, usernames, secrets). */
  payload: Record<string, unknown>;
  /** Non-sensitive connection descriptor, for the grantee to map to their own. */
  connectionHint?: { database?: string };
}

/**
 * Strip everything that ties an item to the owner's environment or credentials.
 * Notebooks keep cells + a database-name hint only; queries keep text/metadata
 * but drop any connection binding. Throws for non-shareable kinds so a bug
 * cannot exfiltrate a connection or secrets bundle.
 */
export function scrubForShare(kind: SyncKind, raw: Record<string, unknown>): SharedItemPayload {
  if (!isShareableKind(kind)) {
    throw new Error(`Refusing to share non-shareable item kind: ${kind}`);
  }

  if (kind === 'notebook') {
    const cells = Array.isArray(raw.cells)
      ? (raw.cells as Array<Record<string, unknown>>).map((c) => ({
          value: typeof c.value === 'string' ? c.value : '',
          kind: c.kind === 'markdown' ? 'markdown' : 'sql',
        }))
      : [];
    const database = typeof raw.databaseName === 'string' ? raw.databaseName : undefined;
    return {
      kind,
      payload: {
        // syncId intentionally dropped — the grantee mints their own identity.
        name: typeof raw.name === 'string' ? raw.name : 'Shared notebook',
        cells,
      },
      connectionHint: database ? { database } : undefined,
    };
  }

  // query
  const out: Record<string, unknown> = {};
  for (const key of ['title', 'query', 'description', 'tags'] as const) {
    if (raw[key] !== undefined) {
      out[key] = raw[key];
    }
  }
  return { kind, payload: out };
}

/**
 * Reconstruct a local item payload from a shared payload for the grantee.
 * `connectionId` is supplied by the grantee (their own connection) — never the
 * owner's. A fresh id is assigned by the caller.
 */
export function materializeShared(
  shared: SharedItemPayload,
  newId: string,
  connectionId: string | undefined,
  now: number,
): Record<string, unknown> {
  if (shared.kind === 'notebook') {
    return {
      syncId: newId,
      name: (shared.payload.name as string) ?? 'Shared notebook',
      connectionId: connectionId ?? '',
      databaseName: shared.connectionHint?.database,
      cells: shared.payload.cells ?? [],
    };
  }
  return {
    ...shared.payload,
    id: newId,
    connectionId: connectionId ?? undefined,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}
