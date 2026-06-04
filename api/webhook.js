// Razorpay subscription webhook — the authoritative source of entitlement.
//
// Verifies X-Razorpay-Signature against RAZORPAY_WEBHOOK_SECRET, then upserts an
// entitlement in the KV store and (first time) issues + emails a license key.
//
// Configure in Razorpay Dashboard → Settings → Webhooks with events:
//   subscription.activated, subscription.charged, subscription.resumed,
//   subscription.cancelled, subscription.halted, subscription.paused
//
// Raw body is required for signature verification, so body parsing is disabled.

const crypto = require('crypto');
const { reversePlanLookup } = require('./plan-config');
const store = require('./lib/store');
const { generateLicenseKey } = require('./lib/license-key');
const { sendLicenseEmail } = require('./lib/email');

const ACTIVE_EVENTS = new Set([
  'subscription.activated',
  'subscription.charged',
  'subscription.resumed',
]);
const STATUS_EVENTS = {
  'subscription.cancelled': 'cancelled',
  'subscription.halted': 'halted',
  'subscription.paused': 'paused',
};

const PERIOD_MS = {
  monthly: 32 * 24 * 60 * 60 * 1000, // generous grace over 1 month
  annual: 366 * 24 * 60 * 60 * 1000,
};

function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function computeExpiry(period, subEntity) {
  // Prefer Razorpay's authoritative current_end (unix seconds) when present.
  if (subEntity && subEntity.current_end) {
    return subEntity.current_end * 1000;
  }
  return Date.now() + (PERIOD_MS[period] || PERIOD_MS.monthly);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('RAZORPAY_WEBHOOK_SECRET missing from environment.');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let raw;
  try {
    raw = await getRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Could not read request body' });
  }

  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const sigBuf = Buffer.from(String(signature || ''));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event = body.event;
  const subEntity = body.payload && body.payload.subscription && body.payload.subscription.entity;

  // Only subscription.* events carry an entitlement.
  if (!subEntity || !subEntity.id) {
    return res.status(200).json({ ignored: true, event });
  }

  const subscriptionId = subEntity.id;

  try {
    const existing = await store.getEntitlementBySubscription(subscriptionId);

    if (ACTIVE_EVENTS.has(event)) {
      const notes = subEntity.notes || {};
      const fromPlan = reversePlanLookup(subEntity.plan_id) || {};
      const tier = notes.tier || fromPlan.tier;
      const period = notes.period || fromPlan.period || 'monthly';
      const currency = notes.currency || fromPlan.currency || 'INR';

      if (!tier) {
        console.error(`Cannot resolve tier for subscription ${subscriptionId} (plan ${subEntity.plan_id})`);
        return res.status(200).json({ ignored: true, reason: 'unresolved tier' });
      }

      const email =
        (body.payload.payment && body.payload.payment.entity && body.payload.payment.entity.email) ||
        notes.email ||
        (existing && existing.email) ||
        null;

      const licenseKey = (existing && existing.licenseKey) || generateLicenseKey();
      const isNew = !existing;

      const entitlement = {
        licenseKey,
        tier,
        period,
        currency,
        status: 'active',
        subscriptionId,
        email,
        expiresAt: computeExpiry(period, subEntity),
        createdAt: existing ? existing.createdAt : Date.now(),
        instanceIds: existing ? existing.instanceIds || [] : [],
      };

      await store.putEntitlement(entitlement);

      if (isNew && email) {
        await sendLicenseEmail(email, licenseKey, tier);
      }

      return res.status(200).json({ ok: true, event, licenseKey });
    }

    if (STATUS_EVENTS[event]) {
      if (existing) {
        existing.status = STATUS_EVENTS[event];
        await store.putEntitlement(existing);
      }
      return res.status(200).json({ ok: true, event, status: STATUS_EVENTS[event] });
    }

    return res.status(200).json({ ignored: true, event });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// Vercel: preserve the raw body for signature verification.
module.exports.config = { api: { bodyParser: false } };
