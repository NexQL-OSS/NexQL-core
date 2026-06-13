// POST /api/license/recover
// Body: { email }
// Emails the license key to the address on file so a user can retrieve it from
// any device without pasting the key.
//
// Security: never returns the key in the response and always replies 200 { ok: true }
// regardless of whether the email matched — prevents email enumeration / key harvesting.

const store = require('../store');
const { sendLicenseEmail } = require('../email');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  try {
    const ent = await store.getEntitlementByEmail(email);
    if (ent && ent.licenseKey) {
      await sendLicenseEmail(ent.email || email, ent.licenseKey, ent.tier);
      if (store.usingNeon) {
        try {
          await store.licenseDb.appendEvent(ent.licenseKey, 'recovered', { email }, 'recover');
        } catch (logErr) {
          console.error('recover: failed to log event', logErr);
        }
      }
    }
  } catch (err) {
    console.error('recover: store error', err);
    // Still return the generic response — do not leak internal state.
  }

  // Generic response in all cases.
  return res.status(200).json({ ok: true });
};
