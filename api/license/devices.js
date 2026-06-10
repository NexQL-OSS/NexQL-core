// POST /api/license/devices
// Body: { licenseKey, email, action: 'list' | 'remove', instanceId? }
// Returns: { ok, devices: [{ instanceId }], limit }
//
// Lets a license owner see which VS Code machine ids are bound to their
// entitlement and free up slots (e.g. a replaced laptop). Authenticated by
// licenseKey + the email on file — both must match; on mismatch the response
// is indistinguishable from an unknown key to prevent enumeration.

const store = require('../_lib/store');

// Keep in sync with validate.js.
const DEVICE_LIMITS = { sponsor: 3, singularity: 25 };
const DEFAULT_DEVICE_LIMIT = 3;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
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

  let ent;
  try {
    ent = await store.getEntitlement(licenseKey);
  } catch (err) {
    console.error('devices: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }

  // Same response for unknown key and wrong email — no enumeration signal.
  if (!ent || normalizeEmail(ent.email) !== normalizeEmail(email)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const limit = DEVICE_LIMITS[ent.tier] || DEFAULT_DEVICE_LIMIT;

  if (action === 'remove') {
    const before = ent.instanceIds || [];
    const after = before.filter((id) => id !== instanceId);
    if (after.length !== before.length) {
      ent.instanceIds = after;
      try {
        await store.putEntitlement(ent);
      } catch (err) {
        console.error('devices: failed to persist removal', err);
        return res.status(500).json({ error: 'Store unavailable' });
      }
    }
  }

  return res.status(200).json({
    ok: true,
    limit,
    devices: (ent.instanceIds || []).map((id) => ({ instanceId: id })),
  });
};
