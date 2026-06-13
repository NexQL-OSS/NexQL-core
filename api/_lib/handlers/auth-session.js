// POST /api/auth/session — fast-path sign-in with stored license key.

const { createSessionFromLicense } = require('../sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey, instanceId, deviceId, deviceName } = req.body || {};
  if (!licenseKey) {
    return res.status(400).json({ error: 'licenseKey is required' });
  }

  try {
    const result = await createSessionFromLicense(licenseKey, instanceId, deviceId, deviceName);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(200).json({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      email: result.email || null,
      tier: result.tier || null,
    });
  } catch (err) {
    console.error('auth/session:', err);
    return res.status(500).json({ error: 'Session creation failed' });
  }
};
