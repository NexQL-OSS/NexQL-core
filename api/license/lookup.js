// GET /api/license/lookup?subscription_id=sub_xxx
// Returns: { licenseKey, tier } once the webhook has issued a key, else { pending: true }.
//
// Lets the post-checkout success page poll for the freshly issued key while the
// Razorpay webhook lands. subscription_id is unguessable, so no extra auth.

const store = require('../lib/store');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const subscriptionId = req.query && req.query.subscription_id;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscription_id is required' });
  }

  try {
    const ent = await store.getEntitlementBySubscription(subscriptionId);
    if (!ent || !ent.licenseKey) {
      return res.status(200).json({ pending: true });
    }
    return res.status(200).json({ licenseKey: ent.licenseKey, tier: ent.tier });
  } catch (err) {
    console.error('lookup: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }
};
