// Neon Postgres store for license entitlements, devices, and history.
// Connection URL: DATABASE_URL, POSTGRES_URL, or Vercel-prefixed variants (see db-url.js).

const { neon } = require('@neondatabase/serverless');
const { resolveDatabaseUrl, isDatabaseConfigured } = require('./db-url');

const DEVICE_LIMITS = { sponsor: 3, singularity: 25 };
const DEFAULT_DEVICE_LIMIT = 3;
const VALIDATED_OK_SAMPLE_MS = 12 * 60 * 60 * 1000;

let sql = null;
let schemaReady = null;

function isConfigured() {
  return isDatabaseConfigured();
}

function getSql() {
  if (!sql) {
    const url = resolveDatabaseUrl();
    if (!url) {
      throw new Error('DATABASE_URL is not configured');
    }
    sql = neon(url);
  }
  return sql;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeKey(licenseKey) {
  return String(licenseKey || '').trim().toUpperCase();
}

function deviceLimitFor(tier) {
  return DEVICE_LIMITS[tier] || DEFAULT_DEVICE_LIMIT;
}

function msToIso(ms) {
  if (ms == null || ms === '') return null;
  return new Date(Number(ms)).toISOString();
}

function isoToMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function rowToEntitlement(row, deviceRows) {
  if (!row) return null;
  const instanceIds = (deviceRows || [])
    .filter((d) => !d.revoked_at)
    .map((d) => d.instance_id);
  return {
    licenseKey: row.license_key,
    tier: row.tier,
    period: row.period,
    currency: row.currency,
    status: row.status,
    subscriptionId: row.subscription_id,
    email: row.email,
    expiresAt: isoToMs(row.expires_at),
    createdAt: isoToMs(row.created_at),
    instanceIds,
  };
}

async function ensureSchema() {
  if (!isConfigured()) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getSql();
      await db`CREATE SCHEMA IF NOT EXISTS pgstudio_license`;
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_license.licenses (
          license_key      TEXT PRIMARY KEY,
          tier             TEXT NOT NULL CHECK (tier IN ('sponsor','singularity')),
          period           TEXT NOT NULL DEFAULT 'monthly',
          currency         TEXT,
          status           TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','cancelled','halted','paused','expired','revoked')),
          subscription_id  TEXT UNIQUE,
          email            TEXT,
          expires_at       TIMESTAMPTZ,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS licenses_email_idx
          ON pgstudio_license.licenses (lower(email))
      `;
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_license.devices (
          license_key  TEXT NOT NULL REFERENCES pgstudio_license.licenses(license_key),
          instance_id  TEXT NOT NULL,
          device_name  TEXT,
          first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
          revoked_at   TIMESTAMPTZ,
          PRIMARY KEY (license_key, instance_id)
        )
      `;
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_license.license_events (
          id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          license_key  TEXT NOT NULL,
          event_type   TEXT NOT NULL,
          detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
          source       TEXT NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS license_events_key_created_idx
          ON pgstudio_license.license_events (license_key, created_at DESC)
      `;
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_license.webhook_events (
          razorpay_event_id TEXT PRIMARY KEY,
          received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })();
  }
  return schemaReady;
}

async function fetchLicenseRow(licenseKey) {
  await ensureSchema();
  const db = getSql();
  const key = normalizeKey(licenseKey);
  const rows = await db`
    SELECT *
    FROM pgstudio_license.licenses
    WHERE license_key = ${key}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function fetchDeviceRows(licenseKey) {
  await ensureSchema();
  const db = getSql();
  const key = normalizeKey(licenseKey);
  return db`
    SELECT instance_id, device_name, first_seen, last_seen, revoked_at
    FROM pgstudio_license.devices
    WHERE license_key = ${key}
    ORDER BY last_seen DESC
  `;
}

async function getLicense(licenseKey) {
  const row = await fetchLicenseRow(licenseKey);
  if (!row) return null;
  const devices = await fetchDeviceRows(licenseKey);
  return rowToEntitlement(row, devices);
}

async function getLicenseBySubscription(subscriptionId) {
  if (!subscriptionId) return null;
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT license_key
    FROM pgstudio_license.licenses
    WHERE subscription_id = ${subscriptionId}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return getLicense(rows[0].license_key);
}

async function getLicenseByEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT license_key
    FROM pgstudio_license.licenses
    WHERE lower(email) = ${norm}
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return getLicense(rows[0].license_key);
}

async function appendEvent(licenseKey, eventType, detail, source) {
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO pgstudio_license.license_events (license_key, event_type, detail, source)
    VALUES (
      ${normalizeKey(licenseKey)},
      ${eventType},
      ${detail || {}},
      ${source}
    )
  `;
}

async function countRenewals(licenseKey) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT COUNT(*)::int AS n
    FROM pgstudio_license.license_events
    WHERE license_key = ${normalizeKey(licenseKey)}
      AND event_type IN ('renewed', 'expiry_extended')
  `;
  return rows[0]?.n ?? 0;
}

async function getRecentEvents(licenseKey, limit = 50) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT event_type, detail, source, created_at
    FROM pgstudio_license.license_events
    WHERE license_key = ${normalizeKey(licenseKey)}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    eventType: r.event_type,
    detail: r.detail || {},
    source: r.source,
    createdAt: isoToMs(r.created_at),
  }));
}

