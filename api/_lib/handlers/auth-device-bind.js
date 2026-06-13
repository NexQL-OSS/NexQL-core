// POST /api/auth/device-bind — pre-bind license to pending device flow session.

const { bindDeviceLicense } = require('../sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { device_code: deviceCode, licenseKey, instanceId, deviceName } = req.body || {};
  if (!deviceCode || !licenseKey) {
    return res.status(400).json({ error: 'device_code and licenseKey are required' });
  }

  try {
    const result = await bindDeviceLicense(deviceCode, licenseKey, instanceId, deviceName);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(200).json({ ok: true, tier: result.tier || null, email: result.email || null });
  } catch (err) {
    console.error('auth/device-bind:', err);
    return res.status(500).json({ error: 'Device bind failed' });
  }
};
