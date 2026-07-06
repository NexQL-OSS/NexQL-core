// Daily cron: mark past-due active licenses as expired and emit history events.
// Secured with CRON_SECRET (Authorization: Bearer <secret>).

const { licenseDb } = require('../_lib/store');

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

  if (!licenseDb.isConfigured()) {
    return res.status(200).json({ ok: true, expired: 0, skipped: 'no_database' });
  }

  try {
    const expiredKeys = await licenseDb.expirePastDueLicenses();
    let markedInactive = 0;
    if (expiredKeys.length > 0) {
      try {
        const { markAccountInactive } = require('../_lib/sync-db');
        for (const licenseKey of expiredKeys) {
          await markAccountInactive(licenseKey);
          markedInactive += 1;
        }
      } catch (err) {
        console.error('license-expiry: markAccountInactive failed', err);
      }
    }
    return res.status(200).json({ ok: true, expired: expiredKeys.length, markedInactive });
  } catch (err) {
    console.error('license-expiry cron failed', err);
    return res.status(500).json({ error: 'Cron failed' });
  }
};
