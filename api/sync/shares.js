// GET  /api/sync/shares — list shares granted to me (the signed-in grantee).
// POST /api/sync/shares { grantee_email, items:[{share_id,kind,name,share_blob,wrapped_key}] }
//   — create shares from me (owner) to a grantee.

const crypto = require('crypto');
const { authenticateBearer } = require('../_lib/sync-auth');
const { createShares, listSharesForGrantee } = require('../_lib/sync-db');

const MAX_ITEMS_PER_REQUEST = 100;
const MAX_BLOB_CHARS = 2 * 1024 * 1024; // ~1.5MB binary after base64

module.exports = async (req, res) => {
  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/shares auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!auth.email) {
    return res.status(403).json({ error: 'Account email required for sharing' });
  }

  if (req.method === 'GET') {
    try {
      const rows = await listSharesForGrantee(auth.email);
      return res.status(200).json(
        rows.map((r) => ({
          share_id: r.share_id,
          owner_email: r.owner_email,
          kind: r.item_kind,
          name: r.item_name,
          share_blob: r.share_blob,
          wrapped_key: r.wrapped_key,
          created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        })),
      );
    } catch (err) {
      console.error('sync/shares GET:', err);
      return res.status(500).json({ error: 'Failed to list shares' });
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
    const granteeEmail = body && body.grantee_email;
    const items = body && body.items;
    if (typeof granteeEmail !== 'string' || !granteeEmail) {
      return res.status(400).json({ error: 'grantee_email is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }
    if (items.length > MAX_ITEMS_PER_REQUEST) {
      return res.status(413).json({ error: `Too many items (max ${MAX_ITEMS_PER_REQUEST})` });
    }
    for (const item of items) {
      if (!item || (item.kind !== 'query' && item.kind !== 'notebook')) {
        return res.status(400).json({ error: 'Each item needs a shareable kind (query|notebook)' });
      }
      if (typeof item.share_blob !== 'string' || typeof item.wrapped_key !== 'string') {
        return res.status(400).json({ error: 'Each item needs share_blob and wrapped_key' });
      }
      if (item.share_blob.length > MAX_BLOB_CHARS) {
        return res.status(413).json({ error: 'Shared item too large' });
      }
    }

    try {
      const normalized = items.map((item) => ({
        share_id: typeof item.share_id === 'string' && item.share_id ? item.share_id : crypto.randomUUID(),
        kind: item.kind,
        name: typeof item.name === 'string' ? item.name.slice(0, 200) : null,
        share_blob: item.share_blob,
        wrapped_key: item.wrapped_key,
      }));
      const created = await createShares(auth.email, granteeEmail, normalized);
      return res.status(201).json({ created });
    } catch (err) {
      console.error('sync/shares POST:', err);
      return res.status(500).json({ error: 'Failed to create shares' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
