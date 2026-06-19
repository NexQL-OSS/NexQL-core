// POST /api/sync/v2/reset  Body: { space? }
// Wipe a space (owner only). Powers "clear cloud & push from local".

const { authenticateBearer } = require('../sync-auth');
const { resetSpace, assertSpaceMember, requireTeamTierIfShared } = require('../sync-db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/v2/reset auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const space = String(body?.space || auth.account_id);

  try {
    const tierBlock = requireTeamTierIfShared(space, auth);
    if (tierBlock) {
      return res.status(tierBlock.status).json({ error: tierBlock.error });
    }
    if (!(await assertSpaceMember(space, auth.email, auth.account_id, 'owner'))) {
      return res.status(403).json({ error: 'Owner access required to reset this workspace' });
    }
    await resetSpace(space);
    return res.status(204).end();
  } catch (err) {
    console.error('sync/v2/reset:', err);
    return res.status(500).json({ error: 'Failed to reset' });
  }
};
