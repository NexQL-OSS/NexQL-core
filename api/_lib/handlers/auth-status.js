// GET /api/auth/status?user_code= — device auth page status for pre-bound sessions.

const { getDeviceAuthStatus } = require('../sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const userCode = req.query?.user_code;
  if (!userCode) {
    return res.status(400).json({ error: 'user_code is required' });
  }

  try {
    const result = await getDeviceAuthStatus(userCode);
    if (!result.ok) {
      return res.status(404).json({ error: result.error });
    }
    return res.status(200).json({
      bound: result.bound,
      tier: result.tier,
      device_name: result.device_name,
      expires_in: result.expires_in,
    });
  } catch (err) {
    console.error('auth/status:', err);
    return res.status(500).json({ error: 'Status check failed' });
  }
};
