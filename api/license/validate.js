// POST /api/license/validate
// Body: { licenseKey, instanceId }
// Returns: { valid, tier, status, expiresAt }
//
// Called by the extension's LicenseService on activate and on background
// re-validation. Binds the VS Code machine id (instanceId) to the entitlement
// up to a device cap.

const store = require('../_lib/store');

const MAX_DEVICES = 10;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey, instanceId } = req.body || {};
  if (!licenseKey) {
    return res.status(400).json({ error: 'licenseKey is required' });
  }

  let ent;
  try {
    ent = await store.getEntitlement(licenseKey);
  } catch (err) {
    console.error('validate: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }

  if (!ent) {
    return res.status(404).json({ valid: false, status: 'unknown' });
  }

  const active = ent.status === 'active' && (!ent.expiresAt || ent.expiresAt > Date.now());

  if (active && instanceId) {
    const ids = ent.instanceIds || [];
    if (!ids.includes(instanceId)) {
      if (ids.length >= MAX_DEVICES) {
        return res.status(200).json({
          valid: false,
          status: ent.status,
          tier: ent.tier,
          reason: 'device_limit',
        });
      }
      ids.push(instanceId);
      ent.instanceIds = ids;
      try {
        await store.putEntitlement(ent);
      } catch (err) {
        console.error('validate: failed to bind instance', err);
      }
    }
  }

  return res.status(200).json({
    valid: active,
    tier: ent.tier,
    status: ent.status,
    expiresAt: ent.expiresAt || null,
  });
};
