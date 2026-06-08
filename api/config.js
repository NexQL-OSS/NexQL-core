const { SUPPORTED_CURRENCIES, buildTierCatalog } = require('./plan-config');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const country = req.headers['x-vercel-ip-country'];
  const response = {
    key_id: process.env.RAZORPAY_KEY_ID,
    supported_currencies: SUPPORTED_CURRENCIES,
    tiers: buildTierCatalog(),
  };

  if (country) {
    response.inIndia = country.toUpperCase() === 'IN';
  }

  return res.status(200).json(response);
};
