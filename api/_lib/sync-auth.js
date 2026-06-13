// Device authorization + bearer tokens for NexQL Cloud sync.
// Pending device codes live in KV; issued tokens are hashed at rest.

const crypto = require('crypto');
const store = require('./store');

const DEVICE_PREFIX = 'sync:dev:';
const USER_CODE_PREFIX = 'sync:usercode:';
const TOKEN_PREFIX = 'sync:tok:';

const DEVICE_TTL_SEC = 900;
const ACCESS_TTL_SEC = 60 * 60;
const REFRESH_TTL_SEC = 90 * 24 * 60 * 60;

const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return `nxq_${crypto.randomBytes(32).toString('base64url')}`;
}

function formatUserCode() {
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
    if (i === 3) {
      code += '-';
    }
  }
  return code;
}

function publicBaseUrl() {
  return (process.env.SYNC_PUBLIC_BASE_URL || 'https://nexql.astrx.dev').replace(/\/$/, '');
}

async function kvGet(key) {
  return store.rawGet(key);
}

async function kvSet(key, value, ttlSec) {
  return store.rawSet(key, value, ttlSec);
}

async function kvDel(key) {
  return store.rawDel(key);
}

function isActivePaid(ent) {
  return (
    ent
    && (ent.tier === 'sponsor' || ent.tier === 'singularity')
    && ent.status === 'active'
    && (!ent.expiresAt || ent.expiresAt > Date.now())
  );
}

async function validateLicenseKey(licenseKey) {
  const ent = await store.getEntitlement(licenseKey);
  if (!isActivePaid(ent)) {
    return { ok: false, error: 'NexQL Cloud Sync requires an active Sponsor or Teams license.' };
  }
  return { ok: true, entitlement: ent };
}

