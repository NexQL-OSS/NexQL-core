/**
 * Connection form presets for Postgres-compatible platforms.
 * Pure module — no VS Code dependencies (unit-testable).
 */

/** Stored on {@link ConnectionInfo.platformPreset}; mirrors roadmap `PgPlatform` subset. */
export type ConnectionPlatformPreset =
  | 'vanilla'
  | 'neon'
  | 'supabase'
  | 'timescale'
  | 'yugabyte'
  | 'rds'
  | 'aurora'
  | 'cloudsql'
  | 'alloydb'
  | 'azure-flexible';

export interface ConnectionPresetDefaults {
  port: number;
  sslmode: 'prefer' | 'require';
  applicationName?: string;
}

export interface ConnectionPresetDefinition {
  id: ConnectionPlatformPreset;
  label: string;
  /** Basename under `resources/platform-icons/` (without extension). */
  icon: string;
  hint: string;
  defaults: ConnectionPresetDefaults;
  /** Suggested host placeholder for the connection form. */
  hostPlaceholder: string;
}

export const CONNECTION_PLATFORM_PRESETS: readonly ConnectionPresetDefinition[] = [
  {
    id: 'vanilla',
    label: 'PostgreSQL',
    icon: 'postgresql',
    hint: 'Self-hosted, Docker, or any standard PostgreSQL 12–17 server.',
    defaults: { port: 5432, sslmode: 'prefer' },
    hostPlaceholder: 'localhost',
  },
  {
    id: 'neon',
    label: 'Neon',
    icon: 'neon',
    hint: 'Use the direct endpoint (without -pooler) for notebook transactions. SSL required.',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: 'ep-xxx.region.aws.neon.tech',
  },
  {
    id: 'supabase',
    label: 'Supabase',
    icon: 'supabase',
    hint: 'Prefer direct connection or session pooler (port 5432). Avoid transaction pooler (6543).',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: 'db.xxx.supabase.co',
  },
  {
    id: 'timescale',
    label: 'TimescaleDB',
    icon: 'timescale',
    hint: 'Timescale Cloud or self-hosted extension — full PostgreSQL compatibility.',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: 'xxx.tsdb.cloud.timescale.com',
  },
  {
    id: 'yugabyte',
    label: 'YugabyteDB',
    icon: 'yugabytedb',
    hint: 'YSQL wire protocol. Some maintenance commands are no-ops on distributed storage.',
    defaults: { port: 5433, sslmode: 'prefer', applicationName: 'NexQL' },
    hostPlaceholder: '127.0.0.1',
  },
  {
    id: 'rds',
    label: 'AWS RDS PostgreSQL',
    icon: 'aws',
    hint: 'Use the RDS instance endpoint. Set SSL Mode to require.',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: 'mydb.xxx.region.rds.amazonaws.com',
  },
  {
    id: 'aurora',
    label: 'AWS Aurora PostgreSQL',
    icon: 'aurora',
    hint: 'Cluster writer endpoint recommended. SSL Mode require.',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: 'mycluster.cluster-xxx.region.rds.amazonaws.com',
  },
  {
    id: 'cloudsql',
    label: 'Google Cloud SQL',
    icon: 'googlecloud',
    hint: 'Use Cloud SQL Auth Proxy or SSL client certs. SSL Mode require when connecting over the network.',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: '127.0.0.1',
  },
  {
    id: 'alloydb',
    label: 'Google AlloyDB',
    icon: 'alloydb',
    hint: 'AlloyDB for PostgreSQL — use the instance IP or Auth Proxy. SSL Mode require.',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: '127.0.0.1',
  },
  {
    id: 'azure-flexible',
    label: 'Azure Database for PostgreSQL',
    icon: 'azure',
    hint: 'Flexible Server endpoint from the Azure portal. SSL Mode require.',
    defaults: { port: 5432, sslmode: 'require', applicationName: 'NexQL' },
    hostPlaceholder: 'myserver.postgres.database.azure.com',
  },
] as const;

const PRESET_BY_ID = new Map(
  CONNECTION_PLATFORM_PRESETS.map((p) => [p.id, p]),
);

export function getConnectionPreset(
  id: ConnectionPlatformPreset | string | undefined,
): ConnectionPresetDefinition | undefined {
  if (!id) {
    return undefined;
  }
  return PRESET_BY_ID.get(id as ConnectionPlatformPreset);
}

/** Best-effort preset from host/port (for imports and legacy connections). */
export function inferPlatformPresetFromHost(
  host: string,
  port: number,
): ConnectionPlatformPreset {
  const h = (host || '').toLowerCase();
  if (h.includes('.neon.tech')) {
    return 'neon';
  }
  if (h.includes('.supabase.co') || h.includes('.pooler.supabase.com')) {
    return 'supabase';
  }
  if (h.includes('.tsdb.cloud.timescale.com')) {
    return 'timescale';
  }
  if (h.includes('.rds.amazonaws.com')) {
    return port === 5432 && h.includes('.cluster-') ? 'aurora' : 'rds';
  }
  if (h.includes('.postgres.database.azure.com')) {
    return 'azure-flexible';
  }
  return 'vanilla';
}
