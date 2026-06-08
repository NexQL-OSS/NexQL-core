const Razorpay = require('razorpay');
const { resolvePlan } = require('./_lib/plan-config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { tier, period, currency } = req.body || {};

  if (!tier || !period || !currency) {
    return res.status(400).json({ error: 'tier, period, and currency are required' });
  }

  const country = req.headers['x-vercel-ip-country'];
  if (currency === 'INR' && country && country.toUpperCase() !== 'IN') {
    return res.status(400).json({ error: 'INR payments are only available for users in India' });
  }

  const resolved = resolvePlan(tier, period, currency);
  if (resolved.error) {
    return res.status(400).json({ error: resolved.error });
  }

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    console.error('Razorpay credentials missing from environment.');
    return res.status(500).json({ error: 'Internal Server Error: Razorpay credentials missing' });
  }

  const razorpay = new Razorpay({
    key_id,
    key_secret,
  });

  // Razorpay requires total_count (number of billing cycles) when end_at is absent.
  // Use a long horizon so it behaves like an ongoing subscription until cancelled.
  const totalCount = period === 'annual' ? 10 : 120; // 10 years either way

  try {
    const subscription = await razorpay.subscriptions.create({
      plan_id: resolved.planId,
      total_count: totalCount,
      customer_notify: 1,
      notes: {
        tier,
        period,
        currency,
      },
    });

    return res.status(200).json({
      subscription_id: subscription.id,
      key_id,
      tier,
      period,
      currency,
      display: resolved.display,
    });
  } catch (error) {
    console.error('Razorpay subscription API error:', error);

    const errorDescription = error.description || (error.error && error.error.description) || '';
    if (
      error.statusCode === 401 ||
      errorDescription.includes('Key') ||
      errorDescription.includes('signature')
    ) {
      return res.status(401).json({ error: 'Authentication failed with Razorpay API' });
    }

    return res.status(500).json({
      error: error.message || 'Failed to create subscription with Razorpay API',
    });
  }
};
