// POST /api/auth/authorize — complete device flow (pre-bound or manual license key).

const { authorizeDevice } = require('../sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { user_code: userCode, licenseKey } = req.body || {};
  if (!userCode) {
    return res.status(400).json({ error: 'user_code is required' });
  }

  try {
    const result = await authorizeDevice(userCode, licenseKey);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(200).json({ ok: true, email: result.email || null });
  } catch (err) {
    console.error('auth/authorize:', err);
    return res.status(500).json({ error: 'Authorization failed' });
  }
};
