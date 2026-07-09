const crypto = require('crypto');

// License key format: NXQL-XXXX-XXXX-XXXX-XXXX (Crockford-ish base32, no ambiguous chars).
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, 0, 1, U

function randomChar() {
  while (true) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 240) {
      return ALPHABET[byte % 30];
    }
  }
}

function group() {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += randomChar();
  }
  return out;
}

function generateLicenseKey() {
  return `NXQL-${group()}-${group()}-${group()}-${group()}`;
}

function isWellFormed(key) {
  return /^(NXQL|PGST)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(key || ''));
}

module.exports = { generateLicenseKey, isWellFormed };
