// POST /api/license/status
// Body: { licenseKey }
// Returns read-only entitlement status for the Manage Subscription panel.
// Does NOT bind a device (unlike /api/license/validate).

const store = require('../lib/store');

function maskEmail(email) {
  if (!email || !email.includes('@')) return null;
  const [user, domain] = email.split('@');
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey } = req.body || {};
  if (!licenseKey) {
    return res.status(400).json({ error: 'licenseKey is required' });
  }

  try {
    const ent = await store.getEntitlement(String(licenseKey).trim().toUpperCase());
    if (!ent) {
      return res.status(404).json({ found: false });
    }
    return res.status(200).json({
      found: true,
      tier: ent.tier,
      status: ent.status,
      period: ent.period,
      currency: ent.currency,
      expiresAt: ent.expiresAt || null,
      email: maskEmail(ent.email),
      hasSubscription: Boolean(ent.subscriptionId),
    });
  } catch (err) {
    console.error('status: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }
};