async function startDeviceAuth() {
  const deviceCode = crypto.randomBytes(24).toString('hex');
  const userCode = formatUserCode();
  const entry = {
    device_code: deviceCode,
    user_code: userCode,
    authorized: false,
    account_id: null,
    email: null,
    created_at: Date.now(),
  };

  await kvSet(DEVICE_PREFIX + deviceCode, entry, DEVICE_TTL_SEC);
  await kvSet(USER_CODE_PREFIX + userCode, deviceCode, DEVICE_TTL_SEC);

  const verifyBase = `${publicBaseUrl()}/device-auth.html`;
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verifyBase,
    verification_uri_complete: `${verifyBase}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_TTL_SEC,
    interval: 5,
  };
}

async function getPendingByUserCode(userCode) {
  const normalizedCode = String(userCode || '').trim().toUpperCase();
  const deviceCode = await kvGet(USER_CODE_PREFIX + normalizedCode);
  if (!deviceCode) {
    return null;
  }
  const pending = await kvGet(DEVICE_PREFIX + deviceCode);
  if (!pending) {
    return null;
  }
  return { normalizedCode, deviceCode, pending };
}

async function getDeviceAuthStatus(userCode) {
  const found = await getPendingByUserCode(userCode);
  if (!found) {
    return { ok: false, error: 'Invalid or expired user code.' };
  }
  const { pending } = found;
  const remaining = DEVICE_TTL_SEC - Math.floor((Date.now() - pending.created_at) / 1000);
  return {
    ok: true,
    bound: !!pending.license_bound,
    tier: pending.tier || null,
    device_name: pending.device_name || null,
    expires_in: Math.max(0, remaining),
  };
}

async function bindDeviceLicense(deviceCode, licenseKey, instanceId, deviceName) {
  const pending = await kvGet(DEVICE_PREFIX + deviceCode);
  if (!pending) {
    return { ok: false, error: 'Device authorization session expired.' };
  }

  const license = await validateLicenseKey(String(licenseKey || '').trim());
  if (!license.ok) {
    return { ok: false, error: license.error };
  }

  if (instanceId) {
    const bound = await bindLicenseInstance(license.entitlement.licenseKey, instanceId);
    if (!bound.ok) {
      return { ok: false, error: bound.error };
    }
  }

  pending.license_bound = true;
  pending.account_id = license.entitlement.licenseKey;
  pending.email = license.entitlement.email || null;
  pending.tier = license.entitlement.tier || 'sponsor';
  if (deviceName) {
    pending.device_name = String(deviceName);
  }
  await kvSet(DEVICE_PREFIX + deviceCode, pending, DEVICE_TTL_SEC);
  return { ok: true, tier: pending.tier, email: pending.email };
}

async function bindLicenseInstance(licenseKey, instanceId) {
  const ent = await store.getEntitlement(licenseKey);
  if (!ent) {
    return { ok: false, error: 'License not found.' };
  }

  const known = await store.isDeviceActive(licenseKey, instanceId);
  if (!known) {
    const count = await store.countActiveDevices(licenseKey);
    const limit = store.licenseDb.deviceLimitFor(ent.tier);
    if (count >= limit) {
      return { ok: false, error: 'Device limit reached for this license.' };
    }
  }

  try {
    await store.bindDevice(licenseKey, instanceId, { source: 'sync_auth' });
  } catch (err) {
    console.error('sync-auth: bindDevice failed', err);
    return { ok: false, error: 'Failed to bind device.' };
  }
  return { ok: true };
}

async function createSessionFromLicense(licenseKey, instanceId, deviceId, deviceName) {
  const license = await validateLicenseKey(String(licenseKey || '').trim());
  if (!license.ok) {
    return { ok: false, error: license.error };
  }

  if (instanceId) {
    const bound = await bindLicenseInstance(license.entitlement.licenseKey, instanceId);
    if (!bound.ok) {
      return { ok: false, error: bound.error };
    }
  }

  const accountId = license.entitlement.licenseKey;
  const access = await storeToken(accountId, 'access', ACCESS_TTL_SEC);
  const refresh = await storeToken(accountId, 'refresh', REFRESH_TTL_SEC);

  const { upsertDevice, setAccountTier } = require('./sync-db');
  await setAccountTier(accountId, license.entitlement.tier || 'sponsor');
  if (deviceId) {
    await upsertDevice(accountId, String(deviceId), deviceName ? String(deviceName) : undefined);
  }

  return {
    ok: true,
    access_token: access.token,
    refresh_token: refresh.token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
    email: license.entitlement.email || null,
    tier: license.entitlement.tier || 'sponsor',
  };
}

async function authorizeDevice(userCode, licenseKey) {
  const found = await getPendingByUserCode(userCode);
  if (!found) {
    return { ok: false, error: 'Invalid or expired user code.' };
  }

  const { deviceCode, pending } = found;

  if (pending.license_bound && pending.account_id) {
    pending.authorized = true;
    await kvSet(DEVICE_PREFIX + deviceCode, pending, DEVICE_TTL_SEC);
    return { ok: true, email: pending.email || null };
  }

  if (!licenseKey) {
    return { ok: false, error: 'License key is required for this authorization session.' };
  }

  const license = await validateLicenseKey(String(licenseKey || '').trim());
  if (!license.ok) {
    return { ok: false, error: license.error };
  }

  pending.authorized = true;
  pending.account_id = license.entitlement.licenseKey;
  pending.email = license.entitlement.email || null;
  pending.tier = license.entitlement.tier || 'sponsor';
  await kvSet(DEVICE_PREFIX + deviceCode, pending, DEVICE_TTL_SEC);
  return { ok: true, email: pending.email };
}

async function storeToken(accountId, tokenType, ttlSec) {
  const token = randomToken();
  const record = {
    account_id: accountId,
    token_type: tokenType,
    expires_at: Date.now() + ttlSec * 1000,
  };
  await kvSet(TOKEN_PREFIX + sha256(token), record, ttlSec);
  return { token, expires_in: ttlSec };
}

async function pollDeviceToken(deviceCode) {
  const pending = await kvGet(DEVICE_PREFIX + deviceCode);
  if (!pending) {
    return { error: 'expired_token', error_description: 'Device authorization expired' };
  }
  if (!pending.authorized || !pending.account_id) {
    return { error: 'authorization_pending' };
  }

  const access = await storeToken(pending.account_id, 'access', ACCESS_TTL_SEC);
  const refresh = await storeToken(pending.account_id, 'refresh', REFRESH_TTL_SEC);

  await kvDel(DEVICE_PREFIX + deviceCode);
  if (pending.user_code) {
    await kvDel(USER_CODE_PREFIX + pending.user_code);
  }

  return {
    access_token: access.token,
    refresh_token: refresh.token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
    email: pending.email || null,
  };
}

async function refreshAccessToken(refreshToken) {
  const record = await kvGet(TOKEN_PREFIX + sha256(refreshToken));
  if (!record || record.token_type !== 'refresh' || record.expires_at <= Date.now()) {
    return { error: 'invalid_grant' };
  }

  const license = await validateLicenseKey(record.account_id);
  if (!license.ok) {
    return { error: 'invalid_grant', error_description: license.error };
  }

  await kvDel(TOKEN_PREFIX + sha256(refreshToken));
  const access = await storeToken(record.account_id, 'access', ACCESS_TTL_SEC);
  const refresh = await storeToken(record.account_id, 'refresh', REFRESH_TTL_SEC);

  return {
    access_token: access.token,
    refresh_token: refresh.token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
  };
}

async function authenticateBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  const record = await kvGet(TOKEN_PREFIX + sha256(token));
  if (!record || record.token_type !== 'access' || record.expires_at <= Date.now()) {
    return null;
  }

  const license = await validateLicenseKey(record.account_id);
  if (!license.ok) {
    return null;
  }

  const { upsertDevice, setAccountTier } = require('./sync-db');
  await setAccountTier(record.account_id, license.entitlement.tier || 'sponsor');

  const deviceId = req.headers['x-device-id'] || req.headers['X-Device-Id'];
  const deviceName = req.headers['x-device-name'] || req.headers['X-Device-Name'];
  if (deviceId) {
    await upsertDevice(record.account_id, String(deviceId), deviceName ? String(deviceName) : undefined);
  }

  return {
    account_id: record.account_id,
    email: license.entitlement.email || null,
    tier: license.entitlement.tier || 'sponsor',
  };
}

module.exports = {
  startDeviceAuth,
  authorizeDevice,
  pollDeviceToken,
  refreshAccessToken,
  authenticateBearer,
  getDeviceAuthStatus,
  bindDeviceLicense,
  createSessionFromLicense,
};
