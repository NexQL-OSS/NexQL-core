const Razorpay = require('razorpay');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { amount, currency, receipt } = req.body || {};

  // Validate amount
  if (!amount || isNaN(amount)) {
    return res.status(400).json({ error: 'Amount is required and must be a number' });
  }

  const amountPaise = parseInt(amount, 10);
  if (amountPaise < 100) {
    return res.status(400).json({ error: 'Amount must be at least 100 paise' });
  }

  if (!currency) {
    return res.status(400).json({ error: 'Currency is required' });
  }

  // Initialize Razorpay client
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    console.error('Razorpay credentials missing from environment.');
    return res.status(500).json({ error: 'Internal Server Error: Razorpay credentials missing' });
  }

  const razorpay = new Razorpay({
    key_id: key_id,
    key_secret: key_secret,
  });

  try {
    const options = {
      amount: amountPaise,
      currency: currency,
      receipt: receipt || `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    return res.status(200).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error('Razorpay API error:', error);

    // Handle authentication failures (Razorpay SDK might throw or return standard error response)
    const errorDescription = error.description || (error.error && error.error.description) || '';
    if (
      error.statusCode === 401 ||
      errorDescription.includes('Key') ||
      errorDescription.includes('signature')
    ) {
      return res.status(401).json({ error: 'Authentication failed with Razorpay API' });
    }

    return res
      .status(500)
      .json({ error: error.message || 'Failed to create order with Razorpay API' });
  }
};