async function recordWebhookEvent(razorpayEventId) {
  if (!razorpayEventId) return { isNew: true };
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    INSERT INTO pgstudio_license.webhook_events (razorpay_event_id)
    VALUES (${razorpayEventId})
    ON CONFLICT (razorpay_event_id) DO NOTHING
    RETURNING razorpay_event_id
  `;
  return { isNew: rows.length > 0 };
}

async function syncDevicesFromEntitlement(licenseKey, instanceIds) {
  const key = normalizeKey(licenseKey);
  const ids = Array.isArray(instanceIds) ? instanceIds : [];
  if (ids.length === 0) return;
  await ensureSchema();
  const db = getSql();
  for (const instanceId of ids) {
    await db`
      INSERT INTO pgstudio_license.devices (license_key, instance_id, last_seen, revoked_at)
      VALUES (${key}, ${instanceId}, now(), NULL)
      ON CONFLICT (license_key, instance_id) DO UPDATE SET
        last_seen = now(),
        revoked_at = NULL
    `;
  }
}

async function upsertLicense(entitlement, meta = {}) {
  const ent = entitlement || {};
  const key = normalizeKey(ent.licenseKey);
  if (!key) {
    throw new Error('upsertLicense requires licenseKey');
  }

  await ensureSchema();
  const db = getSql();
  const existing = await fetchLicenseRow(key);
  const isNew = !existing;

  const expiresAt = msToIso(ent.expiresAt);
  const createdAt = msToIso(ent.createdAt) || (existing && existing.created_at) || new Date().toISOString();

  await db`
    INSERT INTO pgstudio_license.licenses (
      license_key, tier, period, currency, status, subscription_id, email,
      expires_at, created_at, updated_at
    )
    VALUES (
      ${key},
      ${ent.tier},
      ${ent.period || 'monthly'},
      ${ent.currency || null},
      ${ent.status || 'active'},
      ${ent.subscriptionId || null},
      ${ent.email ? normalizeEmail(ent.email) : null},
      ${expiresAt},
      ${createdAt},
      now()
    )
    ON CONFLICT (license_key) DO UPDATE SET
      tier = EXCLUDED.tier,
      period = EXCLUDED.period,
      currency = EXCLUDED.currency,
      status = EXCLUDED.status,
      subscription_id = COALESCE(EXCLUDED.subscription_id, pgstudio_license.licenses.subscription_id),
      email = COALESCE(EXCLUDED.email, pgstudio_license.licenses.email),
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
  `;

  if (Array.isArray(ent.instanceIds) && ent.instanceIds.length > 0) {
    await syncDevicesFromEntitlement(key, ent.instanceIds);
  }

  const source = meta.source || 'store';
  const razorpayEvent = meta.razorpayEvent || null;

  if (isNew) {
    await appendEvent(key, 'issued', {
      tier: ent.tier,
      period: ent.period || 'monthly',
      email: ent.email || null,
      razorpay_event: razorpayEvent,
    }, source);
  } else {
    if (existing.tier !== ent.tier) {
      await appendEvent(key, 'tier_changed', {
        old_tier: existing.tier,
        new_tier: ent.tier,
        razorpay_event: razorpayEvent,
      }, source);
    }
    if (existing.status !== ent.status) {
      await appendEvent(key, 'status_changed', {
        old_status: existing.status,
        new_status: ent.status,
        razorpay_event: razorpayEvent,
      }, source);
    }
    const oldExpiry = isoToMs(existing.expires_at);
    const newExpiry = ent.expiresAt ?? null;
    if (newExpiry && newExpiry !== oldExpiry) {
      const eventType = oldExpiry && newExpiry > oldExpiry ? 'renewed' : 'expiry_extended';
      await appendEvent(key, eventType, {
        old_expires_at: oldExpiry,
        new_expires_at: newExpiry,
        razorpay_event: razorpayEvent,
      }, source);
    }
  }

  return getLicense(key);
}

async function countActiveDevices(licenseKey) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT COUNT(*)::int AS n
    FROM pgstudio_license.devices
    WHERE license_key = ${normalizeKey(licenseKey)}
      AND revoked_at IS NULL
  `;
  return rows[0]?.n ?? 0;
}

