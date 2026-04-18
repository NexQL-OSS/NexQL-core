import { MAX_PIVOT_DISTINCT } from './constants';
import { coerceNumber } from './coerceNumeric';

export type PivotAgg = 'sum' | 'count' | 'avg' | 'min' | 'max';

export interface PivotResult {
  rowLabels: string[];
  colLabels: string[];
  /** cells[i][j] is value at rowLabels[i], colLabels[j] */
  cells: (number | null)[][];
}

interface CellAcc {
  sum: number;
  count: number;
  min: number;
  max: number;
}

function cardinality(rows: Record<string, unknown>[], key: string): number {
  const s = new Set<string>();
  for (const row of rows) {
    s.add(String(row[key] ?? ''));
    if (s.size > MAX_PIVOT_DISTINCT) {
      return MAX_PIVOT_DISTINCT + 1;
    }
  }
  return s.size;
}

/**
 * Two-dimensional pivot over in-memory result rows (client-side).
 * Row/column dimensions are stringified cell values; capped distinct cardinality per axis.
 */
export function computePivot(
  rows: Record<string, unknown>[],
  rowDim: string,
  colDim: string,
  valueKey: string | undefined,
  agg: PivotAgg,
): PivotResult | { error: string } {
  if (!rowDim || !colDim) {
    return { error: 'Choose both row and column dimensions.' };
  }
  if (rowDim === colDim) {
    return { error: 'Row and column dimensions must be different columns.' };
  }

  const cardR = cardinality(rows, rowDim);
  const cardC = cardinality(rows, colDim);
  if (cardR > MAX_PIVOT_DISTINCT) {
    return {
      error: `Row dimension has too many distinct values (>${MAX_PIVOT_DISTINCT}). Choose a lower-cardinality column.`,
    };
  }
  if (cardC > MAX_PIVOT_DISTINCT) {
    return {
      error: `Column dimension has too many distinct values (>${MAX_PIVOT_DISTINCT}). Choose a lower-cardinality column.`,
    };
  }

  if (agg !== 'count' && !valueKey) {
    return { error: 'Choose a value column for this aggregation.' };
  }
  if (valueKey && (valueKey === rowDim || valueKey === colDim)) {
    return { error: 'Value column must differ from row and column dimensions.' };
  }

  const acc = new Map<string, Map<string, CellAcc>>();

  for (const row of rows) {
    const rk = String(row[rowDim] ?? '');
    const ck = String(row[colDim] ?? '');

    if (agg === 'count') {
      let rowMap = acc.get(rk);
      if (!rowMap) {
        rowMap = new Map();
        acc.set(rk, rowMap);
      }
      const cell = rowMap.get(ck) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
      cell.count += 1;
      rowMap.set(ck, cell);
      continue;
    }

    const vk = valueKey as string;
    const n = coerceNumber(row[vk]);
    if (n === null) {
      continue;
    }

    let rowMap = acc.get(rk);
    if (!rowMap) {
      rowMap = new Map();
      acc.set(rk, rowMap);
    }
    const cell = rowMap.get(ck) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
    cell.count += 1;
    cell.sum += n;
    if (n < cell.min) {
      cell.min = n;
    }
    if (n > cell.max) {
      cell.max = n;
    }
    rowMap.set(ck, cell);
  }

  const rowLabels = Array.from(acc.keys()).sort((a, b) => a.localeCompare(b));
  const colSet = new Set<string>();
  for (const rowMap of acc.values()) {
    for (const ck of rowMap.keys()) {
      colSet.add(ck);
    }
  }
  const colLabels = Array.from(colSet).sort((a, b) => a.localeCompare(b));

  const cells: (number | null)[][] = rowLabels.map(() =>
    colLabels.map(() => null),
  );

  for (let i = 0; i < rowLabels.length; i++) {
    const rk = rowLabels[i];
    const rowMap = acc.get(rk);
    if (!rowMap) {
      continue;
    }
    for (let j = 0; j < colLabels.length; j++) {
      const ck = colLabels[j];
      const cell = rowMap.get(ck);
      if (!cell || cell.count === 0) {
        cells[i][j] = null;
        continue;
      }
      switch (agg) {
        case 'count':
          cells[i][j] = cell.count;
          break;
        case 'sum':
          cells[i][j] = cell.sum;
          break;
        case 'avg':
          cells[i][j] = cell.sum / cell.count;
          break;
        case 'min':
          cells[i][j] = cell.min === Infinity ? null : cell.min;
          break;
        case 'max':
          cells[i][j] = cell.max === -Infinity ? null : cell.max;
          break;
        default:
          cells[i][j] = null;
      }
    }
  }

  return { rowLabels, colLabels, cells };
}
