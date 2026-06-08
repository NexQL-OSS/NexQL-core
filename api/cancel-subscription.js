// POST /api/cancel-subscription
// Body: { licenseKey, immediate?: boolean }
//
// Looks up the Razorpay subscription via the license key and cancels it.
// Default cancels at the end of the current billing cycle (customer keeps access
// until they're paid through). `immediate: true` cancels right away.
//
// The Razorpay `subscription.cancelled` webhook is the source of truth and will
// flip KV status; for immediate cancels we also update KV optimistically so the
// UI reflects it without waiting for the webhook.

const Razorpay = require('razorpay');
const store = require('./lib/store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { licenseKey, immediate } = req.body || {};
  if (!licenseKey) {
    return res.status(400).json({ error: 'licenseKey is required' });
  }

  const key = String(licenseKey).trim().toUpperCase();

  let ent;
  try {
    ent = await store.getEntitlement(key);
  } catch (err) {
    console.error('cancel: store error', err);
    return res.status(500).json({ error: 'Store unavailable' });
  }

  if (!ent || !ent.subscriptionId) {
    return res.status(404).json({ error: 'No subscription found for this license key' });
  }
  if (ent.status !== 'active') {
    return res.status(200).json({ ok: true, status: ent.status, alreadyCancelled: true });
  }

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    return res.status(500).json({ error: 'Razorpay credentials missing' });
  }

  const razorpay = new Razorpay({ key_id, key_secret });

  try {
    // SDK: cancel(subscriptionId, cancelAtCycleEnd) — boolean true ⇒ cancel_at_cycle_end: 1
    const cancelAtCycleEnd = !immediate;
    const sub = await razorpay.subscriptions.cancel(ent.subscriptionId, cancelAtCycleEnd);

    if (immediate) {
      ent.status = 'cancelled';
      await store.putEntitlement(ent);
    }

    return res.status(200).json({
      ok: true,
      status: sub.status,
      cancelAtCycleEnd,
      // When cancelling at cycle end, access remains until this date.
      accessUntil: cancelAtCycleEnd ? ent.expiresAt || (sub.current_end ? sub.current_end * 1000 : null) : null,
    });
  } catch (error) {
    console.error('Razorpay cancel error:', error);
    const description = error.description || (error.error && error.error.description) || error.message;
    if (error.statusCode === 401) {
      return res.status(401).json({ error: 'Authentication failed with Razorpay API' });
    }
    return res.status(500).json({ error: description || 'Failed to cancel subscription' });
  }
};
