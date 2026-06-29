// Entitlement store abstraction.
//
// Primary store: Neon Postgres (nexql_license schema) when DATABASE_URL is set.
// Legacy dual-write: Vercel KV (Upstash Redis) when KV_REST_API_URL is present.
// Dev fallback: local JSON file (.kv-dev.json at repo root) when neither is configured.
//
// Keys (KV only):
//   ent:<licenseKey>      -> entitlement object
//   sub:<subscriptionId>  -> licenseKey pointer
//   email:<email>         -> licenseKey pointer
//
// Entitlement shape (public API — unchanged for callers):
//   {
//     licenseKey, tier, period, currency,
//     status: 'active' | 'cancelled' | 'halted' | 'paused' | 'expired' | 'revoked',
//     subscriptionId, email,
//     expiresAt,        // unix ms
//     createdAt,        // unix ms
//     instanceIds: []   // bound VS Code machine ids
//   }

const path = require('path');
const fs = require('fs');
const licenseDb = require('./license-db');

const ENT_PREFIX = 'ent:';
const SUB_PREFIX = 'sub:';
const EMAIL_PREFIX = 'email:';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const useNeon = licenseDb.isConfigured();
const useKv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

let kvClient = null;
function kv() {
  if (!kvClient) {
    kvClient = require('@vercel/kv').kv;
  }
  return kvClient;
}

// ---- Local file fallback (dev/test only) --------------------------------

const DEV_STORE_PATH = path.join(__dirname, '..', '..', '.kv-dev.json');

