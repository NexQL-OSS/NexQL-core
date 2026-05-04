export function parseCellKey(key: string): { rowIndex: number; colName: string } | null {
  const sep = key.indexOf('-');
  if (sep === -1) return null;
  const rowIndex = Number.parseInt(key.slice(0, sep), 10);
  if (Number.isNaN(rowIndex)) return null;
  return { rowIndex, colName: key.slice(sep + 1) };
}

export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function buildEditDiffRows(
  modifiedCells: Map<string, { originalValue: unknown; newValue: unknown }>,
  originalRows: unknown[],
  tableInfo: { primaryKeys?: string[] } | undefined,
): Array<{
  rowIndex: number;
  rowLabel: string;
  colName: string;
  oldValue: string;
  newValue: string;
}> {
  const rowsForDiff: Array<{
    rowIndex: number;
    rowLabel: string;
    colName: string;
    oldValue: string;
    newValue: string;
  }> = [];

  modifiedCells.forEach((diff, key) => {
    const parsed = parseCellKey(key);
    if (!parsed) return;

    const { rowIndex, colName } = parsed;
    const pkLabel = tableInfo?.primaryKeys?.length
      ? tableInfo.primaryKeys
          .map((pk: string) => `${pk}=${formatDiffValue((originalRows[rowIndex] as Record<string, unknown>)?.[pk])}`)
          .join(', ')
      : `row #${rowIndex + 1}`;

    rowsForDiff.push({
      rowIndex,
      rowLabel: pkLabel,
      colName,
      oldValue: formatDiffValue(diff.originalValue),
      newValue: formatDiffValue(diff.newValue),
    });
  });

  rowsForDiff.sort((a, b) => {
    if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
    return a.colName.localeCompare(b.colName);
  });
  return rowsForDiff;
}

export function buildDeletionReviewRows(
  rowsMarkedForDeletion: Set<number>,
  originalRows: unknown[],
  tableInfo: { primaryKeys?: string[] } | undefined,
): Array<{ rowIndex: number; rowLabel: string }> {
  const sorted = Array.from(rowsMarkedForDeletion).sort((a, b) => a - b);
  return sorted.map((rowIndex) => {
    const pkLabel = tableInfo?.primaryKeys?.length
      ? tableInfo.primaryKeys
          .map((pk: string) => `${pk}=${formatDiffValue((originalRows[rowIndex] as Record<string, unknown>)?.[pk])}`)
          .join(', ')
      : `row #${rowIndex + 1}`;
    return {
      rowIndex,
      rowLabel: pkLabel,
    };
  });
}
