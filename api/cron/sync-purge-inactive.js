// Daily cron: purge NexQL Cloud blobs for accounts inactive > 30 days.
// Secured with CRON_SECRET (Authorization: Bearer <secret>).

const { purgeInactiveCloudData } = require('../_lib/sync-db');
const { CLOUD_INACTIVE_RETENTION_DAYS } = require('../_lib/sync-retention');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Cron not configured' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const purged = await purgeInactiveCloudData();
    return res.status(200).json({
      ok: true,
      purged,
      retentionDays: CLOUD_INACTIVE_RETENTION_DAYS,
    });
  } catch (err) {
    console.error('sync-purge-inactive cron failed', err);
    return res.status(500).json({ error: 'Cron failed' });
  }
};
