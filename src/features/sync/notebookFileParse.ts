/** Shareable/raw notebook fields extracted from an on-disk .pgsql JSON object. */
export interface NotebookFileContent {
  cells: Array<{ value: string; kind?: string }>;
  databaseName?: string;
}

/** Parse notebook cells and metadata the same way as NotebookSyncService.collectLocalNotebooks. */
export function parseNotebookFileContent(parsed: Record<string, unknown>): NotebookFileContent {
  const metadata = (parsed.metadata ?? {}) as Record<string, unknown>;
  const cells = Array.isArray(parsed.cells)
    ? (parsed.cells as Array<{ value: string; kind?: string }>)
    : [];
  const databaseName = typeof metadata.databaseName === 'string' ? metadata.databaseName : undefined;
  return { cells, databaseName };
}
