// Optional license-key email delivery via Resend.
// No-op (logs only) when RESEND_API_KEY is unset, so the webhook never fails
// just because email isn't configured.

const https = require('https');

const FROM = process.env.LICENSE_EMAIL_FROM || 'NexQL <licenses@nexql.astrx.dev>';

function activateUri(licenseKey) {
  return `vscode://ric-v.postgres-explorer/activate?key=${encodeURIComponent(licenseKey)}`;
}

function buildHtml(licenseKey, tier) {
  const tierName = tier ? tier[0].toUpperCase() + tier.slice(1) : 'Pro';
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto">
      <h2>Welcome to NexQL ${tierName} 🎉</h2>
      <p>Your license key:</p>
      <p style="font-size:18px;font-weight:700;letter-spacing:1px;background:#f4f4f8;padding:12px 16px;border-radius:8px">${licenseKey}</p>
      <p><a href="${activateUri(licenseKey)}"
            style="display:inline-block;background:#6C4CF0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">
            Activate in VS Code</a></p>
      <p style="color:#666;font-size:13px">Or run <b>NexQL: Activate License</b> from the command palette and paste the key above.</p>
    </div>`;
}

function sendLicenseEmail(to, licenseKey, tier) {
  return new Promise((resolve) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || !to) {
      console.log(`[email] skipped (no RESEND_API_KEY or recipient) for ${licenseKey}`);
      return resolve({ sent: false });
    }

    const payload = JSON.stringify({
      from: FROM,
      to: [to],
      subject: 'Your NexQL license key',
      html: buildHtml(licenseKey, tier),
    });

    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ sent: res.statusCode < 300 }));
      },
    );
    req.on('error', (err) => {
      console.error('[email] send failed:', err.message);
      resolve({ sent: false });
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendLicenseEmail };
