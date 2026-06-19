// GET  /api/sync/v2/spaces            → workspaces the caller belongs to
// GET  /api/sync/v2/spaces?space=ID   → members of a workspace
// POST /api/sync/v2/spaces            → { action: 'create'|'addMember'|'removeMember', ... }
// Team workspaces require a singularity (Teams) license.

const crypto = require('crypto');
const { authenticateBearer } = require('../sync-auth');
const {
  createSpace,
  listSpacesForEmail,
  listMembers,
  addMember,
  removeMember,
  assertSpaceMember,
  requireTeamTierIfShared,
} = require('../sync-db');

function isoize(rows, field) {
  return rows.map((r) => ({
    ...r,
    [field]: r[field] instanceof Date ? r[field].toISOString() : new Date(r[field]).toISOString(),
  }));
}

module.exports = async (req, res) => {
  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/v2/spaces auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!auth.email) {
    return res.status(400).json({ error: 'Account has no email; cannot manage workspaces' });
  }

  if (req.method === 'GET') {
    try {
      const space = req.query?.space ? String(req.query.space) : null;
      if (space) {
        const tierBlock = requireTeamTierIfShared(space, auth);
        if (tierBlock) {
          return res.status(tierBlock.status).json({ error: tierBlock.error });
        }
        if (!(await assertSpaceMember(space, auth.email, auth.account_id, 'viewer'))) {
          return res.status(403).json({ error: 'Not a member of this workspace' });
        }
        return res.status(200).json({ members: isoize(await listMembers(space), 'added_at') });
      }
      return res.status(200).json({ spaces: await listSpacesForEmail(auth.email) });
    } catch (err) {
      console.error('sync/v2/spaces GET:', err);
      return res.status(500).json({ error: 'Failed to load workspaces' });
    }
  }

  if (req.method === 'POST') {
    if (auth.tier !== 'singularity') {
      return res.status(402).json({ error: 'Team workspaces require a Teams license' });
    }
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }
    const action = String(body?.action || '');

    try {
      if (action === 'create') {
        const name = String(body.name || 'Shared workspace').slice(0, 120);
        const spaceId = `ws_${crypto.randomBytes(12).toString('hex')}`;
        await createSpace(spaceId, name, auth.email);
        return res.status(200).json({ space_id: spaceId, name });
      }

      const space = String(body.space || '');
      if (!space) {
        return res.status(400).json({ error: 'space is required' });
      }
      if (!(await assertSpaceMember(space, auth.email, auth.account_id, 'owner'))) {
        return res.status(403).json({ error: 'Owner access required' });
      }

      if (action === 'addMember') {
        const email = String(body.email || '');
        const role = body.role === 'viewer' ? 'viewer' : 'editor';
        if (!email) {
          return res.status(400).json({ error: 'email is required' });
        }
        await addMember(space, email, role);
        return res.status(204).end();
      }

      if (action === 'removeMember') {
        const email = String(body.email || '');
        if (!email) {
          return res.status(400).json({ error: 'email is required' });
        }
        await removeMember(space, email);
        return res.status(204).end();
      }

      return res.status(400).json({ error: 'Unknown action' });
    } catch (err) {
      console.error('sync/v2/spaces POST:', err);
      return res.status(500).json({ error: 'Failed to update workspace' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
