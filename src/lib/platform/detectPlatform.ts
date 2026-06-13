import type { ConnectionPlatformPreset } from './connectionPresets';
import {
  buildPlatformProfile,
  type PgPlatform,
  type PlatformProfile,
  type PoolerMode,
} from './PlatformProfile';

export interface DetectPlatformInput {
  versionString: string;
  hostname: string;
  port: number;
  extensions: string[];
  serverVersionNum: number;
  /** User-selected preset when server probe is incomplete. */
  presetHint?: ConnectionPlatformPreset;
}

function hostLower(hostname: string): string {
  return (hostname || '').toLowerCase();
}

export function detectPoolerMode(hostname: string, port: number): PoolerMode {
  const h = hostLower(hostname);
  if (port === 6543 && (h.includes('supabase') || h.includes('pooler'))) {
    return 'transaction';
  }
  if (h.includes('-pooler') || h.includes('.pooler.')) {
    return 'transaction';
  }
  if (h.includes('pooler.supabase.com')) {
    return port === 5432 ? 'session' : 'transaction';
  }
  return 'none';
}

function extensionSet(extensions: string[]): Set<string> {
  return new Set(extensions.map((e) => e.toLowerCase()));
}

function detectPlatformId(input: DetectPlatformInput): PgPlatform {
  const h = hostLower(input.hostname);
  const ext = extensionSet(input.extensions);
  const version = input.versionString || '';

  if (version.includes('-YB-')) {
    return 'yugabyte';
  }
  if (ext.has('timescaledb') || h.includes('.tsdb.cloud.timescale.com')) {
    return 'timescale';
  }
  if (h.includes('.neon.tech')) {
    return 'neon';
  }
  if (h.includes('.supabase.co') || h.includes('pooler.supabase.com')) {
    return 'supabase';
  }
  if (h.includes('.rds.amazonaws.com')) {
    return h.includes('.cluster-') ? 'aurora' : 'rds';
  }
  if (h.includes('.postgres.database.azure.com')) {
    return 'azure-flexible';
  }
  if (ext.has('google_columnar_engine') || ext.has('alloydb_scann')) {
    return 'alloydb';
  }
  if (ext.has('cloudsql') || h.includes('.sql.goog')) {
    return 'cloudsql';
  }

  if (input.presetHint && input.presetHint !== 'vanilla') {
    return input.presetHint;
  }

  return 'vanilla';
}

export function detectPlatform(input: DetectPlatformInput): PlatformProfile {
  const platform = detectPlatformId(input);
  const poolerMode = detectPoolerMode(input.hostname, input.port);
  const serverMajor =
    input.serverVersionNum > 0
      ? Math.floor(input.serverVersionNum / 10_000)
      : undefined;
  return buildPlatformProfile(platform, poolerMode, serverMajor);
}

export function isTransactionPooler(hostname: string, port: number): boolean {
  return detectPoolerMode(hostname, port) === 'transaction';
}
