// Neon Postgres pool for NexQL Cloud sync storage.
// Connection URL: DATABASE_URL, POSTGRES_URL, or Vercel-prefixed variants (see db-url.js).

const { neon } = require('@neondatabase/serverless');
const { resolveDatabaseUrl } = require('./db-url');

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
      await db`
        CREATE SCHEMA IF NOT EXISTS pgstudio_sync
      `;
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_items (
          account_id   TEXT        NOT NULL,
          item_id      TEXT        NOT NULL,
          kind         TEXT        NOT NULL CHECK (kind IN ('connection','query','notebook','secrets')),
          blob         BYTEA       NOT NULL DEFAULT ''::bytea,
          content_hash TEXT        NOT NULL,
          revision     INT         NOT NULL DEFAULT 1,
          device_id    TEXT        NOT NULL,
          deleted      BOOLEAN     NOT NULL DEFAULT false,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (account_id, item_id)
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS sync_items_pull_idx
          ON pgstudio_sync.sync_items (account_id, updated_at)
      `;
      // Per-user X25519 public keys, keyed by email (team sharing identity).
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_identities (
          email      TEXT        PRIMARY KEY,
          account_id TEXT        NOT NULL,
          public_key TEXT        NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Shared items: each row is one item sealed to one grantee.
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_shares (
          share_id      TEXT        PRIMARY KEY,
          owner_email   TEXT        NOT NULL,
          grantee_email TEXT        NOT NULL,
          item_kind     TEXT        NOT NULL CHECK (item_kind IN ('query','notebook')),
          item_name     TEXT,
          share_blob    TEXT        NOT NULL,
          wrapped_key   TEXT        NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          revoked       BOOLEAN     NOT NULL DEFAULT false
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS sync_shares_grantee_idx
          ON pgstudio_sync.sync_shares (grantee_email) WHERE revoked = false
      `;
      await db`
        CREATE INDEX IF NOT EXISTS sync_shares_owner_idx
          ON pgstudio_sync.sync_shares (owner_email)
      `;
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_accounts (
          account_id     TEXT        PRIMARY KEY,
          tier           TEXT        NOT NULL DEFAULT 'sponsor',
          bytes_used     BIGINT      NOT NULL DEFAULT 0,
          item_count     INT         NOT NULL DEFAULT 0,
          inactive_since TIMESTAMPTZ,
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await db`
        ALTER TABLE pgstudio_sync.sync_accounts
        ADD COLUMN IF NOT EXISTS inactive_since TIMESTAMPTZ
      `;
      await db`
        CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_devices (
          account_id   TEXT        NOT NULL,
          device_id    TEXT        NOT NULL,
          device_name  TEXT,
          last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (account_id, device_id)
        )
      `;
      await db`
        CREATE INDEX IF NOT EXISTS sync_devices_account_idx
          ON pgstudio_sync.sync_devices (account_id, last_seen DESC)
      `;
    })();
  }
  return schemaReady;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function upsertIdentity(email, accountId, publicKey) {
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO pgstudio_sync.sync_identities (email, account_id, public_key, updated_at)
    VALUES (${normalizeEmail(email)}, ${accountId}, ${publicKey}, now())
    ON CONFLICT (email) DO UPDATE SET
      account_id = EXCLUDED.account_id,
      public_key = EXCLUDED.public_key,
      updated_at = now()
  `;
}

async function getPublicKey(email) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT public_key FROM pgstudio_sync.sync_identities
    WHERE email = ${normalizeEmail(email)} LIMIT 1
  `;
  return rows.length ? rows[0].public_key : null;
}

async function createShares(ownerEmail, granteeEmail, items) {
  await ensureSchema();
  const db = getSql();
  const owner = normalizeEmail(ownerEmail);
  const grantee = normalizeEmail(granteeEmail);
  const created = [];
  for (const item of items) {
    const shareId = item.share_id;
    await db`
      INSERT INTO pgstudio_sync.sync_shares (
        share_id, owner_email, grantee_email, item_kind, item_name, share_blob, wrapped_key
      ) VALUES (
        ${shareId}, ${owner}, ${grantee}, ${item.kind}, ${item.name || null},
        ${item.share_blob}, ${item.wrapped_key}
      )
      ON CONFLICT (share_id) DO UPDATE SET
        item_kind = EXCLUDED.item_kind,
        item_name = EXCLUDED.item_name,
        share_blob = EXCLUDED.share_blob,
        wrapped_key = EXCLUDED.wrapped_key,
        revoked = false
    `;
    created.push(shareId);
  }
  return created;
}

