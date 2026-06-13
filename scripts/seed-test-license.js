#!/usr/bin/env node
// Seed a test license into Neon for local / preview testing.
//
// Usage:
//   node scripts/seed-test-license.js --tier sponsor --email you@example.com
//   node scripts/seed-test-license.js --tier singularity --email you@example.com --days 365
//   node scripts/seed-test-license.js --key PGST-TEST-SPON-SOR0-0001 --tier sponsor --email you@example.com
//
// Requires DATABASE_URL (or nxql_DATABASE_URL, etc.) — loads .env from repo root.

'use strict';

const path = require('path');
const fs = require('fs');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i <= 0) continue;
    const key = trimmed.slice(0, i).trim();
    const raw = trimmed.slice(i + 1).trim();
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}

const root = path.join(__dirname, '..');
loadEnvFile(path.join(root, '.env'));
loadEnvFile(path.join(root, '.env.local'));

const { generateLicenseKey } = require('../api/_lib/license-key');
const store = require('../api/_lib/store');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

async function main() {
  const tier = arg('tier', 'sponsor');
  if (tier !== 'sponsor' && tier !== 'singularity') {
    console.error('--tier must be sponsor or singularity');
    process.exit(1);
  }

  const email = arg('email');
  if (!email) {
    console.error('--email is required');
    process.exit(1);
  }

  const days = Math.max(1, Number(arg('days', '30')) || 30);
  const licenseKey = (arg('key') || generateLicenseKey()).trim().toUpperCase();
  const now = Date.now();

  if (!store.usingNeon) {
    console.error('No database URL found. Set DATABASE_URL in .env (or nxql_DATABASE_URL on Vercel).');
    process.exit(1);
  }

  await store.putEntitlement({
    licenseKey,
    tier,
    period: 'monthly',
    status: 'active',
    email,
    expiresAt: now + days * 24 * 60 * 60 * 1000,
    createdAt: now,
    instanceIds: [],
  }, { source: 'admin' });

  console.log('');
  console.log('Test license seeded:');
  console.log(`  Key:    ${licenseKey}`);
  console.log(`  Tier:   ${tier}`);
  console.log(`  Email:  ${email}`);
  console.log(`  Expires: ${new Date(now + days * 24 * 60 * 60 * 1000).toISOString()}`);
  console.log('');
  console.log('Verify:');
  console.log(`  curl -s -X POST 'http://localhost:3000/api/license/validate' \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"licenseKey":"${licenseKey}","instanceId":"test-device-1"}'`);
  console.log('');
  console.log('Extension: set postgresExplorer.license.endpoint to http://localhost:3000/api');
  console.log('           then NexQL: Activate License and paste the key above.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
