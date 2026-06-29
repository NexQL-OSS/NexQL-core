// Neon Postgres pool for NexQL Cloud sync storage (sync v2 — git-like).
// Connection URL: DATABASE_URL, POSTGRES_URL, or Vercel-prefixed variants (see db-url.js).
//
// Model: each "space" is one sync stream. Personal space_id === account_id;
// shared spaces have a generated id + member roster. Every write stamps a row
// with a monotonic `version` drawn from cursor_seq. Pull returns everything past
// a client cursor (upserts + permanent deletes). Push is an atomic batch with
// per-item optimistic concurrency (compare-and-swap on version).

const { neon } = require('@neondatabase/serverless');
const { resolveDatabaseUrl } = require('./db-url');
const { CLOUD_INACTIVE_RETENTION_DAYS } = require('./sync-retention');

let sql = null;
let schemaReady = null;

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

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getSql();
      await db`CREATE SCHEMA IF NOT EXISTS nexql_sync`;
      await db`CREATE SEQUENCE IF NOT EXISTS nexql_sync.cursor_seq`;
      await db`
        CREATE TABLE IF NOT EXISTS nexql_sync.items_v2 (
          space_id     TEXT        NOT NULL,
          item_id      TEXT        NOT NULL,
          kind         TEXT        NOT NULL CHECK (kind IN ('connection','query','notebook')),
          blob         BYTEA       NOT NULL,
          content_hash TEXT        NOT NULL,
          version      BIGINT      NOT NULL,
          device_id    TEXT        NOT NULL,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (space_id, item_id)
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS items_v2_cursor_idx
          ON nexql_sync.items_v2 (space_id, version)
      `;
      // Permanent delete log — never pruned. Stops deleted items resurrecting.
      await db`
        CREATE TABLE IF NOT EXISTS nexql_sync.deletes_v2 (
          space_id   TEXT        NOT NULL,
          item_id    TEXT        NOT NULL,
          version    BIGINT      NOT NULL,
          deleted_by TEXT        NOT NULL,
          deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (space_id, item_id)
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS deletes_v2_cursor_idx
          ON nexql_sync.deletes_v2 (space_id, version)
      `;
      // Shared workspaces (team sharing). Personal space rows are implicit.
      await db`
        CREATE TABLE IF NOT EXISTS nexql_sync.spaces (
          space_id    TEXT        PRIMARY KEY,
          name        TEXT        NOT NULL,
          owner_email TEXT        NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await db`
        CREATE TABLE IF NOT EXISTS nexql_sync.space_members (
          space_id TEXT        NOT NULL REFERENCES nexql_sync.spaces(space_id) ON DELETE CASCADE,
          email    TEXT        NOT NULL,
          role     TEXT        NOT NULL CHECK (role IN ('owner','editor','viewer')),
          added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (space_id, email)
        )
      `;
      await db`
        CREATE TABLE IF NOT EXISTS nexql_sync.sync_accounts (
          account_id     TEXT        PRIMARY KEY,
          tier           TEXT        NOT NULL DEFAULT 'sponsor',
          bytes_used     BIGINT      NOT NULL DEFAULT 0,
          item_count     INT         NOT NULL DEFAULT 0,
          inactive_since TIMESTAMPTZ,
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Migrate sync_accounts created by older deploys — CREATE TABLE IF NOT EXISTS
      // never alters an existing table, so newer columns must be added explicitly.
      await db`ALTER TABLE nexql_sync.sync_accounts ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'sponsor'`;
      await db`ALTER TABLE nexql_sync.sync_accounts ADD COLUMN IF NOT EXISTS bytes_used BIGINT NOT NULL DEFAULT 0`;
      await db`ALTER TABLE nexql_sync.sync_accounts ADD COLUMN IF NOT EXISTS item_count INT NOT NULL DEFAULT 0`;
      await db`ALTER TABLE nexql_sync.sync_accounts ADD COLUMN IF NOT EXISTS inactive_since TIMESTAMPTZ`;
      await db`ALTER TABLE nexql_sync.sync_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
      await db`
        CREATE TABLE IF NOT EXISTS nexql_sync.sync_devices (
          account_id   TEXT        NOT NULL,
          device_id    TEXT        NOT NULL,
          device_name  TEXT,
          last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (account_id, device_id)
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS sync_devices_account_idx
          ON nexql_sync.sync_devices (account_id, last_seen DESC)
      `;
    })();
  }
  return schemaReady;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function toBuffer(blob) {
  return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
}

// ── Delta sync ──────────────────────────────────────────────────────────────

/** Highest version stamped in a space across items + deletes (the sync cursor). */
async function spaceCursor(spaceId) {
  const db = getSql();
  const rows = await db`
    SELECT GREATEST(
      COALESCE((SELECT MAX(version) FROM nexql_sync.items_v2   WHERE space_id = ${spaceId}), 0),
      COALESCE((SELECT MAX(version) FROM nexql_sync.deletes_v2 WHERE space_id = ${spaceId}), 0)
    ) AS cursor
  `;
  return Number(rows[0]?.cursor || 0);
}

/** Everything changed in a space since `since` (0 = full snapshot). Blobs inline (base64). */
async function pullDelta(spaceId, since) {
  await ensureSchema();
  const db = getSql();
  const sinceVersion = Number.isFinite(since) ? Number(since) : 0;

  const itemRows = await db`
    SELECT item_id, kind, content_hash, version, device_id,
           encode(blob, 'base64') AS blob,
           updated_at
    FROM nexql_sync.items_v2
    WHERE space_id = ${spaceId} AND version > ${sinceVersion}
    ORDER BY version ASC
  `;
  const deleteRows = await db`
    SELECT item_id, version
    FROM nexql_sync.deletes_v2
    WHERE space_id = ${spaceId} AND version > ${sinceVersion}
    ORDER BY version ASC
  `;
  const cursor = await spaceCursor(spaceId);

  return {
    cursor,
    upserts: itemRows.map((r) => ({
      item_id: r.item_id,
      kind: r.kind,
      content_hash: r.content_hash,
      version: Number(r.version),
      device_id: r.device_id,
      blob: r.blob,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
    })),
    deletes: deleteRows.map((r) => r.item_id),
  };
}

/**
 * Atomic batch push with per-item optimistic concurrency.
 *
 * Each op carries `base_version` (the version the client last saw). An upsert is
 * accepted when the server row is unchanged since (`version <= base_version`) or
 * the content is identical (idempotent). Otherwise it is rejected and the server
 * row is returned so the client can resolve last-writer-wins, then re-push.
 * A delete is accepted when the row is unchanged since base_version, or absent.
 *
 * The whole batch runs in one transaction: the cursor advances all-or-nothing.
 */
async function pushBatch(spaceId, deviceId, ops) {
  await ensureSchema();
  const db = getSql();
  const device = String(deviceId || '');

  const queries = ops.map((op) => {
    const baseVersion = Number(op.base_version) || 0;
    if (op.op === 'delete') {
      return db`
        WITH existing AS (
          SELECT version FROM nexql_sync.items_v2
          WHERE space_id = ${spaceId} AND item_id = ${op.item_id}
        ), del AS (
          DELETE FROM nexql_sync.items_v2
          WHERE space_id = ${spaceId} AND item_id = ${op.item_id} AND version <= ${baseVersion}
          RETURNING item_id
        ), logged AS (
          INSERT INTO nexql_sync.deletes_v2 (space_id, item_id, version, deleted_by, deleted_at)
          SELECT ${spaceId}, ${op.item_id}, nextval('nexql_sync.cursor_seq'), ${device}, now()
          WHERE EXISTS (SELECT 1 FROM del) OR NOT EXISTS (SELECT 1 FROM existing)
          ON CONFLICT (space_id, item_id) DO UPDATE
            SET version = nextval('nexql_sync.cursor_seq'), deleted_by = EXCLUDED.deleted_by, deleted_at = now()
          RETURNING version
        )
        SELECT ${op.item_id} AS item_id,
               (SELECT version FROM logged)   AS new_version,
               (SELECT version FROM existing) AS remote_version,
               NULL::text                     AS remote_hash
      `;
    }
    const blob = Buffer.from(String(op.blob || ''), 'base64');
    return db`
      WITH existing AS (
        SELECT version, content_hash FROM nexql_sync.items_v2
        WHERE space_id = ${spaceId} AND item_id = ${op.item_id}
      ), up AS (
        INSERT INTO nexql_sync.items_v2
          (space_id, item_id, kind, blob, content_hash, version, device_id, updated_at)
        VALUES
          (${spaceId}, ${op.item_id}, ${op.kind}, ${blob}, ${op.content_hash},
           nextval('nexql_sync.cursor_seq'), ${device}, now())
        ON CONFLICT (space_id, item_id) DO UPDATE
          SET kind = EXCLUDED.kind, blob = EXCLUDED.blob, content_hash = EXCLUDED.content_hash,
              version = nextval('nexql_sync.cursor_seq'), device_id = EXCLUDED.device_id, updated_at = now()
          WHERE nexql_sync.items_v2.version <= ${baseVersion}
             OR nexql_sync.items_v2.content_hash = EXCLUDED.content_hash
        RETURNING version
      )
      SELECT ${op.item_id} AS item_id,
             (SELECT version FROM up)                AS new_version,
             (SELECT version FROM existing)          AS remote_version,
             (SELECT content_hash FROM existing)     AS remote_hash
    `;
  });

  const results = queries.length ? await db.transaction(queries) : [];
  const accepted = [];
  const rejected = [];
  results.forEach((rows, i) => {
    const row = Array.isArray(rows) ? rows[0] : rows;
    const op = ops[i];
    if (row && row.new_version != null) {
      accepted.push({ item_id: op.item_id, version: Number(row.new_version) });
    } else {
      rejected.push({
        item_id: op.item_id,
        remote_version: row && row.remote_version != null ? Number(row.remote_version) : null,
        remote_hash: row ? row.remote_hash : null,
      });
    }
  });

  const cursor = await spaceCursor(spaceId);
  if (spaceId) {
    await refreshAccountQuota(spaceId);
  }
  return { cursor, accepted, rejected };
}

/** Wipe a space (items + deletes). Powers "clear cloud & push". */
async function resetSpace(spaceId) {
  await ensureSchema();
  const db = getSql();
  await db`DELETE FROM nexql_sync.items_v2   WHERE space_id = ${spaceId}`;
  await db`DELETE FROM nexql_sync.deletes_v2 WHERE space_id = ${spaceId}`;
  await refreshAccountQuota(spaceId);
}

// ── Shared workspaces ─────────────────────────────────────────────────────────

async function createSpace(spaceId, name, ownerEmail) {
  await ensureSchema();
  const db = getSql();
  const owner = normalizeEmail(ownerEmail);
  await db`
    INSERT INTO nexql_sync.spaces (space_id, name, owner_email)
    VALUES (${spaceId}, ${name}, ${owner})
    ON CONFLICT (space_id) DO UPDATE SET name = EXCLUDED.name
  `;
  await db`
    INSERT INTO nexql_sync.space_members (space_id, email, role)
    VALUES (${spaceId}, ${owner}, 'owner')
    ON CONFLICT (space_id, email) DO UPDATE SET role = 'owner'
  `;
}

async function listSpacesForEmail(email) {
  await ensureSchema();
  const db = getSql();
  return db`
    SELECT s.space_id, s.name, s.owner_email, m.role
    FROM nexql_sync.space_members m
    JOIN nexql_sync.spaces s ON s.space_id = m.space_id
    WHERE m.email = ${normalizeEmail(email)}
    ORDER BY s.created_at ASC
  `;
}

async function listMembers(spaceId) {
  await ensureSchema();
  const db = getSql();
  return db`
    SELECT email, role, added_at FROM nexql_sync.space_members
    WHERE space_id = ${spaceId} ORDER BY added_at ASC
  `;
}

async function addMember(spaceId, email, role) {
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO nexql_sync.space_members (space_id, email, role)
    VALUES (${spaceId}, ${normalizeEmail(email)}, ${role})
    ON CONFLICT (space_id, email) DO UPDATE SET role = EXCLUDED.role
  `;
}

async function removeMember(spaceId, email) {
  await ensureSchema();
  const db = getSql();
  await db`
    DELETE FROM nexql_sync.space_members
    WHERE space_id = ${spaceId} AND email = ${normalizeEmail(email)} AND role <> 'owner'
  `;
}

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

/** Resolve the caller's role in a space. Personal space (id === account_id) is always owner. */
async function memberRole(spaceId, email, accountId) {
  if (spaceId === accountId) {
    return 'owner';
  }
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT role FROM nexql_sync.space_members
    WHERE space_id = ${spaceId} AND email = ${normalizeEmail(email)} LIMIT 1
  `;
  return rows.length ? rows[0].role : null;
}

/** Non-personal spaces require a singularity (Teams) license at access time. */
function requireTeamTierIfShared(space, auth) {
  if (space !== auth.account_id && auth.tier !== 'singularity') {
    return { status: 402, error: 'Team workspaces require a Teams license' };
  }
  return null;
}

/** True when the caller holds at least `minRole` in the space. */
async function assertSpaceMember(spaceId, email, accountId, minRole) {
  const role = await memberRole(spaceId, email, accountId);
  if (!role) {
    return false;
  }
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

// ── Quota / tier / devices ────────────────────────────────────────────────────

async function refreshAccountQuota(accountId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT COALESCE(SUM(octet_length(blob)), 0)::bigint AS bytes_used,
           COUNT(*)::int AS item_count
    FROM nexql_sync.items_v2
    WHERE space_id = ${accountId}
  `;
  const stats = rows[0] || { bytes_used: 0, item_count: 0 };
  await db`
    INSERT INTO nexql_sync.sync_accounts (account_id, bytes_used, item_count, updated_at)
    VALUES (${accountId}, ${stats.bytes_used}, ${stats.item_count}, now())
    ON CONFLICT (account_id) DO UPDATE SET
      bytes_used = EXCLUDED.bytes_used, item_count = EXCLUDED.item_count, updated_at = now()
  `;
}

async function getAccountQuota(accountId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT tier, bytes_used, item_count, updated_at
    FROM nexql_sync.sync_accounts WHERE account_id = ${accountId} LIMIT 1
  `;
  if (!rows.length) {
    await refreshAccountQuota(accountId);
    const again = await db`
      SELECT tier, bytes_used, item_count, updated_at
      FROM nexql_sync.sync_accounts WHERE account_id = ${accountId} LIMIT 1
    `;
    return again[0] || { tier: 'sponsor', bytes_used: 0, item_count: 0, updated_at: new Date() };
  }
  return rows[0];
}

async function setAccountTier(accountId, tier) {
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO nexql_sync.sync_accounts (account_id, tier, updated_at)
    VALUES (${accountId}, ${tier}, now())
    ON CONFLICT (account_id) DO UPDATE SET tier = EXCLUDED.tier, updated_at = now()
  `;
}

async function upsertDevice(accountId, deviceId, deviceName) {
  if (!deviceId) {
    return;
  }
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO nexql_sync.sync_devices (account_id, device_id, device_name, last_seen)
    VALUES (${accountId}, ${deviceId}, ${deviceName || null}, now())
    ON CONFLICT (account_id, device_id) DO UPDATE SET
      device_name = CASE
        WHEN EXCLUDED.device_name IS NOT NULL THEN EXCLUDED.device_name
        ELSE nexql_sync.sync_devices.device_name
      END,
      last_seen = now()
  `;
}

async function updateDeviceName(accountId, deviceId, deviceName) {
  if (!deviceId) {
    return false;
  }
  const trimmed = String(deviceName || '').trim();
  if (!trimmed) {
    return false;
  }
  await upsertDevice(accountId, deviceId, trimmed);
  return true;
}

async function listDevices(accountId) {
  await ensureSchema();
  const db = getSql();
  return db`
    SELECT device_id, device_name, last_seen FROM nexql_sync.sync_devices
    WHERE account_id = ${accountId} ORDER BY last_seen DESC
  `;
}

async function revokeDevice(accountId, deviceId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    DELETE FROM nexql_sync.sync_devices
    WHERE account_id = ${accountId} AND device_id = ${deviceId} RETURNING device_id
  `;
  return rows.length > 0;
}

async function markAccountInactive(accountId) {
  if (!accountId) {
    return;
  }
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO nexql_sync.sync_accounts (account_id, inactive_since, updated_at)
    VALUES (${accountId}, now(), now())
    ON CONFLICT (account_id) DO UPDATE SET
      inactive_since = COALESCE(nexql_sync.sync_accounts.inactive_since, now()), updated_at = now()
  `;
}

async function markAccountActive(accountId) {
  if (!accountId) {
    return;
  }
  await ensureSchema();
  const db = getSql();
  await db`
    UPDATE nexql_sync.sync_accounts SET inactive_since = NULL, updated_at = now()
    WHERE account_id = ${accountId}
  `;
}

async function deleteAccountCloudData(accountId, ownerEmail) {
  await ensureSchema();
  const db = getSql();
  await db`DELETE FROM nexql_sync.items_v2   WHERE space_id = ${accountId}`;
  await db`DELETE FROM nexql_sync.deletes_v2 WHERE space_id = ${accountId}`;
  await db`DELETE FROM nexql_sync.sync_devices WHERE account_id = ${accountId}`;
  if (ownerEmail) {
    const email = normalizeEmail(ownerEmail);
    await db`DELETE FROM nexql_sync.spaces WHERE owner_email = ${email}`;
  }
  await db`DELETE FROM nexql_sync.sync_accounts WHERE account_id = ${accountId}`;
}

/** Remove cloud blobs for accounts inactive longer than {@link CLOUD_INACTIVE_RETENTION_DAYS}. */
async function purgeInactiveCloudData() {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT account_id FROM nexql_sync.sync_accounts
    WHERE inactive_since IS NOT NULL
      AND inactive_since < now() - (${CLOUD_INACTIVE_RETENTION_DAYS} * interval '1 day')
  `;
  if (!rows.length) {
    return 0;
  }
  const store = require('./store');
  let purged = 0;
  for (const row of rows) {
    let ownerEmail = null;
    try {
      const ent = await store.getEntitlement(row.account_id);
      ownerEmail = ent?.email ?? null;
    } catch (err) {
      console.error('purgeInactiveCloudData: entitlement lookup failed', row.account_id, err);
    }
    await deleteAccountCloudData(row.account_id, ownerEmail);
    purged += 1;
  }
  return purged;
}

module.exports = {
  ensureSchema,
  pullDelta,
  pushBatch,
  resetSpace,
  spaceCursor,
  createSpace,
  listSpacesForEmail,
  listMembers,
  addMember,
  removeMember,
  memberRole,
  requireTeamTierIfShared,
  assertSpaceMember,
  refreshAccountQuota,
  getAccountQuota,
  setAccountTier,
  upsertDevice,
  updateDeviceName,
  listDevices,
  revokeDevice,
  markAccountInactive,
  markAccountActive,
  deleteAccountCloudData,
  purgeInactiveCloudData,
};
