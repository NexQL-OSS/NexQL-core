// Entitlement store abstraction.
//
// Uses Vercel KV (Upstash Redis) when KV_REST_API_URL / KV_REST_API_TOKEN are
// present in the environment. Falls back to a local JSON file (.kv-dev.json at
// repo root) so the dev server and tests work without provisioning KV.
//
// Keys:
//   ent:<licenseKey>      -> entitlement object (see Entitlement shape below)
//   sub:<subscriptionId>  -> licenseKey pointer (for success-page lookup)
//
// Entitlement shape:
//   {
//     licenseKey, tier, period, currency,
//     status: 'active' | 'cancelled' | 'halted' | 'paused',
//     subscriptionId, email,
//     expiresAt,        // unix ms, when the current paid window ends (null = open-ended)
//     createdAt,        // unix ms
//     instanceIds: []   // bound VS Code machine ids (activation devices)
//   }

const path = require('path');
const fs = require('fs');

const ENT_PREFIX = 'ent:';
const SUB_PREFIX = 'sub:';
const EMAIL_PREFIX = 'email:';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const useKv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

let kvClient = null;
function kv() {
  if (!kvClient) {
    // Lazily required so deployments without KV configured never load it.
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
  return store[key] || null;
}

async function rawSet(key, value) {
  if (useKv) {
    await kv().set(key, value);
    return;
  }
  const store = readDevStore();
  store[key] = value;
  writeDevStore(store);
}

// ---- Public API ----------------------------------------------------------

async function getEntitlement(licenseKey) {
  if (!licenseKey) return null;
  return rawGet(ENT_PREFIX + licenseKey);
}

async function putEntitlement(entitlement) {
  if (!entitlement || !entitlement.licenseKey) {
    throw new Error('putEntitlement requires a licenseKey');
  }
  await rawSet(ENT_PREFIX + entitlement.licenseKey, entitlement);
  if (entitlement.subscriptionId) {
    await rawSet(SUB_PREFIX + entitlement.subscriptionId, entitlement.licenseKey);
  }
  if (entitlement.email) {
    await rawSet(EMAIL_PREFIX + normalizeEmail(entitlement.email), entitlement.licenseKey);
  }
  return entitlement;
}

async function getKeyBySubscription(subscriptionId) {
  if (!subscriptionId) return null;
  return rawGet(SUB_PREFIX + subscriptionId);
}

async function getEntitlementBySubscription(subscriptionId) {
  const licenseKey = await getKeyBySubscription(subscriptionId);
  if (!licenseKey) return null;
  return getEntitlement(licenseKey);
}

async function getKeyByEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  return rawGet(EMAIL_PREFIX + norm);
}

async function getEntitlementByEmail(email) {
  const licenseKey = await getKeyByEmail(email);
  if (!licenseKey) return null;
  return getEntitlement(licenseKey);
}

module.exports = {
  getEntitlement,
  putEntitlement,
  getKeyBySubscription,
  getEntitlementBySubscription,
  getKeyByEmail,
  getEntitlementByEmail,
  usingKv: useKv,
};
