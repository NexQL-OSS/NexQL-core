/**
 * Parse a cell value to a finite number, or null if not numeric.
 */
export function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  const s = String(value).trim();
  if (s === '') {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
