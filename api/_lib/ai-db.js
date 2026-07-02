// Per-user monthly AI request counter for the free/managed AI Gateway proxy.
//
// Primary store: Neon Postgres (nexql_ai.usage) when DATABASE_URL is set.
// Fallback: whatever `store` uses (Vercel KV in prod, .kv-dev.json locally),
// keyed `ai:usage:<account_id>:<YYYY-MM>` → integer counter.
//
// Model: one row per (account_id, period). Period is a UTC calendar month
// (YYYY-MM), so counters reset on the 1st of each month. The gateway's own
// credit exhaustion is the hard backstop; these caps are the per-user limit.

const store = require('./store');
const { resolveDatabaseUrl } = require('./db-url');

/** Free monthly request allowance per tier. Paid tiers still metered (trial pool). */
const MONTHLY_LIMITS = { free: 50, sponsor: 200, singularity: 500 };

function monthlyLimit(tier) {
  return MONTHLY_LIMITS[tier] ?? MONTHLY_LIMITS.free;
}

/** Stable UTC month key; usage resets when this rolls over. */
function currentPeriod(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** ISO timestamp of the next reset (first day of the next UTC month). */
function nextResetIso(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)).toISOString();
}

// ── Neon path ────────────────────────────────────────────────────────────────

let sql = null;
let schemaReady = null;

function getSql() {
  if (sql === null) {
    const url = resolveDatabaseUrl();
    if (!url) {
      sql = false; // memoize "not configured" so we stop probing
      return null;
    }
    const { neon } = require('@neondatabase/serverless');
    sql = neon(url);
  }
  return sql || null;
}

async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db`CREATE SCHEMA IF NOT EXISTS nexql_ai`;
      await db`
        CREATE TABLE IF NOT EXISTS nexql_ai.usage (
          account_id TEXT        NOT NULL,
          period     TEXT        NOT NULL,
          count      INT         NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (account_id, period)
        )
      `;
    })();
  }
  return schemaReady;
}

// ── Fallback (KV / dev json) path ─────────────────────────────────────────────

function kvKey(accountId, period) {
  return `ai:usage:${accountId}:${period}`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Current used count for an account this period (0 when absent). */
async function readUsage(accountId, period = currentPeriod()) {
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    const rows = await db`
      SELECT count FROM nexql_ai.usage
      WHERE account_id = ${accountId} AND period = ${period} LIMIT 1
    `;
    return Number(rows[0]?.count || 0);
  }
  const raw = await store.rawGet(kvKey(accountId, period));
  return Number(raw || 0);
}

/** Increment and return the new count. Call only after a successful completion. */
async function incrementUsage(accountId, period = currentPeriod()) {
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    const rows = await db`
      INSERT INTO nexql_ai.usage (account_id, period, count, updated_at)
      VALUES (${accountId}, ${period}, 1, now())
      ON CONFLICT (account_id, period) DO UPDATE
        SET count = nexql_ai.usage.count + 1, updated_at = now()
      RETURNING count
    `;
    return Number(rows[0]?.count || 1);
  }
  const key = kvKey(accountId, period);
  const next = Number((await store.rawGet(key)) || 0) + 1;
  // Retain ~40 days so the counter self-expires shortly after the month rolls.
  await store.rawSet(key, next, 40 * 24 * 60 * 60);
  return next;
}

/**
 * Atomically reserve one request against the monthly cap *before* dispatching to the
 * gateway. Prevents the read-then-increment (TOCTOU) race where concurrent requests
 * all pass a `readUsage < limit` gate before any of them increments.
 *
 * Returns `{ ok, count }`. When `ok` is false the caller is at/over the cap and must
 * not dispatch. On any downstream failure the caller should call {@link refundUsage}
 * so a failed/empty completion does not burn the reservation.
 *
 * Neon path is a single atomic statement. The KV/dev fallback is best-effort
 * (read-modify-write) — acceptable since it only runs locally / without a database.
 */
async function reserveUsage(accountId, period, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: false, count: 0 };
  }
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    // Fresh row always inserts count=1 (≤ any positive limit). For an existing row the
    // DO UPDATE only fires while still under the cap; at/over the cap it returns no row.
    const rows = await db`
      INSERT INTO nexql_ai.usage (account_id, period, count, updated_at)
      VALUES (${accountId}, ${period}, 1, now())
      ON CONFLICT (account_id, period) DO UPDATE
        SET count = nexql_ai.usage.count + 1, updated_at = now()
        WHERE nexql_ai.usage.count < ${limit}
      RETURNING count
    `;
    if (rows[0]) {
      return { ok: true, count: Number(rows[0].count) };
    }
    const cur = await db`
      SELECT count FROM nexql_ai.usage
      WHERE account_id = ${accountId} AND period = ${period} LIMIT 1
    `;
    return { ok: false, count: Number(cur[0]?.count || limit) };
  }
  const key = kvKey(accountId, period);
  const cur = Number((await store.rawGet(key)) || 0);
  if (cur >= limit) {
    return { ok: false, count: cur };
  }
  const next = cur + 1;
  await store.rawSet(key, next, 40 * 24 * 60 * 60);
  return { ok: true, count: next };
}

/** Release a previously reserved request (never drops below zero). */
async function refundUsage(accountId, period = currentPeriod()) {
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    const rows = await db`
      UPDATE nexql_ai.usage
        SET count = GREATEST(count - 1, 0), updated_at = now()
      WHERE account_id = ${accountId} AND period = ${period}
      RETURNING count
    `;
    return Number(rows[0]?.count || 0);
  }
  const key = kvKey(accountId, period);
  const cur = Number((await store.rawGet(key)) || 0);
  const next = Math.max(0, cur - 1);
  await store.rawSet(key, next, 40 * 24 * 60 * 60);
  return next;
}

/** Drop usage rows older than `keepMonths` calendar months (Neon only; KV self-expires). */
async function pruneOldUsage(keepMonths = 3, date = new Date()) {
  const db = getSql();
  if (!db) {
    return 0;
  }
  await ensureSchema(db);
  const cutoff = currentPeriod(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - keepMonths, 1)));
  const rows = await db`
    DELETE FROM nexql_ai.usage WHERE period < ${cutoff} RETURNING account_id
  `;
  return rows.length;
}

/**
 * Coarse fixed-window throttle on top of the monthly cap, backed by the ephemeral
 * store (KV/dev). `id` is any stable string (account id or client IP). The window
 * bucket is embedded in the key so it self-expires — no sliding-window bookkeeping.
 */
async function touchRate(id, max, windowSec) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const key = `ai:rate:${id}:${bucket}`;
  const count = Number((await store.rawGet(key)) || 0) + 1;
  await store.rawSet(key, count, windowSec * 2);
  return { ok: count <= max, count };
}

module.exports = {
  MONTHLY_LIMITS,
  monthlyLimit,
  currentPeriod,
  nextResetIso,
  readUsage,
  incrementUsage,
  reserveUsage,
  refundUsage,
  pruneOldUsage,
  touchRate,
};
