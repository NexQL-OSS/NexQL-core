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
const MONTHLY_LIMITS = { free: 5, sponsor: 50, singularity: 200 };

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

module.exports = {
  MONTHLY_LIMITS,
  monthlyLimit,
  currentPeriod,
  nextResetIso,
  readUsage,
  incrementUsage,
};
