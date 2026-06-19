// GET /api/sync/quota — cloud storage usage for the signed-in account.

const { authenticateBearer } = require('../sync-auth');
const { getAccountQuota } = require('../sync-db');

const CLOUD_QUOTA_MB = 100;
const BYTES_PER_MB = 1024 * 1024;

const QUOTA_BYTES = {
  sponsor: CLOUD_QUOTA_MB * BYTES_PER_MB,
  singularity: CLOUD_QUOTA_MB * BYTES_PER_MB,
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/quota auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const row = await getAccountQuota(auth.account_id);
    const tier = auth.tier || row.tier || 'sponsor';
    const bytesLimit = QUOTA_BYTES[tier] || QUOTA_BYTES.sponsor;
    return res.status(200).json({
      tier,
      bytes_used: Number(row.bytes_used) || 0,
      bytes_limit: bytesLimit,
      item_count: Number(row.item_count) || 0,
      updated_at: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : new Date(row.updated_at).toISOString(),
    });
  } catch (err) {
    console.error('sync/quota GET:', err);
    return res.status(500).json({ error: 'Failed to load quota' });
  }
};
