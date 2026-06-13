// POST /api/license/status
// Body: { licenseKey, email? }
// Returns read-only entitlement status for the Manage License panel.
// When email is provided and matches the license record, includes devices,
// renewalCount, and memberSince. Does NOT bind a device.

const store = require('../store');
const { licenseDb } = store;

function maskEmail(email) {
  if (!email || !email.includes('@')) return null;
  const [user, domain] = email.split('@');
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailMatches(ent, email) {
  return Boolean(email) && normalizeEmail(ent.email) === normalizeEmail(email);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey, email } = req.body || {};
  if (!licenseKey) {
    return res.status(400).json({ error: 'licenseKey is required' });
  }

  const key = String(licenseKey).trim().toUpperCase();

  try {
    const ent = await store.getEntitlement(key);
    if (!ent) {
      return res.status(404).json({ found: false });
    }

    if (email && !emailMatches(ent, email)) {
      return res.status(404).json({ found: false });
    }

    const payload = {
      found: true,
      tier: ent.tier,
      status: ent.status,
      period: ent.period,
      currency: ent.currency,
      expiresAt: ent.expiresAt || null,
      email: maskEmail(ent.email),
      hasSubscription: Boolean(ent.subscriptionId),
      memberSince: ent.createdAt || null,
    };

    if (email && emailMatches(ent, email)) {
      const [devices, renewalCount] = await Promise.all([
        store.listActiveDevices(key),
        store.usingNeon
          ? licenseDb.countRenewals(key)
          : Promise.resolve(0),
      ]);
      payload.devices = devices.map((d) => ({
        instanceId: d.instanceId,
        deviceName: d.deviceName || null,
        lastSeen: d.lastSeen || null,
      }));
      payload.deviceLimit = licenseDb.deviceLimitFor(ent.tier);
      payload.renewalCount = renewalCount;
    }

    return res.status(200).json(payload);
  } catch (err) {
    console.error('status: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }
};
