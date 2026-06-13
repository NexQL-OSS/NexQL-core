#!/usr/bin/env node
// One-off: scan KV ent:* keys (or .kv-dev.json) and upsert into Neon pgstudio_license.
// Usage: node scripts/backfill-license-kv-to-neon.js [--dry-run]

'use strict';

const path = require('path');
const fs = require('fs');

const licenseDb = require('../api/_lib/license-db');

const ENT_PREFIX = 'ent:';
const DRY_RUN = process.argv.includes('--dry-run');

async function loadKvEntitlements() {
  const useKv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  if (useKv) {
    const { kv } = require('@vercel/kv');
    const keys = [];
    let cursor = 0;
    do {
      const [next, batch] = await kv.scan(cursor, { match: `${ENT_PREFIX}*`, count: 100 });
      cursor = next;
      keys.push(...batch);
    } while (cursor !== 0);

    const ents = [];
    for (const key of keys) {
      const value = await kv.get(key);
      if (value && value.licenseKey) ents.push(value);
    }
    return ents;
  }

  const devPath = path.join(__dirname, '..', '.kv-dev.json');
  const store = JSON.parse(fs.readFileSync(devPath, 'utf8'));
  return Object.entries(store)
    .filter(([k]) => k.startsWith(ENT_PREFIX))
    .map(([, v]) => (v && v.value ? v.value : v))
    .filter((v) => v && v.licenseKey);
}

async function main() {
  if (!licenseDb.isConfigured()) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  await licenseDb.ensureSchema();
  const ents = await loadKvEntitlements();
  console.log(`Found ${ents.length} entitlement(s) to backfill${DRY_RUN ? ' (dry run)' : ''}.`);

  let upserted = 0;
  for (const ent of ents) {
    const existing = await licenseDb.getLicense(ent.licenseKey);
    if (DRY_RUN) {
      console.log(`[dry-run] would upsert ${ent.licenseKey} (existing=${Boolean(existing)})`);
      upserted += 1;
      continue;
    }
    await licenseDb.upsertLicense(ent, { source: 'admin' });
    if (!existing) {
      await licenseDb.appendEvent(ent.licenseKey, 'issued', {
        backfill: true,
        created_at: ent.createdAt || null,
      }, 'admin');
    }
    upserted += 1;
    console.log(`Upserted ${ent.licenseKey}`);
  }

  console.log(`Done. ${upserted} license(s) processed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
