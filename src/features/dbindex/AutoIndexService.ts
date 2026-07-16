import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/ConnectionManager';
import { getStoredConnections } from '../connections/connectionStore';
import { IndexBuilder } from './IndexBuilder';
import { IndexStore } from './IndexStore';
import { IndexScope } from './types';
import { fetchSchemaFingerprint, listNonSystemSchemas } from './catalogQueries';

const AUTO_BUILD_SETTING = 'postgresExplorer.dbIndex.autoBuild';
const KEY_SEPARATOR = '\u0000';
const ATTEMPT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Keeps database indexes up to date without user initiation. Enqueued from
 * connection lifecycle events (activation scan, new connection, schema drift)
 * and drains serially: at most one build at a time, per-key cooldown for
 * unreachable databases, silent failures (output channel only).
 *
 * Staleness is decided by comparing the manifest's schemaFingerprint against
 * a fresh builder-format fingerprint — never against SchemaPoller's
 * fingerprint, which uses a different format.
 */
export class AutoIndexService implements vscode.Disposable {
  private static instance: AutoIndexService | undefined;

  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly lastFailureAt = new Map<string, number>();
  private draining = false;
  private disposed = false;
  private currentBuild: vscode.CancellationTokenSource | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public static initialize(
    globalStorageUri: vscode.Uri,
    outputChannel: vscode.OutputChannel
  ): AutoIndexService {
    if (!AutoIndexService.instance) {
      const store = new IndexStore(globalStorageUri);
      AutoIndexService.instance = new AutoIndexService(store, new IndexBuilder(store), outputChannel);
    }
    return AutoIndexService.instance;
  }

  public static getInstance(): AutoIndexService | undefined {
    return AutoIndexService.instance;
  }

