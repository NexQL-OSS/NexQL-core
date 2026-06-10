// GET  /api/sync/manifest — list encrypted sync item metadata for the signed-in account.
// PUT  /api/sync/manifest — upsert manifest metadata (blobs uploaded via /sync/items/:id).

const { authenticateBearer } = require('../_lib/sync-auth');
const { listManifest, upsertManifestMeta } = require('../_lib/sync-db');

function rowToEntry(row) {
  return {
    item_id: row.item_id,
    kind: row.kind,
    content_hash: row.content_hash,
    revision: row.revision,
    device_id: row.device_id,
    deleted: row.deleted,
    updated_at: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : new Date(row.updated_at).toISOString(),
  };
}

module.exports = async (req, res) => {
  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/manifest auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      const since = req.query?.since ? Number(req.query.since) : undefined;
      const rows = await listManifest(auth.account_id, Number.isFinite(since) ? since : undefined);
      if (!rows.length) {
        return res.status(404).end();
      }
      return res.status(200).json(rows.map(rowToEntry));
    } catch (err) {
      console.error('sync/manifest GET:', err);
      return res.status(500).json({ error: 'Failed to load manifest' });
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
    if (!Array.isArray(body)) {
      return res.status(400).json({ error: 'Manifest must be a JSON array' });
    }

    try {
      await upsertManifestMeta(auth.account_id, body);
      return res.status(204).end();
    } catch (err) {
      console.error('sync/manifest PUT:', err);
      return res.status(500).json({ error: 'Failed to save manifest' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
