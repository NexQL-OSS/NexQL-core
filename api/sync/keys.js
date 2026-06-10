// GET  /api/sync/keys?email= — fetch a team member's public key for sharing.
// POST /api/sync/keys { public_key } — register this account's public key.

const { authenticateBearer } = require('../_lib/sync-auth');
const { upsertIdentity, getPublicKey } = require('../_lib/sync-db');

module.exports = async (req, res) => {
  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/keys auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!auth.email) {
    return res.status(403).json({ error: 'Account email required for sharing' });
  }

  if (req.method === 'GET') {
    const email = req.query?.email;
    if (!email) {
      return res.status(400).json({ error: 'email query parameter required' });
    }
    try {
      const publicKey = await getPublicKey(email);
      if (!publicKey) {
        return res.status(404).json({ error: 'No public key registered for that email' });
      }
      return res.status(200).json({ email: String(email).trim().toLowerCase(), public_key: publicKey });
    } catch (err) {
      console.error('sync/keys GET:', err);
      return res.status(500).json({ error: 'Failed to load public key' });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }
    const publicKey = body && body.public_key;
    if (typeof publicKey !== 'string' || !publicKey) {
      return res.status(400).json({ error: 'public_key is required' });
    }
    try {
      await upsertIdentity(auth.email, auth.account_id, publicKey);
      return res.status(204).end();
    } catch (err) {
      console.error('sync/keys POST:', err);
      return res.status(500).json({ error: 'Failed to register public key' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
