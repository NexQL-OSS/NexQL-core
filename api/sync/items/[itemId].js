// GET /api/sync/items/:itemId — fetch encrypted blob.
// PUT /api/sync/items/:itemId — upsert encrypted blob + metadata.

const { authenticateBearer } = require('../../_lib/sync-auth');
const { getItemBlob, upsertItem } = require('../../_lib/sync-db');

module.exports = async (req, res) => {
  const itemId = req.query.itemId;
  if (!itemId) {
    return res.status(400).json({ error: 'itemId is required' });
  }

  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/items auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      const blob = await getItemBlob(auth.account_id, itemId);
      if (!blob || blob.length === 0) {
        return res.status(404).end();
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.status(200).send(blob);
    } catch (err) {
      console.error('sync/items GET:', err);
      return res.status(500).json({ error: 'Failed to load item' });
    }
  }

  if (req.method === 'PUT') {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Item payload required' });
    }

    const blobB64 = body.blob;
    if (typeof blobB64 !== 'string') {
      return res.status(400).json({ error: 'blob (base64) is required' });
    }

    try {
      await upsertItem(auth.account_id, itemId, {
        kind: body.kind,
        blob: Buffer.from(blobB64, 'base64'),
        content_hash: body.content_hash,
        revision: Number(body.revision) || 1,
        device_id: String(body.device_id || ''),
        deleted: !!body.deleted,
      });
      return res.status(204).end();
    } catch (err) {
      console.error('sync/items PUT:', err);
      return res.status(500).json({ error: 'Failed to save item' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
