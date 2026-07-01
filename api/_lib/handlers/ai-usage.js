// GET /api/ai/usage — report the caller's current monthly AI allowance.
//
// Lets the client show "N of M free requests left, resets <date>" without waiting to
// hit a 429. Same auth as the chat proxy (free OAuth or paid license session).

const { authenticateBearerRelaxed } = require('../sync-auth');
const { monthlyLimit, currentPeriod, nextResetIso, readUsage } = require('../ai-db');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let auth;
  try {
    auth = await authenticateBearerRelaxed(req);
  } catch (err) {
    console.error('ai/usage auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tier = auth.tier || 'free';
  const limit = monthlyLimit(tier);

  let used = 0;
  try {
    used = await readUsage(auth.account_id, currentPeriod());
  } catch (err) {
    console.error('ai/usage read:', err);
    return res.status(500).json({ error: 'Usage lookup failed' });
  }

  return res.status(200).json({
    tier,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: nextResetIso(),
  });
};