async function listSharesForGrantee(granteeEmail) {
  await ensureSchema();
  const db = getSql();
  return db`
    SELECT share_id, owner_email, item_kind, item_name, share_blob, wrapped_key, created_at
    FROM pgstudio_sync.sync_shares
    WHERE grantee_email = ${normalizeEmail(granteeEmail)} AND revoked = false
    ORDER BY created_at DESC
  `;
}

async function listSharesByOwner(ownerEmail) {
  await ensureSchema();
  const db = getSql();
  return db`
    SELECT share_id, grantee_email, item_kind, item_name, created_at, revoked
    FROM pgstudio_sync.sync_shares
    WHERE owner_email = ${normalizeEmail(ownerEmail)}
    ORDER BY created_at DESC
  `;
}

async function revokeShare(ownerEmail, shareId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    UPDATE pgstudio_sync.sync_shares
    SET revoked = true
    WHERE share_id = ${shareId} AND owner_email = ${normalizeEmail(ownerEmail)}
    RETURNING share_id
  `;
  return rows.length > 0;
}

async function listManifest(accountId, sinceRevision) {
  await ensureSchema();
  const db = getSql();
  if (sinceRevision) {
    return db`
      SELECT item_id, kind, content_hash, revision, device_id, deleted, updated_at
      FROM pgstudio_sync.sync_items
      WHERE account_id = ${accountId} AND revision > ${sinceRevision}
      ORDER BY updated_at ASC
    `;
  }
  return db`
    SELECT item_id, kind, content_hash, revision, device_id, deleted, updated_at
    FROM pgstudio_sync.sync_items
    WHERE account_id = ${accountId}
    ORDER BY updated_at ASC
  `;
}

async function getItemBlob(accountId, itemId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT blob FROM pgstudio_sync.sync_items
    WHERE account_id = ${accountId} AND item_id = ${itemId}
    LIMIT 1
  `;
  if (!rows.length) {
    return null;
  }
  const blob = rows[0].blob;
  return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
}

async function upsertItem(accountId, itemId, fields) {
  await ensureSchema();
  const db = getSql();
  const blob = fields.blob ?? Buffer.alloc(0);
  await db`
    INSERT INTO pgstudio_sync.sync_items (
      account_id, item_id, kind, blob, content_hash, revision, device_id, deleted, updated_at
    ) VALUES (
      ${accountId},
      ${itemId},
      ${fields.kind},
      ${blob},
      ${fields.content_hash},
      ${fields.revision},
      ${fields.device_id},
      ${fields.deleted},
      now()
    )
    ON CONFLICT (account_id, item_id) DO UPDATE SET
      kind = EXCLUDED.kind,
      blob = CASE WHEN EXCLUDED.blob = ''::bytea THEN pgstudio_sync.sync_items.blob ELSE EXCLUDED.blob END,
      content_hash = EXCLUDED.content_hash,
      revision = EXCLUDED.revision,
      device_id = EXCLUDED.device_id,
      deleted = EXCLUDED.deleted,
      updated_at = now()
  `;
}

async function upsertManifestMeta(accountId, entries) {
  await ensureSchema();
  for (const entry of entries) {
    await upsertItem(accountId, entry.id, {
      kind: entry.kind,
      blob: Buffer.alloc(0),
      content_hash: entry.contentHash,
      revision: entry.revision,
      device_id: entry.deviceId,
      deleted: !!entry.deleted,
    });
  }
  await refreshAccountQuota(accountId);
}

