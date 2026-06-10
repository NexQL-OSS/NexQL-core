// POST /api/auth/token — poll device authorization or exchange device_code for tokens.

const { pollDeviceToken } = require('../_lib/sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { device_code: deviceCode } = req.body || {};
  if (!deviceCode) {
    return res.status(400).json({ error: 'device_code is required' });
  }

  try {
    const result = await pollDeviceToken(deviceCode);
    if (result.error) {
      return res.status(200).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('auth/token:', err);
    return res.status(500).json({ error: 'Token exchange failed' });
  }
};
