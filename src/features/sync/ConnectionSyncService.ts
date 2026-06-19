import * as vscode from 'vscode';
import { contentHash } from './envelope';
import type { ConnectionSyncPayload, PathOverrides, SyncItemMeta } from './types';
import { SYNC_PATH_OVERRIDES_KEY } from './constants';
import type { SyncIndex } from './SyncIndex';

const MACHINE_LOCAL_PATHS = ['sslCertPath', 'sslKeyPath', 'sslRootCertPath'] as const;

/** Sync connection metadata; machine-local paths kept as per-device overrides. */
export class ConnectionSyncService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly index: SyncIndex,
  ) {}

  getPathOverrides(): PathOverrides {
    return this.context.globalState.get<PathOverrides>(SYNC_PATH_OVERRIDES_KEY, {});
  }

  async savePathOverrides(overrides: PathOverrides): Promise<void> {
    await this.context.globalState.update(SYNC_PATH_OVERRIDES_KEY, overrides);
  }

  stripForSync(conn: Record<string, unknown>): ConnectionSyncPayload {
    const payload: ConnectionSyncPayload = {
      id: String(conn.id),
      name: conn.name as string | undefined,
      host: String(conn.host),
      port: Number(conn.port),
      username: conn.username as string | undefined,
      database: conn.database as string | undefined,
      sslmode: conn.sslmode as string | undefined,
      environment: conn.environment as string | undefined,
      readOnlyMode: conn.readOnlyMode as boolean | undefined,
    };

    const group = conn.group as string | undefined;
    if (group?.trim()) {
      payload.group = group.trim();
    }

    if (conn.ssh && typeof conn.ssh === 'object') {
      const ssh = conn.ssh as Record<string, unknown>;
      payload.ssh = {
        enabled: !!ssh.enabled,
        host: String(ssh.host ?? ''),
        port: Number(ssh.port ?? 22),
        username: String(ssh.username ?? ''),
      };
    }

    this.capturePathOverrides(String(conn.id), conn);
    return payload;
  }

  private capturePathOverrides(connectionId: string, conn: Record<string, unknown>): void {
    const overrides = this.getPathOverrides();
    const entry: PathOverrides[string] = {};
    for (const key of MACHINE_LOCAL_PATHS) {
      if (conn[key]) {
        (entry as Record<string, string>)[key] = String(conn[key]);
      }
    }
    if (conn.ssh && typeof conn.ssh === 'object') {
      const ssh = conn.ssh as Record<string, unknown>;
      if (ssh.privateKeyPath) {
        entry.sshPrivateKeyPath = String(ssh.privateKeyPath);
      }
    }
    if (Object.keys(entry).length > 0) {
      overrides[connectionId] = { ...overrides[connectionId], ...entry };
      void this.savePathOverrides(overrides);
    }
  }

  applyPathOverrides(conn: ConnectionSyncPayload): Record<string, unknown> {
    const overrides = this.getPathOverrides()[conn.id] ?? {};
    const result: Record<string, unknown> = { ...conn };
    for (const key of MACHINE_LOCAL_PATHS) {
      const val = (overrides as Record<string, string | undefined>)[key];
      if (val) {
        result[key] = val;
      }
    }
    if (overrides.sshPrivateKeyPath) {
      result.ssh = {
        ...(conn.ssh ?? { enabled: false, host: '', port: 22, username: '' }),
        privateKeyPath: overrides.sshPrivateKeyPath,
      };
    }
    return result;
  }

  collectLocalConnections(deviceId: string): Array<{ meta: SyncItemMeta; plaintext: Buffer }> {
    const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    return connections.map((conn) => {
      const payload = this.stripForSync(conn);
      const plaintext = Buffer.from(JSON.stringify(payload));
      const hash = contentHash(plaintext);
      const { revision, updatedAt } = this.index.observe(String(conn.id), 'connection', hash, {
        name: payload.name ?? `${payload.host}:${payload.port}`,
      });
      return {
        meta: {
          id: String(conn.id),
          kind: 'connection' as const,
          contentHash: hash,
          revision,
          updatedAt,
          deviceId,
          deleted: false,
        },
        plaintext,
      };
    });
  }

  async applyConnection(payload: ConnectionSyncPayload, meta: SyncItemMeta): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const connections = config.get<any[]>('postgresExplorer.connections') || [];
    // Conflict copies arrive under a derived id; keep the payload consistent
    // so the copy does not overwrite the winner.
    const applied = payload.id === meta.id
      ? payload
      : { ...payload, id: meta.id, name: `${payload.name ?? payload.host} (conflict from ${meta.deviceId})` };
    const merged = this.applyPathOverrides(applied);
    const idx = connections.findIndex((c) => c.id === applied.id);
    if (idx >= 0) {
      connections[idx] = { ...connections[idx], ...merged };
    } else {
      connections.push(merged);
    }
    await config.update('postgresExplorer.connections', connections, vscode.ConfigurationTarget.Global);
    this.index.update(applied.id, {
      kind: 'connection',
      name: applied.name ?? `${applied.host}:${applied.port}`,
      lastObservedHash: meta.contentHash,
    });
  }

  /** Remove a connection for a remote tombstone. Stored password stays local. */
  async removeConnection(meta: SyncItemMeta): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const connections = config.get<any[]>('postgresExplorer.connections') || [];
    const remaining = connections.filter((c) => String(c.id) !== meta.id);
    if (remaining.length !== connections.length) {
      await config.update('postgresExplorer.connections', remaining, vscode.ConfigurationTarget.Global);
    }
    this.index.remove(meta.id);
  }
}
