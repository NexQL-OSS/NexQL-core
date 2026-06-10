// POST /api/auth/device — start OAuth2 device authorization for NexQL Cloud sync.

const { startDeviceAuth } = require('../_lib/sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = await startDeviceAuth();
    return res.status(200).json(payload);
  } catch (err) {
    console.error('auth/device:', err);
    return res.status(500).json({ error: 'Failed to start device authorization' });
  }
};
