/** Common env keys that hold a PostgreSQL URL. */
export const DATABASE_URL_ENV_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'DATABASE_URL_UNPOOLED',
] as const;

const POSTGRES_URL_PREFIX = /^postgres(ql)?:\/\//i;

function stripQuotes(value: string): string {
  let v = value.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) {
      v = v.slice(1, -1);
    }
  }
  return v.trim();
}

/**
 * Parses simple `KEY=value` lines from an .env-style file; only keys accepted by `acceptKey`
 * with values that look like postgres URLs are returned.
 */
export function extractDatabaseUrlsFromEnvText(
  text: string,
  acceptKey: (k: string) => boolean,
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      continue;
    }
    const eq = t.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = t.slice(0, eq).trim();
    if (!acceptKey(key)) {
      continue;
    }
    const value = stripQuotes(t.slice(eq + 1));
    if (!value || !POSTGRES_URL_PREFIX.test(value)) {
      continue;
    }
    out.push({ key, value });
  }
  return out;
}
