// DELETE /api/sync/shares/:shareId — revoke a share you own.
// GET    /api/sync/shares/:shareId — (owner) check a single share's status.

const { authenticateBearer } = require('../../_lib/sync-auth');
const { revokeShare } = require('../../_lib/sync-db');

module.exports = async (req, res) => {
  const shareId = req.query.shareId;
  if (!shareId) {
    return res.status(400).json({ error: 'shareId is required' });
  }

  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/shares/:id auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!auth.email) {
    return res.status(403).json({ error: 'Account email required for sharing' });
  }

  if (req.method === 'DELETE') {
    try {
      const revoked = await revokeShare(auth.email, shareId);
      if (!revoked) {
        return res.status(404).json({ error: 'Share not found or not owned by you' });
      }
      return res.status(204).end();
    } catch (err) {
      console.error('sync/shares/:id DELETE:', err);
      return res.status(500).json({ error: 'Failed to revoke share' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
