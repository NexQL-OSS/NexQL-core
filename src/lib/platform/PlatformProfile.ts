/**
 * Postgres-compatible platform detection types and capability matrix.
 * Pure module — no VS Code dependencies.
 */

export type PgPlatform =
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

export type PoolerMode = 'none' | 'session' | 'transaction';

export interface PlatformCapabilities {
  supportsVacuum: boolean;
  supportsReindex: boolean;
  supportsTablespaces: boolean;
  supportsEventTriggers: boolean;
  supportsListenNotify: boolean;
  supportsPgCron: boolean;
  sessionStateReliable: boolean;
  mayAutosuspend: boolean;
}

export interface PlatformProfile {
  platform: PgPlatform;
  capabilities: PlatformCapabilities;
  poolerMode: PoolerMode;
  badge: string;
  docsUrl?: string;
  /** Major PG version from server_version_num when probed. */
  serverMajor?: number;
}

export const PLATFORM_BADGE_LABELS: Record<PgPlatform, string> = {
  vanilla: 'PostgreSQL',
  neon: 'Neon',
  supabase: 'Supabase',
  timescale: 'TimescaleDB',
  yugabyte: 'YugabyteDB',
  rds: 'RDS',
  aurora: 'Aurora',
  cloudsql: 'Cloud SQL',
  alloydb: 'AlloyDB',
  'azure-flexible': 'Azure PG',
};

export const PLATFORM_DOCS_URLS: Partial<Record<PgPlatform, string>> = {
  neon: 'https://neon.com/docs/connect/connect-from-any-app',
  supabase: 'https://supabase.com/docs/guides/database/connecting-to-postgres',
  timescale: 'https://docs.timescale.com/use-timescale/latest/connect/',
  yugabyte: 'https://docs.yugabyte.com/preview/yugabyte-cloud/cloud-connect/',
};

/** Full-capability baseline (self-hosted vanilla Postgres). */
export const VANILLA_CAPABILITIES: PlatformCapabilities = {
  supportsVacuum: true,
  supportsReindex: true,
  supportsTablespaces: true,
  supportsEventTriggers: true,
  supportsListenNotify: true,
  supportsPgCron: true,
  sessionStateReliable: true,
  mayAutosuspend: false,
};

export function capabilitiesForPlatform(
  platform: PgPlatform,
  poolerMode: PoolerMode,
): PlatformCapabilities {
  const sessionOk = poolerMode !== 'transaction';

  switch (platform) {
    case 'yugabyte':
      return {
        supportsVacuum: false,
        supportsReindex: false,
        supportsTablespaces: false,
        supportsEventTriggers: false,
        supportsListenNotify: false,
        supportsPgCron: false,
        sessionStateReliable: sessionOk,
        mayAutosuspend: false,
      };
    case 'neon':
    case 'supabase':
    case 'timescale':
    case 'cloudsql':
    case 'alloydb':
    case 'azure-flexible':
      return {
        supportsVacuum: true,
        supportsReindex: true,
        supportsTablespaces: false,
        supportsEventTriggers: false,
        supportsListenNotify: sessionOk,
        supportsPgCron: false,
        sessionStateReliable: sessionOk,
        mayAutosuspend: platform === 'neon' || platform === 'timescale',
      };
    case 'rds':
    case 'aurora':
      return {
        ...VANILLA_CAPABILITIES,
        sessionStateReliable: sessionOk,
        supportsListenNotify: sessionOk,
      };
  }

  return {
    ...VANILLA_CAPABILITIES,
    sessionStateReliable: sessionOk,
    supportsListenNotify: sessionOk,
  };
}

export function buildPlatformProfile(
  platform: PgPlatform,
  poolerMode: PoolerMode,
  serverMajor?: number,
): PlatformProfile {
  return {
    platform,
    poolerMode,
    capabilities: capabilitiesForPlatform(platform, poolerMode),
    badge: PLATFORM_BADGE_LABELS[platform],
    docsUrl: PLATFORM_DOCS_URLS[platform],
    serverMajor,
  };
}

export function profileDisplayLabel(profile: PlatformProfile): string {
  if (profile.poolerMode === 'transaction') {
    return `${profile.badge} (pooled)`;
  }
  return profile.badge;
}

export function capabilityTagsForProfile(profile: PlatformProfile | undefined): string[] {
  if (!profile) {
    return [];
  }
  const tags: string[] = [];
  if (!profile.capabilities.supportsVacuum) {
    tags.push('novacuum');
  }
  if (!profile.capabilities.supportsReindex) {
    tags.push('noreindex');
  }
  if (!profile.capabilities.supportsTablespaces) {
    tags.push('notablespace');
  }
  if (!profile.capabilities.supportsEventTriggers) {
    tags.push('noeventtrigger');
  }
  return tags;
}
