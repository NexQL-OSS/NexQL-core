import type { PoolClient } from 'pg';
import type { ConnectionConfig } from '../common/types';
import type { ConnectionInfo } from '../features/connections/connectionStore';
import {
  getConnectionPreset,
  inferPlatformPresetFromHost,
  type ConnectionPlatformPreset,
} from '../lib/platform/connectionPresets';
import { probeConnectionPlatform } from '../lib/platform/connectionProbe';
import { detectPlatform } from '../lib/platform/detectPlatform';
import { profileDisplayLabel, type PlatformProfile } from '../lib/platform/PlatformProfile';

export interface CachedConnectionPlatform {
  profile: PlatformProfile;
  serverVersionNum: number;
  versionString: string;
  unsupportedVersion: boolean;
}

/**
 * Caches platform profiles and server versions per `{connectionId}:{database}`.
 */
export class PlatformConnectionService {
  private static instance: PlatformConnectionService;
  private readonly cache = new Map<string, CachedConnectionPlatform>();

  public static getInstance(): PlatformConnectionService {
    if (!PlatformConnectionService.instance) {
      PlatformConnectionService.instance = new PlatformConnectionService();
    }
    return PlatformConnectionService.instance;
  }

  private cacheKey(connectionId: string, database: string): string {
    return `${connectionId}:${database || 'postgres'}`;
  }

  public getCached(
    connectionId: string,
    database?: string,
  ): CachedConnectionPlatform | undefined {
    return this.cache.get(this.cacheKey(connectionId, database || 'postgres'));
  }

  public getProfile(
    connectionId: string,
    database?: string,
  ): PlatformProfile | undefined {
    return this.getCached(connectionId, database)?.profile;
  }

  /** Profile from preset/host when not yet probed. */
  public getEstimatedProfile(connection: ConnectionInfo): PlatformProfile {
    const cached = this.getCached(connection.id, connection.database);
    if (cached) {
      return cached.profile;
    }
    const preset: ConnectionPlatformPreset =
      connection.platformPreset ??
      inferPlatformPresetFromHost(connection.host, connection.port);
    const presetDef = getConnectionPreset(preset);
    return detectPlatform({
      versionString: '',
      hostname: connection.host,
      port: connection.port,
      extensions: preset === 'timescale' ? ['timescaledb'] : [],
      serverVersionNum: 0,
      presetHint: preset,
    });
  }

  public async probeIfNeeded(
    config: ConnectionConfig & { platformPreset?: ConnectionPlatformPreset },
    client: PoolClient,
  ): Promise<CachedConnectionPlatform> {
    const key = this.cacheKey(config.id, config.database || 'postgres');
    const existing = this.cache.get(key);
    if (existing) {
      return existing;
    }

    const result = await probeConnectionPlatform(client, config);
    const entry: CachedConnectionPlatform = {
      profile: result.profile,
      serverVersionNum: result.serverVersionNum,
      versionString: result.versionString,
      unsupportedVersion: result.unsupportedVersion,
    };
    this.cache.set(key, entry);
    return entry;
  }

  public invalidateConnection(connectionId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${connectionId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
  }

  public connectionTooltipSuffix(connection: ConnectionInfo): string {
    const profile = this.getEstimatedProfile(connection);
    const label = profileDisplayLabel(profile);
    const major =
      this.getCached(connection.id, connection.database)?.profile.serverMajor ??
      profile.serverMajor;
    const parts = [`Platform: ${label}`];
    if (major) {
      parts.push(`PostgreSQL ${major}`);
    }
    return parts.join('\n');
  }
}
