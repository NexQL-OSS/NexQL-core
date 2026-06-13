// Daily cron: mark past-due active licenses as expired and emit history events.
// Secured with CRON_SECRET (Authorization: Bearer <secret>).

const { licenseDb } = require('../_lib/store');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!licenseDb.isConfigured()) {
    return res.status(200).json({ ok: true, expired: 0, skipped: 'no_database' });
  }

  try {
    const expired = await licenseDb.expirePastDueLicenses();
    return res.status(200).json({ ok: true, expired });
  } catch (err) {
    console.error('license-expiry cron failed', err);
    return res.status(500).json({ error: 'Cron failed' });
  }
};
