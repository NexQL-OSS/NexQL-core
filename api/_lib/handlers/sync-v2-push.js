// POST /api/sync/v2/push
// Body: { space?, ops: [{ op:'upsert'|'delete', item_id, kind?, base_version, content_hash?, blob? }] }
// Atomic batch with per-item compare-and-swap. Returns accepted + rejected (with remote state).

const { authenticateBearer } = require('../sync-auth');
const { pushBatch, assertSpaceMember, requireTeamTierIfShared } = require('../sync-db');

const MAX_OPS = 500;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/v2/push auth:', err);
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
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  const ops = Array.isArray(body?.ops) ? body.ops : null;
  if (!ops) {
    return res.status(400).json({ error: 'ops array is required' });
  }
  if (ops.length > MAX_OPS) {
    return res.status(413).json({ error: `Too many ops (max ${MAX_OPS})` });
  }

  const space = String(body.space || auth.account_id);
  const deviceId = req.headers['x-device-id'] || req.headers['X-Device-Id'] || '';

  try {
    const tierBlock = requireTeamTierIfShared(space, auth);
    if (tierBlock) {
      return res.status(tierBlock.status).json({ error: tierBlock.error });
    }
    if (!(await assertSpaceMember(space, auth.email, auth.account_id, 'editor'))) {
      return res.status(403).json({ error: 'Write access required for this workspace' });
    }
    const result = await pushBatch(space, deviceId, ops);
    return res.status(200).json(result);
  } catch (err) {
    console.error('sync/v2/push:', err);
    return res.status(500).json({ error: 'Failed to push' });
  }
};
