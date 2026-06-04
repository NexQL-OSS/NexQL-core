const crypto = require('crypto');

// License key format: PGST-XXXX-XXXX-XXXX-XXXX (Crockford-ish base32, no ambiguous chars).
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, 0, 1, U

function group() {
  const bytes = crypto.randomBytes(4);
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function generateLicenseKey() {
  return `PGST-${group()}-${group()}-${group()}-${group()}`;
}

function isWellFormed(key) {
  return /^PGST-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(key || ''));
}

module.exports = { generateLicenseKey, isWellFormed };
