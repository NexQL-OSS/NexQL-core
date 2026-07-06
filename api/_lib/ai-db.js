// Per-user monthly AI token metering for the free/managed AI Gateway proxy.
//
// Primary store: Neon Postgres (nexql_ai.usage) when DATABASE_URL is set.
// Fallback: whatever `store` uses (Vercel KV in prod, .kv-dev.json locally),
// keyed `ai:usage:<account_id>:<YYYY-MM>` → `{ used, reserved }`.
//
// Model: one row per (account_id, period). Period is a UTC calendar month
// (YYYY-MM), so counters reset on the 1st of each month. The gateway's own
// credit exhaustion is the hard backstop; these caps are the per-user limit.
//
// Tokens are reserved (a conservative pre-flight estimate) before dispatch so
// concurrent requests can't race past the monthly cap, then reconciled to the
// real provider-reported usage once the response completes (see
// reserveTokens/reconcileTokens/releaseReservedTokens below).

const store = require('./store');
const { resolveDatabaseUrl } = require('./db-url');

/** Free monthly token allowance per tier (input+output combined). Paid tiers still metered (trial pool). */
const MONTHLY_TOKEN_LIMITS = { free: 600_000, sponsor: 3_000_000, singularity: 10_000_000 };

function monthlyTokenLimit(tier) {
  return MONTHLY_TOKEN_LIMITS[tier] ?? MONTHLY_TOKEN_LIMITS.free;
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
          count      INT         NOT NULL DEFAULT 0,  -- deprecated: legacy message counter, unused after token metering
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (account_id, period)
        )
      `;
      // Token-based metering: tokens_used is settled spend, tokens_reserved is the
      // sum of outstanding pre-flight estimates for in-flight requests.
      await db`ALTER TABLE nexql_ai.usage ADD COLUMN IF NOT EXISTS tokens_used BIGINT NOT NULL DEFAULT 0`;
      await db`ALTER TABLE nexql_ai.usage ADD COLUMN IF NOT EXISTS tokens_reserved BIGINT NOT NULL DEFAULT 0`;
    })();
  }
  return schemaReady;
}

// ── Fallback (KV / dev json) path ─────────────────────────────────────────────

function kvKey(accountId, period) {
  return `ai:usage:${accountId}:${period}`;
}

/** Coerce a raw KV value (possibly a stale pre-migration bare integer) to `{ used, reserved }`. */
function coerceUsageValue(raw) {
  if (raw && typeof raw === 'object') {
    return { used: Number(raw.used) || 0, reserved: Number(raw.reserved) || 0 };
  }
  // Legacy message-count integer (or absent) — discard, don't attempt to convert.
  return { used: 0, reserved: 0 };
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Settled + outstanding-reserved token totals for an account this period. */
async function readTokenUsage(accountId, period = currentPeriod()) {
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    const rows = await db`
      SELECT tokens_used, tokens_reserved FROM nexql_ai.usage
      WHERE account_id = ${accountId} AND period = ${period} LIMIT 1
    `;
    return { used: Number(rows[0]?.tokens_used || 0), reserved: Number(rows[0]?.tokens_reserved || 0) };
  }
  const raw = await store.rawGet(kvKey(accountId, period));
  return coerceUsageValue(raw);
}

/**
 * Atomically reserve `estTokens` against the monthly cap *before* dispatching to the
 * gateway. Prevents the read-then-increment (TOCTOU) race where concurrent requests
 * all pass a `used+reserved < limit` gate before any of them reserves.
 *
 * Returns `{ ok, used, reserved }`. When `ok` is false the caller is at/over the cap
 * and must not dispatch. On completion the caller must call exactly one of
 * {@link reconcileTokens} (settle to real usage) or {@link releaseReservedTokens}
 * (full refund, e.g. on failure/abort) so a reservation never strands.
 *
 * Neon path is a single atomic statement. The KV/dev fallback is best-effort
 * (read-modify-write) — acceptable since it only runs locally / without a database.
 */
async function reserveTokens(accountId, period, estTokens, limit) {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(estTokens) || estTokens <= 0) {
    return { ok: false, used: 0, reserved: 0 };
  }
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    // Unlike a flat "+1" reservation, a single request's token estimate can itself
    // exceed the cap on a brand-new account's very first (oversized) request, so the
    // fresh-row INSERT branch can't be assumed safe without this explicit pre-check.
    if (estTokens > limit) {
      const cur = await db`
        SELECT tokens_used, tokens_reserved FROM nexql_ai.usage
        WHERE account_id = ${accountId} AND period = ${period} LIMIT 1
      `;
      return { ok: false, used: Number(cur[0]?.tokens_used || 0), reserved: Number(cur[0]?.tokens_reserved || 0) };
    }
    const rows = await db`
      INSERT INTO nexql_ai.usage (account_id, period, tokens_used, tokens_reserved, updated_at)
      VALUES (${accountId}, ${period}, 0, ${estTokens}, now())
      ON CONFLICT (account_id, period) DO UPDATE
        SET tokens_reserved = nexql_ai.usage.tokens_reserved + ${estTokens}, updated_at = now()
        WHERE nexql_ai.usage.tokens_used + nexql_ai.usage.tokens_reserved + ${estTokens} <= ${limit}
      RETURNING tokens_used, tokens_reserved
    `;
    if (rows[0]) {
      return { ok: true, used: Number(rows[0].tokens_used), reserved: Number(rows[0].tokens_reserved) };
    }
    const cur = await db`
      SELECT tokens_used, tokens_reserved FROM nexql_ai.usage
      WHERE account_id = ${accountId} AND period = ${period} LIMIT 1
    `;
    return { ok: false, used: Number(cur[0]?.tokens_used || 0), reserved: Number(cur[0]?.tokens_reserved || limit) };
  }
  const key = kvKey(accountId, period);
  const cur = coerceUsageValue(await store.rawGet(key));
  if (cur.used + cur.reserved + estTokens > limit) {
    return { ok: false, ...cur };
  }
  const next = { used: cur.used, reserved: cur.reserved + estTokens };
  // Retain ~40 days so the counter self-expires shortly after the month rolls.
  await store.rawSet(key, next, 40 * 24 * 60 * 60);
  return { ok: true, ...next };
}

/**
 * Settle a reservation with the real cost once known: move `estTokens` out of
 * `tokens_reserved` and add `actualTokens` into `tokens_used`. `actualTokens` may
 * exceed `estTokens` (denser-than-estimated input tokenization) — allowed to push
 * `tokens_used` slightly past the monthly limit; the next reservation attempt for
 * that account then correctly fails closed. No limit re-check here: a request that
 * was already admitted must never fail at settlement time.
 */
async function reconcileTokens(accountId, period, estTokens, actualTokens) {
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    const rows = await db`
      UPDATE nexql_ai.usage
        SET tokens_used = tokens_used + ${actualTokens},
            tokens_reserved = GREATEST(tokens_reserved - ${estTokens}, 0),
            updated_at = now()
      WHERE account_id = ${accountId} AND period = ${period}
      RETURNING tokens_used, tokens_reserved
    `;
    return { used: Number(rows[0]?.tokens_used || 0), reserved: Number(rows[0]?.tokens_reserved || 0) };
  }
  const key = kvKey(accountId, period);
  const cur = coerceUsageValue(await store.rawGet(key));
  const next = { used: cur.used + actualTokens, reserved: Math.max(0, cur.reserved - estTokens) };
  await store.rawSet(key, next, 40 * 24 * 60 * 60);
  return next;
}

/** Release a previously reserved amount without settling any spend (never drops below zero). */
async function releaseReservedTokens(accountId, period = currentPeriod(), estTokens = 0) {
  const db = getSql();
  if (db) {
    await ensureSchema(db);
    const rows = await db`
      UPDATE nexql_ai.usage
        SET tokens_reserved = GREATEST(tokens_reserved - ${estTokens}, 0), updated_at = now()
      WHERE account_id = ${accountId} AND period = ${period}
      RETURNING tokens_used, tokens_reserved
    `;
    return { used: Number(rows[0]?.tokens_used || 0), reserved: Number(rows[0]?.tokens_reserved || 0) };
  }
  const key = kvKey(accountId, period);
  const cur = coerceUsageValue(await store.rawGet(key));
  const next = { used: cur.used, reserved: Math.max(0, cur.reserved - estTokens) };
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
  const count = await store.rawIncr(key, windowSec * 2);
  return { ok: count <= max, count };
}

module.exports = {
  MONTHLY_TOKEN_LIMITS,
  monthlyTokenLimit,
  currentPeriod,
  nextResetIso,
  readTokenUsage,
  reserveTokens,
  reconcileTokens,
  releaseReservedTokens,
  pruneOldUsage,
  touchRate,
};
