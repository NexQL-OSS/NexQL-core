// POST /api/auth/free-session — mint a free-tier session from a GitHub OAuth token.
// No license key required; identity comes from the verified GitHub user id.

const { createSessionFromOAuth } = require('../sync-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { provider, access_token: accessToken, deviceId, deviceName } = req.body || {};
  if (!accessToken) {
    return res.status(400).json({ error: 'access_token is required' });
  }

  try {
    const result = await createSessionFromOAuth(provider || 'github', accessToken, deviceId, deviceName);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(200).json({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      email: result.email || null,
      tier: result.tier || 'free',
    });
  } catch (err) {
    console.error('auth/free-session:', err);
    return res.status(500).json({ error: 'Free session creation failed' });
  }
};