function readDevStore() {
  try {
    return JSON.parse(fs.readFileSync(DEV_STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeDevStore(data) {
  fs.writeFileSync(DEV_STORE_PATH, JSON.stringify(data, null, 2));
}

async function rawGet(key) {
  if (useKv) {
    return (await kv().get(key)) || null;
  }
  const store = readDevStore();
  const entry = store[key];
  if (!entry) {
    return null;
  }
  if (entry && typeof entry === 'object' && 'expiresAt' in entry && 'value' in entry) {
    if (entry.expiresAt <= Date.now()) {
      delete store[key];
      writeDevStore(store);
      return null;
    }
    return entry.value;
  }
  return entry;
}

async function rawSet(key, value, ttlSec) {
  if (useKv) {
    if (ttlSec && ttlSec > 0) {
      await kv().set(key, value, { ex: ttlSec });
    } else {
      await kv().set(key, value);
    }
    return;
  }
  const store = readDevStore();
  store[key] = ttlSec && ttlSec > 0
    ? { value, expiresAt: Date.now() + ttlSec * 1000 }
    : value;
  writeDevStore(store);
}

async function rawDel(key) {
  if (useKv) {
    await kv().del(key);
    return;
  }
  const store = readDevStore();
  if (key in store) {
    delete store[key];
    writeDevStore(store);
  }
}

async function writeKvPointers(entitlement) {
  if (!entitlement.subscriptionId && !entitlement.email) return;
  if (entitlement.subscriptionId) {
    await rawSet(SUB_PREFIX + entitlement.subscriptionId, entitlement.licenseKey);
  }
  if (entitlement.email) {
    await rawSet(EMAIL_PREFIX + normalizeEmail(entitlement.email), entitlement.licenseKey);
  }
}

async function writeKvEntitlement(entitlement) {
  await rawSet(ENT_PREFIX + entitlement.licenseKey, entitlement);
  await writeKvPointers(entitlement);
}

// ---- Public API ----------------------------------------------------------

async function getEntitlement(licenseKey) {
  if (!licenseKey) return null;
  const key = String(licenseKey).trim().toUpperCase();

  if (useNeon) {
    try {
      const ent = await licenseDb.getLicense(key);
      if (ent) return ent;
    } catch (err) {
      console.error('store: neon read failed, falling back to kv', err);
    }
  }

  return rawGet(ENT_PREFIX + key);
}

async function putEntitlement(entitlement, meta = {}) {
  if (!entitlement || !entitlement.licenseKey) {
    throw new Error('putEntitlement requires a licenseKey');
  }

  const key = String(entitlement.licenseKey).trim().toUpperCase();
  entitlement.licenseKey = key;

  let saved = entitlement;

  if (useNeon) {
    saved = await licenseDb.upsertLicense(entitlement, meta);
  }

  if (useKv || !useNeon) {
    try {
      await writeKvEntitlement(saved);
    } catch (err) {
      console.error('store: kv write failed', err);
      if (!useNeon) throw err;
    }
  }

  return saved;
}

async function getKeyBySubscription(subscriptionId) {
  if (!subscriptionId) return null;

  if (useNeon) {
    try {
      const ent = await licenseDb.getLicenseBySubscription(subscriptionId);
      if (ent) return ent.licenseKey;
    } catch (err) {
      console.error('store: neon subscription lookup failed', err);
    }
  }

  return rawGet(SUB_PREFIX + subscriptionId);
}

async function getEntitlementBySubscription(subscriptionId) {
  if (useNeon) {
    try {
      const ent = await licenseDb.getLicenseBySubscription(subscriptionId);
      if (ent) return ent;
    } catch (err) {
      console.error('store: neon subscription read failed', err);
    }
  }

  const licenseKey = await getKeyBySubscription(subscriptionId);
  if (!licenseKey) return null;
  return getEntitlement(licenseKey);
}

async function getKeyByEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;

  if (useNeon) {
    try {
      const ent = await licenseDb.getLicenseByEmail(email);
      if (ent) return ent.licenseKey;
    } catch (err) {
      console.error('store: neon email lookup failed', err);
    }
  }

  return rawGet(EMAIL_PREFIX + norm);
}

async function getEntitlementByEmail(email) {
  if (useNeon) {
    try {
      const ent = await licenseDb.getLicenseByEmail(email);
      if (ent) return ent;
    } catch (err) {
      console.error('store: neon email read failed', err);
    }
  }

  const licenseKey = await getKeyByEmail(email);
  if (!licenseKey) return null;
  return getEntitlement(licenseKey);
}

async function bindDevice(licenseKey, instanceId, meta = {}) {
  if (useNeon) {
    return licenseDb.bindDevice(licenseKey, instanceId, meta);
  }
  const ent = await getEntitlement(licenseKey);
  if (!ent) return { bound: false, isNew: false };
  const ids = ent.instanceIds || [];
  const isNew = !ids.includes(instanceId);
  if (isNew) {
    ids.push(instanceId);
    ent.instanceIds = ids;
    await putEntitlement(ent, meta);
  }
  return { bound: true, isNew };
}

async function removeDevice(licenseKey, instanceId, meta = {}) {
  if (useNeon) {
    const removed = await licenseDb.removeDevice(licenseKey, instanceId, meta);
    if (useKv) {
      const ent = await licenseDb.getLicense(licenseKey);
      if (ent) await writeKvEntitlement(ent);
    }
    return removed;
  }

  const ent = await getEntitlement(licenseKey);
  if (!ent) return false;
  const before = ent.instanceIds || [];
  const after = before.filter((id) => id !== instanceId);
  if (after.length === before.length) return false;
  ent.instanceIds = after;
  await putEntitlement(ent, meta);
  return true;
}

async function listActiveDevices(licenseKey) {
  if (useNeon) {
    return licenseDb.listActiveDevices(licenseKey);
  }
  const ent = await getEntitlement(licenseKey);
  if (!ent) return [];
  return (ent.instanceIds || []).map((instanceId) => ({
    instanceId,
    deviceName: null,
    firstSeen: null,
    lastSeen: null,
  }));
}

async function countActiveDevices(licenseKey) {
  if (useNeon) {
    return licenseDb.countActiveDevices(licenseKey);
  }
  const ent = await getEntitlement(licenseKey);
  return ent ? (ent.instanceIds || []).length : 0;
}

async function isDeviceActive(licenseKey, instanceId) {
  if (useNeon) {
    return licenseDb.isDeviceActive(licenseKey, instanceId);
  }
  const ent = await getEntitlement(licenseKey);
  return Boolean(ent && (ent.instanceIds || []).includes(instanceId));
}

module.exports = {
  getEntitlement,
  putEntitlement,
  getKeyBySubscription,
  getEntitlementBySubscription,
  getKeyByEmail,
  getEntitlementByEmail,
  bindDevice,
  removeDevice,
  listActiveDevices,
  countActiveDevices,
  isDeviceActive,
  usingKv: useKv,
  usingNeon: useNeon,
  rawGet,
  rawSet,
  rawDel,
  licenseDb,
};
