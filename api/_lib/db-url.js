// Resolve Neon/Postgres connection URL from standard or Vercel-prefixed env vars.
//
// Vercel Neon marketplace injects prefixed names (e.g. nxql_DATABASE_URL). Local dev
// typically uses unprefixed DATABASE_URL / POSTGRES_URL from .env.

const POSTGRES_PREFIX = /^postgres(ql)?:\/\//i;

/** Keys that are not suitable for serverless HTTP driver (pooler preferred). */
const SKIP_KEY = /(_UNPOOLED|_NON_POOLING|_NO_SSL|PRISMA_URL)$/i;

/**
 * @returns {string | null}
 */
function resolveDatabaseUrl() {
  const direct = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (direct && POSTGRES_PREFIX.test(direct)) {
    return direct;
  }

  const candidates = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !POSTGRES_PREFIX.test(value)) continue;
    if (key === 'DATABASE_URL' || key === 'POSTGRES_URL') continue;
    if (!key.includes('DATABASE') && !key.includes('POSTGRES')) continue;
    if (SKIP_KEY.test(key)) continue;
    candidates.push({ key, value });
  }

  candidates.sort((a, b) => {
    const poolA = a.value.includes('-pooler') ? 0 : 1;
    const poolB = b.value.includes('-pooler') ? 0 : 1;
    if (poolA !== poolB) return poolA - poolB;
    const da = a.key.endsWith('_DATABASE_URL') ? 0 : 1;
    const db = b.key.endsWith('_DATABASE_URL') ? 0 : 1;
    return da - db;
  });

  return candidates[0]?.value ?? null;
}

function isDatabaseConfigured() {
  return Boolean(resolveDatabaseUrl());
}

module.exports = { resolveDatabaseUrl, isDatabaseConfigured };
