// GET /api/sync/v2/pull?space=<id>&since=<cursor>
// Delta pull: everything in the space past the client cursor (upserts + deletes).

const { authenticateBearer } = require('../sync-auth');
const { pullDelta, assertSpaceMember, requireTeamTierIfShared } = require('../sync-db');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/v2/pull auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const space = String(req.query?.space || auth.account_id);
  const since = req.query?.since ? Number(req.query.since) : 0;

  try {
    const tierBlock = requireTeamTierIfShared(space, auth);
    if (tierBlock) {
      return res.status(tierBlock.status).json({ error: tierBlock.error });
    }
    if (!(await assertSpaceMember(space, auth.email, auth.account_id, 'viewer'))) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }
    const delta = await pullDelta(space, since);
    return res.status(200).json(delta);
  } catch (err) {
    console.error('sync/v2/pull:', err);
    return res.status(500).json({ error: 'Failed to pull' });
  }
};
