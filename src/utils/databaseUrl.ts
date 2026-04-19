import { parse } from 'pg-connection-string';
import type { ConnectionInfo } from '../features/connections/connectionForm';

const VALID_SSL = new Set<string>([
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
]);

/**
 * Maps a `postgres://` / `postgresql://` URL into a {@link ConnectionInfo} row (password kept only in memory until persisted).
 */
export function connectionInfoFromDatabaseUrl(rawUrl: string, id: string): ConnectionInfo {
  const trimmed = rawUrl.trim();
  const parsed = parse(trimmed);
  const host = parsed.host || 'localhost';
  const portRaw = parsed.port;
  const port =
    portRaw !== undefined && portRaw !== null && String(portRaw) !== ''
      ? parseInt(String(portRaw), 10)
      : 5432;
  if (Number.isNaN(port)) {
    throw new Error('Invalid port in database URL');
  }
  const database = parsed.database || 'postgres';
  const username = parsed.user || undefined;
  const password = parsed.password || undefined;

  let sslmode: ConnectionInfo['sslmode'] = 'prefer';
  const sm = typeof parsed.sslmode === 'string' ? parsed.sslmode : undefined;
  if (sm && VALID_SSL.has(sm)) {
    sslmode = sm as ConnectionInfo['sslmode'];
  } else if (parsed.ssl === false) {
    sslmode = 'disable';
  }

  const name = `${host}:${port}/${database}`;

  return {
    id,
    name,
    host,
    port,
    username,
    password,
    database,
    sslmode,
    environment: 'development',
    readOnlyMode: false,
  };
}

/** Host:port/db preview for UI (no password). */
export function previewDatabaseUrl(rawUrl: string): string {
  try {
    const p = parse(rawUrl.trim());
    const host = p.host || '?';
    const port = p.port ? String(p.port) : '5432';
    const db = p.database || '?';
    return `${host}:${port}/${db}`;
  } catch {
    return '(unparseable URL)';
  }
}
