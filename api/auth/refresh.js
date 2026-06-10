// POST /api/auth/refresh — rotate access token using a refresh token.

const { refreshAccessToken } = require('../_lib/sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { refresh_token: refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ error: 'refresh_token is required' });
  }

  try {
    const result = await refreshAccessToken(refreshToken);
    if (result.error) {
      return res.status(401).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('auth/refresh:', err);
    return res.status(500).json({ error: 'Refresh failed' });
  }
};