async function isDeviceActive(licenseKey, instanceId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT 1
    FROM pgstudio_license.devices
    WHERE license_key = ${normalizeKey(licenseKey)}
      AND instance_id = ${instanceId}
      AND revoked_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0;
}

async function bindDevice(licenseKey, instanceId, meta = {}) {
  const key = normalizeKey(licenseKey);
  if (!key || !instanceId) return { bound: false, isNew: false };

  await ensureSchema();
  const db = getSql();
  const existing = await db`
    SELECT instance_id, revoked_at, last_seen
    FROM pgstudio_license.devices
    WHERE license_key = ${key} AND instance_id = ${instanceId}
    LIMIT 1
  `;

  const wasRevoked = existing[0]?.revoked_at != null;
  const isNew = existing.length === 0;

  await db`
    INSERT INTO pgstudio_license.devices (license_key, instance_id, device_name, last_seen, revoked_at)
    VALUES (${key}, ${instanceId}, ${meta.deviceName || null}, now(), NULL)
    ON CONFLICT (license_key, instance_id) DO UPDATE SET
      last_seen = now(),
      revoked_at = NULL,
      device_name = COALESCE(EXCLUDED.device_name, pgstudio_license.devices.device_name)
  `;

  const source = meta.source || 'validate';
  if (isNew || wasRevoked) {
    await appendEvent(key, 'device_bound', { instance_id: instanceId }, source);
  } else {
    const lastSeen = isoToMs(existing[0].last_seen);
    if (!lastSeen || Date.now() - lastSeen >= VALIDATED_OK_SAMPLE_MS) {
      await appendEvent(key, 'validated_ok', { instance_id: instanceId }, source);
    }
  }

  return { bound: true, isNew: isNew || wasRevoked };
}

async function removeDevice(licenseKey, instanceId, meta = {}) {
  const key = normalizeKey(licenseKey);
  if (!key || !instanceId) return false;

  await ensureSchema();
  const db = getSql();
  const rows = await db`
    UPDATE pgstudio_license.devices
    SET revoked_at = now()
    WHERE license_key = ${key}
      AND instance_id = ${instanceId}
      AND revoked_at IS NULL
    RETURNING instance_id
  `;
  if (rows.length > 0) {
    await appendEvent(key, 'device_removed', { instance_id: instanceId }, meta.source || 'devices_api');
    return true;
  }
  return false;
}

async function listActiveDevices(licenseKey) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT instance_id, device_name, first_seen, last_seen
    FROM pgstudio_license.devices
    WHERE license_key = ${normalizeKey(licenseKey)}
      AND revoked_at IS NULL
    ORDER BY last_seen DESC
  `;
  return rows.map((r) => ({
    instanceId: r.instance_id,
    deviceName: r.device_name || null,
    firstSeen: isoToMs(r.first_seen),
    lastSeen: isoToMs(r.last_seen),
  }));
}

async function expirePastDueLicenses() {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    UPDATE pgstudio_license.licenses
    SET status = 'expired', updated_at = now()
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    RETURNING license_key, expires_at
  `;
  for (const row of rows) {
    await appendEvent(row.license_key, 'status_changed', {
      old_status: 'active',
      new_status: 'expired',
      expired_at: isoToMs(row.expires_at),
    }, 'cron');
  }
  return rows.length;
}

module.exports = {
  isConfigured,
  ensureSchema,
  getLicense,
  getLicenseBySubscription,
  getLicenseByEmail,
  upsertLicense,
  bindDevice,
  removeDevice,
  listActiveDevices,
  countActiveDevices,
  isDeviceActive,
  deviceLimitFor,
  appendEvent,
  getRecentEvents,
  countRenewals,
  recordWebhookEvent,
  expirePastDueLicenses,
  normalizeEmail,
  normalizeKey,
  rowToEntitlement,
};
