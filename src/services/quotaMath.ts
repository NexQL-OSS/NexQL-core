// ---------------------------------------------------------------------------
// Pure freemium-quota math: period keys, reset times, and consume logic.
// No VS Code / storage deps, so it is fully unit-testable. The QuotaService
// wraps this with globalState persistence.
// ---------------------------------------------------------------------------

export type QuotaPeriod = 'day' | 'week' | 'month';

export interface FeatureQuota {
  limit: number;
  period: QuotaPeriod;
}

/** Persisted per-feature counter: which period it belongs to + how many uses. */
export interface UsageRecord {
  key: string;
  count: number;
}

export interface ConsumeResult {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
  period: QuotaPeriod;
  resetsAt: Date;
  record: UsageRecord;
}

export interface PeekResult {
  used: number;
  remaining: number;
  limit: number;
  period: QuotaPeriod;
  resetsAt: Date;
}

function isoWeek(date: Date): { year: number; week: number } {
  // Build a UTC proxy from local Y/M/D so the week boundary tracks the user's calendar.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to the Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** Stable identifier for the current period; usage resets when this changes. */
export function periodKey(period: QuotaPeriod, date: Date): string {
  if (period === 'month') {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  if (period === 'week') {
    const { year, week } = isoWeek(date);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** When the current period ends (local midnight for day; next Monday 00:00 for week; 1st of next month). */
export function nextReset(period: QuotaPeriod, date: Date): Date {
  if (period === 'month') {
    return new Date(date.getFullYear(), date.getMonth() + 1, 1, 0, 0, 0, 0);
  }
  if (period === 'week') {
    const dow = date.getDay(); // 0=Sun .. 6=Sat
    let daysUntilMonday = (8 - (dow === 0 ? 7 : dow)) % 7;
    if (daysUntilMonday === 0) { daysUntilMonday = 7; }
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + daysUntilMonday, 0, 0, 0, 0);
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

/** Used count in the current period for a stored record (0 when stale/absent). */
function usedInPeriod(record: UsageRecord | undefined, key: string): number {
  return record && record.key === key ? record.count : 0;
}

/** Read-only view of current usage. */
export function peek(record: UsageRecord | undefined, quota: FeatureQuota, now: Date): PeekResult {
  const key = periodKey(quota.period, now);
  const used = usedInPeriod(record, key);
  return {
    used,
    remaining: Math.max(0, quota.limit - used),
    limit: quota.limit,
    period: quota.period,
    resetsAt: nextReset(quota.period, now),
  };
}

/**
 * Attempt to consume one unit. Returns the decision and the record to persist.
 * On a blocked call the record is unchanged (no increment past the limit).
 */
export function consume(record: UsageRecord | undefined, quota: FeatureQuota, now: Date): ConsumeResult {
  const key = periodKey(quota.period, now);
  const used = usedInPeriod(record, key);
  const resetsAt = nextReset(quota.period, now);

  if (used >= quota.limit) {
    return { allowed: false, used, remaining: 0, limit: quota.limit, period: quota.period, resetsAt, record: { key, count: used } };
  }
  const next: UsageRecord = { key, count: used + 1 };
  return {
    allowed: true,
    used: next.count,
    remaining: Math.max(0, quota.limit - next.count),
    limit: quota.limit,
    period: quota.period,
    resetsAt,
    record: next,
  };
}

/** Human phrase for when the quota resets, e.g. "resets tomorrow" / "resets in 3 days". */
export function formatReset(resetsAt: Date, now: Date): string {
  const ms = resetsAt.getTime() - now.getTime();
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 1) { return 'resets within the hour'; }
  if (hours < 24) { return `resets in ${hours}h`; }
  const days = Math.round(hours / 24);
  if (days <= 1) { return 'resets tomorrow'; }
  return `resets in ${days} days`;
}
