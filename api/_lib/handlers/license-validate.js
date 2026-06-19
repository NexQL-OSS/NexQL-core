// POST /api/license/validate
// Body: { licenseKey, instanceId }
// Returns: { valid, tier, status, expiresAt, expiringSoon?, graceUntil? }
//
// Called by the extension's LicenseService on activate and on background
// re-validation. Binds the VS Code machine id (instanceId) to the entitlement
// up to a device cap.

const store = require('../store');
const { licenseDb } = store;

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;
const GRACE_HINT_MS = 3 * 24 * 60 * 60 * 1000;

function deviceLimitFor(tier) {
  return licenseDb.deviceLimitFor(tier);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey, instanceId } = req.body || {};
  if (!licenseKey) {
    return res.status(400).json({ error: 'licenseKey is required' });
  }

  const key = String(licenseKey).trim().toUpperCase();

  let ent;
  try {
    ent = await store.getEntitlement(key);
  } catch (err) {
    console.error('validate: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }

  if (!ent) {
    if (store.usingNeon) {
      try {
        await licenseDb.appendEvent(key, 'validate_rejected', { reason: 'unknown' }, 'validate');
      } catch (err) {
        console.error('validate: failed to log rejection', err);
      }
    }
    return res.status(404).json({ valid: false, status: 'unknown' });
  }

  const active = ent.status === 'active' && (!ent.expiresAt || ent.expiresAt > Date.now());
  let devicesPruned = [];

  if (active && instanceId) {
    try {
      devicesPruned = await licenseDb.pruneExcessDevices(key, deviceLimitFor(ent.tier), instanceId);
    } catch (err) {
      console.error('validate: prune excess devices failed', err);
    }

    const known = await store.isDeviceActive(key, instanceId);
    if (!known) {
      const count = await store.countActiveDevices(key);
      if (count >= deviceLimitFor(ent.tier)) {
        if (store.usingNeon) {
          try {
            await licenseDb.appendEvent(key, 'validate_rejected', {
              reason: 'device_limit',
              instance_id: instanceId,
            }, 'validate');
          } catch (err) {
            console.error('validate: failed to log device_limit', err);
          }
        }
        return res.status(200).json({
          valid: false,
          status: ent.status,
          tier: ent.tier,
          reason: 'device_limit',
        });
      }
      try {
        await store.bindDevice(key, instanceId, { source: 'validate' });
      } catch (err) {
        console.error('validate: failed to bind instance', err);
      }
    } else {
      try {
        await store.bindDevice(key, instanceId, { source: 'validate' });
      } catch (err) {
        console.error('validate: failed to refresh device', err);
      }
    }
  } else if (!active && store.usingNeon) {
    try {
      await licenseDb.appendEvent(key, 'validate_rejected', {
        reason: 'inactive',
        status: ent.status,
        instance_id: instanceId || null,
      }, 'validate');
    } catch (err) {
      console.error('validate: failed to log inactive rejection', err);
    }
  }

  const payload = {
    valid: active,
    tier: ent.tier,
    status: ent.status,
    expiresAt: ent.expiresAt || null,
  };

  if (active && instanceId && devicesPruned?.length) {
    payload.devicesPruned = devicesPruned;
  }

  if (active && ent.expiresAt) {
    const remaining = ent.expiresAt - Date.now();
    if (remaining > 0 && remaining <= EXPIRING_SOON_MS) {
      payload.expiringSoon = true;
      payload.graceUntil = ent.expiresAt + GRACE_HINT_MS;
    }
  }

  return res.status(200).json(payload);
};
