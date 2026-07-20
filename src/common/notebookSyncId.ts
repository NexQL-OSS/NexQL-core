/** Read stable sync identity from a serialized .pgsql JSON object. */
export function readNotebookSyncId(parsed: Record<string, unknown>): string | undefined {
  const meta = parsed.metadata as Record<string, unknown> | undefined;
  if (!meta) {
    return undefined;
  }
  if (typeof meta.syncId === 'string' && meta.syncId.length > 0) {
    return meta.syncId;
  }
  const custom = meta.custom as { metadata?: Record<string, unknown> } | undefined;
  const nested = custom?.metadata?.syncId;
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined;
}
