// POST /api/license/history
// Body: { licenseKey, email, limit? }
// Returns recent license_events for the authenticated owner.

const store = require('../store');
const { licenseDb } = store;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey, email, limit } = req.body || {};
  if (!licenseKey || !email) {
    return res.status(400).json({ error: 'licenseKey and email are required' });
  }

  const key = String(licenseKey).trim().toUpperCase();
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);

  let ent;
  try {
    ent = await store.getEntitlement(key);
  } catch (err) {
    console.error('history: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }

  if (!ent || normalizeEmail(ent.email) !== normalizeEmail(email)) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (!store.usingNeon) {
    return res.status(200).json({ ok: true, events: [] });
  }

  try {
    const events = await licenseDb.getRecentEvents(key, max);
    return res.status(200).json({ ok: true, events });
  } catch (err) {
    console.error('history: query error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }
};
