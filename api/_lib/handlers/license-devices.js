// POST /api/license/devices
// Body: { licenseKey, email, action: 'list' | 'remove', instanceId? }
// Returns: { ok, devices: [{ instanceId, deviceName?, lastSeen? }], limit }
//
// Lets a license owner see which VS Code machine ids are bound to their
// entitlement and free up slots (e.g. a replaced laptop). Authenticated by
// licenseKey + the email on file — both must match; on mismatch the response
// is indistinguishable from an unknown key to prevent enumeration.

const store = require('../store');
const { licenseDb } = store;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function authFailure(ent, email) {
  return !ent || normalizeEmail(ent.email) !== normalizeEmail(email);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey, email, action, instanceId } = req.body || {};
  if (!licenseKey || !email || !action) {
    return res.status(400).json({ error: 'licenseKey, email and action are required' });
  }
  if (action !== 'list' && action !== 'remove') {
    return res.status(400).json({ error: "action must be 'list' or 'remove'" });
  }
  if (action === 'remove' && !instanceId) {
    return res.status(400).json({ error: 'instanceId is required for remove' });
  }

  const key = String(licenseKey).trim().toUpperCase();

  let ent;
  try {
    ent = await store.getEntitlement(key);
  } catch (err) {
    console.error('devices: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }

  if (authFailure(ent, email)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const limit = licenseDb.deviceLimitFor(ent.tier);

  if (action === 'remove') {
    try {
      await store.removeDevice(key, instanceId, { source: 'devices_api' });
      if (store.usingKv && store.usingNeon) {
        ent = await store.getEntitlement(key);
      }
    } catch (err) {
      console.error('devices: failed to persist removal', err);
      return res.status(500).json({ error: 'Store unavailable' });
    }
  }

  let devices;
  try {
    devices = await store.listActiveDevices(key);
  } catch (err) {
    console.error('devices: list error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }

  return res.status(200).json({
    ok: true,
    limit,
    devices: devices.map((d) => ({
      instanceId: d.instanceId,
      deviceName: d.deviceName || null,
      lastSeen: d.lastSeen || null,
    })),
  });
};
