import { HISTOGRAM_BUCKET_COUNT } from './constants';
import { coerceNumber } from './coerceNumeric';

export interface HistogramResult {
  bucketLabels: string[];
  counts: number[];
  min: number;
  max: number;
  validCount: number;
  error?: string;
}

export interface HistogramOptions {
  bucketCount?: number;
}

/**
 * Equal-width histogram over numeric values in `column` (client-side).
 */
export function buildHistogram(
  rows: Record<string, unknown>[],
  column: string,
  options: HistogramOptions = {},
): HistogramResult {
  const bucketCount = options.bucketCount ?? HISTOGRAM_BUCKET_COUNT;
  const nums: number[] = [];

  for (const row of rows) {
    const n = coerceNumber(row[column]);
    if (n !== null) {
      nums.push(n);
    }
  }

  if (nums.length === 0) {
    return {
      bucketLabels: [],
      counts: [],
      min: 0,
      max: 0,
      validCount: 0,
      error: 'No numeric values in this column.',
    };
  }

  let min = nums[0];
  let max = nums[0];
  for (const n of nums) {
    if (n < min) {
      min = n;
    }
    if (n > max) {
      max = n;
    }
  }

  const validCount = nums.length;

  if (min === max) {
    return {
      bucketLabels: [`${formatNum(min)}`],
      counts: [validCount],
      min,
      max,
      validCount,
    };
  }

  const buckets = new Array<number>(bucketCount).fill(0);
  const span = max - min;
  const n = nums.length;
  for (let i = 0; i < n; i++) {
    const v = nums[i];
    const idx = Math.min(
      bucketCount - 1,
      Math.floor(((v - min) / span) * bucketCount),
    );
    buckets[idx]++;
  }

  const bucketLabels: string[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const lo = min + (span * b) / bucketCount;
    const hi = min + (span * (b + 1)) / bucketCount;
    bucketLabels.push(`${formatNum(lo)} – ${formatNum(hi)}`);
  }

  return {
    bucketLabels,
    counts: buckets,
    min,
    max,
    validCount,
  };
}

function formatNum(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e12) {
    return String(x);
  }
  return x.toPrecision(4);
}
