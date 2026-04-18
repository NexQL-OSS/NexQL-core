import { DISTINCT_COUNT_CAP } from './constants';
import { coerceNumber } from './coerceNumeric';
import { isPgNumericType } from './pgNumeric';

export interface ColumnStatSummary {
  column: string;
  pgType?: string;
  rowCount: number;
  nonNullCount: number;
  nullCount: number;
  /** Distinct non-null values; may be capped at DISTINCT_COUNT_CAP. */
  distinctCount: number;
  distinctCapped: boolean;
  numeric?: {
    min: number;
    max: number;
    sum: number;
    avg: number;
  };
}

function countDistinctNonNull(sample: Iterable<unknown>): { count: number; capped: boolean } {
  const s = new Set<unknown>();
  for (const v of sample) {
    if (v === null || v === undefined) {
      continue;
    }
    s.add(v);
    if (s.size >= DISTINCT_COUNT_CAP) {
      return { count: DISTINCT_COUNT_CAP, capped: true };
    }
  }
  return { count: s.size, capped: false };
}

/**
 * Per-column summary for the current result set (client-side).
 */
export function computeColumnStats(
  rows: Record<string, unknown>[],
  columns: string[],
  columnTypes?: Record<string, string>,
): ColumnStatSummary[] {
  const rowCount = rows.length;
  return columns.map((col) => {
    const pgType = columnTypes?.[col];
    const values = rows.map((r) => r[col]);
    let nonNullCount = 0;
    for (const v of values) {
      if (v !== null && v !== undefined) {
        nonNullCount++;
      }
    }
    const nullCount = rowCount - nonNullCount;

    const { count: distinctCount, capped: distinctCapped } = countDistinctNonNull(values);

    const treatAsNumeric = isPgNumericType(pgType) || shouldTreatAsNumericBySampling(values);

    if (!treatAsNumeric) {
      return {
        column: col,
        pgType,
        rowCount,
        nonNullCount,
        nullCount,
        distinctCount,
        distinctCapped,
      };
    }

    const nums: number[] = [];
    for (const v of values) {
      const n = coerceNumber(v);
      if (n !== null) {
        nums.push(n);
      }
    }

    if (nums.length === 0) {
      return {
        column: col,
        pgType,
        rowCount,
        nonNullCount,
        nullCount,
        distinctCount,
        distinctCapped,
      };
    }

    let min = nums[0];
    let max = nums[0];
    let sum = 0;
    for (const n of nums) {
      if (n < min) {
        min = n;
      }
      if (n > max) {
        max = n;
      }
      sum += n;
    }
    const avg = sum / nums.length;

    return {
      column: col,
      pgType,
      rowCount,
      nonNullCount,
      nullCount,
      distinctCount,
      distinctCapped,
      numeric: { min, max, sum, avg },
    };
  });
}

/** When pg type is unknown, infer numeric from sample (first 50 non-null rows). */
function shouldTreatAsNumericBySampling(values: unknown[]): boolean {
  let checked = 0;
  for (const v of values) {
    if (v === null || v === undefined) {
      continue;
    }
    if (coerceNumber(v) === null) {
      return false;
    }
    checked++;
    if (checked >= 50) {
      break;
    }
  }
  return checked > 0;
}
