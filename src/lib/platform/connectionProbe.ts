import type { PoolClient } from 'pg';
import type { ConnectionConfig } from '../../common/types';
import type { ConnectionPlatformPreset } from './connectionPresets';
import { detectPlatform, type DetectPlatformInput } from './detectPlatform';
import type { PlatformProfile } from './PlatformProfile';
import { isSupportedPostgresVersion, postgresMajorFromVersionNum } from './pgVersionSupport';

export interface ConnectionProbeResult {
  profile: PlatformProfile;
  serverVersionNum: number;
  versionString: string;
  unsupportedVersion: boolean;
}

export async function probeConnectionPlatform(
  client: Pick<PoolClient, 'query'>,
  config: Pick<ConnectionConfig, 'host' | 'port'> & {
    platformPreset?: ConnectionPlatformPreset;
  },
): Promise<ConnectionProbeResult> {
  const versionRes = await client.query<{ version: string }>('SELECT version() AS version');
  const versionNumRes = await client.query<{ server_version_num: string }>('SHOW server_version_num');
  const extRes = await client.query<{ extname: string }>(
    'SELECT extname FROM pg_extension ORDER BY 1',
  );

  const versionString = versionRes.rows[0]?.version ?? '';
  const serverVersionNum = Number(versionNumRes.rows[0]?.server_version_num ?? 0);
  const extensions = extRes.rows.map((r) => r.extname);

  const input: DetectPlatformInput = {
    versionString,
    hostname: config.host,
    port: config.port,
    extensions,
    serverVersionNum: Number.isFinite(serverVersionNum) ? serverVersionNum : 0,
    presetHint: config.platformPreset,
  };

  const profile = detectPlatform(input);
  if (serverVersionNum > 0) {
    profile.serverMajor = postgresMajorFromVersionNum(serverVersionNum);
  }

  return {
    profile,
    serverVersionNum: Number.isFinite(serverVersionNum) ? serverVersionNum : 0,
    versionString,
    unsupportedVersion:
      serverVersionNum > 0 && !isSupportedPostgresVersion(serverVersionNum),
  };
}