async function refreshAccountQuota(accountId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT
      COALESCE(SUM(octet_length(blob)), 0)::bigint AS bytes_used,
      COUNT(*) FILTER (WHERE NOT deleted)::int AS item_count
    FROM pgstudio_sync.sync_items
    WHERE account_id = ${accountId}
  `;
  const stats = rows[0] || { bytes_used: 0, item_count: 0 };
  await db`
    INSERT INTO pgstudio_sync.sync_accounts (account_id, bytes_used, item_count, updated_at)
    VALUES (${accountId}, ${stats.bytes_used}, ${stats.item_count}, now())
    ON CONFLICT (account_id) DO UPDATE SET
      bytes_used = EXCLUDED.bytes_used,
      item_count = EXCLUDED.item_count,
      updated_at = now()
  `;
}

async function getAccountQuota(accountId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT tier, bytes_used, item_count, updated_at
    FROM pgstudio_sync.sync_accounts
    WHERE account_id = ${accountId}
    LIMIT 1
  `;
  if (!rows.length) {
    await refreshAccountQuota(accountId);
    const again = await db`
      SELECT tier, bytes_used, item_count, updated_at
      FROM pgstudio_sync.sync_accounts
      WHERE account_id = ${accountId}
      LIMIT 1
    `;
    return again[0] || { tier: 'sponsor', bytes_used: 0, item_count: 0, updated_at: new Date() };
  }
  return rows[0];
}

async function setAccountTier(accountId, tier) {
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO pgstudio_sync.sync_accounts (account_id, tier, updated_at)
    VALUES (${accountId}, ${tier}, now())
    ON CONFLICT (account_id) DO UPDATE SET
      tier = EXCLUDED.tier,
      updated_at = now()
  `;
}

async function upsertDevice(accountId, deviceId, deviceName) {
  if (!deviceId) {
    return;
  }
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO pgstudio_sync.sync_devices (account_id, device_id, device_name, last_seen)
    VALUES (${accountId}, ${deviceId}, ${deviceName || null}, now())
    ON CONFLICT (account_id, device_id) DO UPDATE SET
      device_name = COALESCE(EXCLUDED.device_name, pgstudio_sync.sync_devices.device_name),
      last_seen = now()
  `;
}

async function listDevices(accountId) {
  await ensureSchema();
  const db = getSql();
  return db`
    SELECT device_id, device_name, last_seen
    FROM pgstudio_sync.sync_devices
    WHERE account_id = ${accountId}
    ORDER BY last_seen DESC
  `;
}

async function revokeDevice(accountId, deviceId) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    DELETE FROM pgstudio_sync.sync_devices
    WHERE account_id = ${accountId} AND device_id = ${deviceId}
    RETURNING device_id
  `;
  return rows.length > 0;
}

const { CLOUD_INACTIVE_RETENTION_DAYS } = require('./sync-retention');

/** Mark cloud storage inactive (license lapsed). Retains prior inactive_since if already set. */
async function markAccountInactive(accountId) {
  if (!accountId) {
    return;
  }
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO pgstudio_sync.sync_accounts (account_id, inactive_since, updated_at)
    VALUES (${accountId}, now(), now())
    ON CONFLICT (account_id) DO UPDATE SET
      inactive_since = COALESCE(pgstudio_sync.sync_accounts.inactive_since, now()),
      updated_at = now()
  `;
}

/** Clear inactive flag when paid sync access is restored. */
async function markAccountActive(accountId) {
  if (!accountId) {
    return;
  }
  await ensureSchema();
  const db = getSql();
  await db`
    UPDATE pgstudio_sync.sync_accounts
    SET inactive_since = NULL, updated_at = now()
    WHERE account_id = ${accountId}
  `;
}

async function deleteAccountCloudData(accountId, ownerEmail) {
  await ensureSchema();
  const db = getSql();
  await db`DELETE FROM pgstudio_sync.sync_items WHERE account_id = ${accountId}`;
  await db`DELETE FROM pgstudio_sync.sync_devices WHERE account_id = ${accountId}`;
  if (ownerEmail) {
    const email = String(ownerEmail).trim().toLowerCase();
    await db`DELETE FROM pgstudio_sync.sync_shares WHERE owner_email = ${email}`;
  }
  await db`DELETE FROM pgstudio_sync.sync_accounts WHERE account_id = ${accountId}`;
}

/** Remove cloud blobs for accounts inactive longer than {@link CLOUD_INACTIVE_RETENTION_DAYS}. */
async function purgeInactiveCloudData() {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT account_id
    FROM pgstudio_sync.sync_accounts
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
  listManifest,
  getItemBlob,
  upsertItem,
  upsertManifestMeta,
  upsertIdentity,
  getPublicKey,
  createShares,
  listSharesForGrantee,
  listSharesByOwner,
  revokeShare,
  refreshAccountQuota,
  getAccountQuota,
  setAccountTier,
  upsertDevice,
  listDevices,
  revokeDevice,
  markAccountInactive,
  markAccountActive,
  purgeInactiveCloudData,
};
