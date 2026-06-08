const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_subscription_id,
    razorpay_signature,
  } = req.body || {};

  // Two checkout modes, two signature formulas:
  //   subscription: HMAC(razorpay_payment_id + '|' + razorpay_subscription_id)
  //   one-time order: HMAC(razorpay_order_id + '|' + razorpay_payment_id)
  const isSubscription = Boolean(razorpay_subscription_id);

  // Error handling: Missing fields
  if (!razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required signature verification fields' });
  }
  if (isSubscription ? !razorpay_subscription_id : !razorpay_order_id) {
    return res.status(400).json({ error: 'Missing required signature verification fields' });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    console.error('Razorpay Key Secret is missing from environment.');
    return res.status(500).json({ error: 'Internal Server Error: Razorpay Key Secret is missing' });
  }

  try {
    // Generate signature using HMAC-SHA256
    const payload = isSubscription
      ? `${razorpay_payment_id}|${razorpay_subscription_id}`
      : `${razorpay_order_id}|${razorpay_payment_id}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const generated_signature = hmac.digest('hex');

    // Timing-safe comparison of generated signature and razorpay_signature
    const expBuf = Buffer.from(generated_signature);
    const sigBuf = Buffer.from(String(razorpay_signature));
    const verified =
      expBuf.length === sigBuf.length && crypto.timingSafeEqual(expBuf, sigBuf);

    if (verified) {
      return res.status(200).json({
        success: true,
        message: 'Payment signature verified successfully.',
      });
    } else {
      // Signature mismatch: return 400, do NOT mark as paid
      return res.status(400).json({
        success: false,
        error: 'Signature verification failed. Potential tampering detected.',
      });
    }
  } catch (error) {
    console.error('Error verifying payment signature:', error);
    return res
      .status(500)
      .json({ error: error.message || 'Internal Server Error during verification' });
  }
};