  constructor(
    private readonly store: IndexStore,
    private readonly builder: IndexBuilder,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(AUTO_BUILD_SETTING) && this.isAutoBuildEnabled()) {
          this.ensureAll();
        }
      })
    );
  }

  /**
   * Enqueue an index check for one connection. Fire-and-forget: never throws,
   * never prompts. When `database` is omitted it falls back to the
   * connection's configured database.
   */
  public ensureIndex(connectionId: string, database?: string): void {
    if (this.disposed) {
      return;
    }
    const connection = getStoredConnections().find(c => c.id === connectionId);
    if (!connection) {
      return;
    }
    const db = database || connection.database || 'postgres';
    const key = `${connectionId}${KEY_SEPARATOR}${db}`;
    if (this.queued.has(key)) {
      return;
    }
    this.queued.add(key);
    this.queue.push(key);
    void this.drain();
  }

  /** Enqueue every configured connection (activation scan, license/setting change). */
  public ensureAll(): void {
    for (const connection of getStoredConnections()) {
      this.ensureIndex(connection.id);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.queued.clear();
    this.currentBuild?.cancel();
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    if (AutoIndexService.instance === this) {
      AutoIndexService.instance = undefined;
    }
  }

  private isAutoBuildEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(AUTO_BUILD_SETTING, true);
  }

  private isGateOpen(): boolean {
    if (!this.isAutoBuildEnabled()) {
      return false;
    }
    try {
      // Lazy require to keep feature gating out of the activation path
      // (same pattern as AutoRefreshService).
      const { isProFeatureEnabled, ProFeature } = require('../../services/featureGates');
      return isProFeatureEnabled(ProFeature.DbIndexAuto);
    } catch {
      return false;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const key = this.queue.shift()!;
        const [connectionId, database] = key.split(KEY_SEPARATOR);
        try {
          await this.processOne(connectionId, database);
        } catch (err: any) {
          this.outputChannel.appendLine(
            `[AutoIndex] Unexpected error for ${database}: ${err?.message || err}`
          );
        } finally {
          // Removed only after processing so re-triggers while a check/build
          // is in flight are deduped, not queued behind it.
          this.queued.delete(key);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async processOne(connectionId: string, database: string): Promise<void> {
    if (!this.isGateOpen()) {
      return;
    }
    const connection = getStoredConnections().find(c => c.id === connectionId);
    if (!connection) {
      return;
    }
    // Cooldown only tracks *failed* attempts (unreachable DB, missing
    // credentials). Successful probes are never throttled — a skipped drift
    // event would otherwise leave the index stale until the next trigger.
    const key = `${connectionId}${KEY_SEPARATOR}${database}`;
    const lastFailure = this.lastFailureAt.get(key);
    if (lastFailure !== undefined && Date.now() - lastFailure < ATTEMPT_COOLDOWN_MS) {
      return;
    }

    const baseDir = this.store.getBaseDir(connectionId, database);
    const manifest = await this.store.readManifest(baseDir);

    // Probe the database: fingerprint for staleness, schema list for a first
    // build. Credential resolution is silent (SecretStorage / .pgpass) — a
    // failure here means unreachable or no stored credentials; back off.
    let scope: IndexScope;
    const depth = manifest?.buildDepth ?? 'structure';
    const environment = manifest?.environment ?? connection.environment ?? 'development';
    let client: any;
    try {
      client = await ConnectionManager.getInstance().getPooledClient({
        ...connection,
        database,
      } as any);
      if (manifest) {
        const liveFingerprint = await fetchSchemaFingerprint(client);
        const indexAge = Date.now() - new Date(manifest.indexedAt).getTime();
        const isStale = indexAge > 7 * 24 * 60 * 60 * 1000; // 1 week
        if (liveFingerprint === manifest.schemaFingerprint && !isStale) {
          this.outputChannel.appendLine(`[AutoIndex] Index up to date for ${database}.`);
          return;
        }
        if (isStale) {
          this.outputChannel.appendLine(
            `[AutoIndex] Index for ${database} is stale (${Math.floor(indexAge / (24 * 60 * 60 * 1000))} days old) - rebuilding silently.`
          );
        }
        scope = manifest.scope;
      } else {
        const schemas = await listNonSystemSchemas(client);
        if (schemas.length === 0) {
          this.outputChannel.appendLine(`[AutoIndex] No schemas to index in ${database}.`);
          return;
        }
        scope = { includedSchemas: schemas, excludedObjects: [], piiExcludedColumns: [] };
      }
    } catch (err: any) {
      this.lastFailureAt.set(key, Date.now());
      this.outputChannel.appendLine(
        `[AutoIndex] Skipping ${database} (unreachable or credentials unavailable): ${err?.message || err}`
      );
      return;
    } finally {
      if (client) {
        try { client.release(); } catch { /* ignore */ }
      }
    }

    if (!(await this.store.acquireLock(baseDir))) {
      this.outputChannel.appendLine(
        `[AutoIndex] Another window is building the index for ${database}; skipping.`
      );
      return;
    }
    this.currentBuild = new vscode.CancellationTokenSource();
    try {
      this.outputChannel.appendLine(
        `[AutoIndex] ${manifest ? 'Rebuilding stale' : 'Building'} index for ${database}...`
      );
      await this.builder.build(
        connectionId,
        database,
        scope,
        depth,
        'auto',
        environment,
        this.currentBuild.token
      );
      this.outputChannel.appendLine(`[AutoIndex] Index build complete for ${database}.`);
      await this.refreshPanels();
    } catch (err: any) {
      this.outputChannel.appendLine(
        `[AutoIndex] Index build failed for ${database}: ${err?.message || err}`
      );
    } finally {
      this.currentBuild.dispose();
      this.currentBuild = undefined;
      await this.store.releaseLock(baseDir);
    }
  }

  private async refreshPanels(): Promise<void> {
    try {
      const { SettingsHubPanel } = await import('../settings/SettingsHubPanel');
      if (SettingsHubPanel.currentPanel) {
        SettingsHubPanel.currentPanel.refreshSection('dbindex');
      }
    } catch { /* panel not open */ }
    try {
      const { DbIndexPanel } = await import('./panel/DbIndexPanel');
      if (DbIndexPanel.currentPanel) {
        DbIndexPanel.currentPanel.refreshState();
      }
    } catch { /* panel not open */ }
  }
}
