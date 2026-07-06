import * as vscode from 'vscode';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { NotebooksTreeProvider } from '../providers/NotebooksTreeProvider';
import { SchemaPoller } from './SchemaPoller';
import { Debouncer } from '../lib/debounce';
import { getSchemaCache } from '../lib/schema-cache';

const MIN_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const DEBOUNCE_WINDOW_MS = 500;

/**
 * Reads the `postgresExplorer.autoRefresh.enabled` setting.
 * Defaults to `true` when the setting is absent or not a boolean.
 */
function getAutoRefreshEnabled(): boolean {
  const value = vscode.workspace
    .getConfiguration('postgresExplorer')
    .get<boolean>('autoRefresh.enabled');
  return typeof value === 'boolean' ? value : true;
}

/**
 * Reads `postgresExplorer.autoRefresh.pollIntervalSeconds`, converts to ms,
 * and clamps to a minimum of 10 000 ms.
 */
function getPollIntervalMs(): number {
  const seconds = vscode.workspace
    .getConfiguration('postgresExplorer')
    .get<number>('autoRefresh.pollIntervalSeconds') ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const ms = seconds * 1_000;
  return Math.max(ms, MIN_POLL_INTERVAL_MS);
}

export class AutoRefreshService implements vscode.Disposable {
  private static instance: AutoRefreshService | undefined;
  private readonly pollers: Map<string, SchemaPoller> = new Map();
  private readonly debouncer = new Debouncer();
  private readonly disposables: vscode.Disposable[] = [];
  private _enabled: boolean = true;

  constructor(
    private readonly databaseTreeProvider: DatabaseTreeProvider,
    private readonly notebooksTreeProvider: NotebooksTreeProvider,
    private readonly globalStorageUri: vscode.Uri,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    AutoRefreshService.instance = this;
  }

  public static getFingerprint(connectionId: string, database: string): string | undefined {
    return AutoRefreshService.instance?.pollers.get(connectionId)?.getFingerprint(database);
  }

  /** Called once during extension activation. */
  start(): void {
    try {
      this._enabled = getAutoRefreshEnabled();

      // Configuration_Watcher: listen for postgresExplorer config changes
      const configListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('postgresExplorer')) {
          return;
        }

        // Handle autoRefresh.enabled toggle
        if (e.affectsConfiguration('postgresExplorer.autoRefresh.enabled')) {
          const nowEnabled = getAutoRefreshEnabled();
          if (!nowEnabled && this._enabled) {
            // Transitioning to disabled: stop all pollers and unregister watchers
            this._enabled = false;
            for (const poller of this.pollers.values()) {
              poller.dispose();
            }
            this.pollers.clear();
            for (const d of this.disposables) {
              d.dispose();
            }
            this.disposables.length = 0;
          } else if (nowEnabled && !this._enabled) {
            // Transitioning to enabled: re-register watchers and restart pollers
            this._enabled = true;
            this._registerWatchers();
            const connections = vscode.workspace
              .getConfiguration()
              .get<any[]>('postgresExplorer.connections') ?? [];
            for (const conn of connections) {
              if (conn.id) {
                this.onConnectionConnected(conn.id as string);
              }
            }
          }
          return;
        }

        if (!this._enabled) {
          return;
        }

        if (e.affectsConfiguration('postgresExplorer.autoRefresh.pollIntervalSeconds')) {
          const newIntervalMs = getPollIntervalMs();
          for (const poller of this.pollers.values()) {
            poller.updateInterval(newIntervalMs);
          }
        }

        if (e.affectsConfiguration('postgresExplorer.connections')) {
          const oldIds = new Set(this.pollers.keys());

          this.debouncer.debounce('config-refresh', () => {
            this.databaseTreeProvider.refresh();

            const newConnections = vscode.workspace
              .getConfiguration()
              .get<any[]>('postgresExplorer.connections') ?? [];
            const newIds = new Set(newConnections.map((c: any) => c.id as string));

            // Start pollers for newly added connections
            for (const id of newIds) {
              if (!oldIds.has(id)) {
                this.onConnectionConnected(id);
              }
            }

            // Dispose pollers for removed connections
            for (const id of oldIds) {
              if (!newIds.has(id)) {
                const poller = this.pollers.get(id);
                if (poller) {
                  poller.dispose();
                  this.pollers.delete(id);
                }
              }
            }
          }, DEBOUNCE_WINDOW_MS);
        }
      });

      this.disposables.push(configListener);

      if (this._enabled) {
        this._registerWatchers();
        this._startPollerForAllConnections();
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.outputChannel.appendLine(
        `[AutoRefreshService] Initialisation error: ${message}`
      );
    }
  }

  /** Starts pollers for all currently configured connections. */
  private _startPollerForAllConnections(): void {
    const connections = vscode.workspace
      .getConfiguration()
      .get<any[]>('postgresExplorer.connections') ?? [];
    this.outputChannel.appendLine(`[AutoRefreshService] Starting pollers for ${connections.length} configured connection(s).`);
    for (const conn of connections) {
      if (conn.id) {
        this.onConnectionConnected(conn.id as string);
      }
    }
  }

  /** Registers the File_Watcher and pushes it to disposables. */
  private _registerWatchers(): void {    // File_Watcher: watch for .pgsql notebook file changes in global storage
    try {
      const pattern = new vscode.RelativePattern(this.globalStorageUri, '**/*.pgsql');
      const fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

      const onFileEvent = () => {
        this.debouncer.debounce('notebooks-refresh', () => {
          this.notebooksTreeProvider.refresh();
          this.databaseTreeProvider.refresh();
        }, DEBOUNCE_WINDOW_MS);
      };

      fileWatcher.onDidCreate(async uri => {
        try {
          const { NotebookIndexService } = require('./NotebookIndexService');
          await NotebookIndexService.getInstance().updateNotebook(uri);
        } catch {}
        onFileEvent();
      });
      fileWatcher.onDidDelete(uri => {
        try {
          const { NotebookIndexService } = require('./NotebookIndexService');
          NotebookIndexService.getInstance().removeNotebook(uri);
        } catch {}
        onFileEvent();
      });
      fileWatcher.onDidChange(async uri => {
        try {
          const { NotebookIndexService } = require('./NotebookIndexService');
          await NotebookIndexService.getInstance().updateNotebook(uri);
        } catch {}
        onFileEvent();
      });

      this.disposables.push(fileWatcher);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.outputChannel.appendLine(
        `[AutoRefreshService] FileSystemWatcher creation failed: ${message}. Notebooks panel will fall back to manual refresh.`
      );
    }
  }

  /**
   * Called by DatabaseTreeProvider when a connection becomes active.
   * Starts a SchemaPoller for the connection if one is not already running.
   */
  onConnectionConnected(connectionId: string): void {
    if (!this._enabled) {
      return;
    }
    if (!this.pollers.has(connectionId)) {
      const poller = new SchemaPoller(
        connectionId,
        (connId, database) => {
          getSchemaCache().invalidateDatabase(connId, database);
          this.databaseTreeProvider.refresh();

          // Trigger index rebuild if auto-indexing is unlocked
          try {
            const { isProFeatureEnabled, ProFeature } = require('./featureGates');
            if (isProFeatureEnabled(ProFeature.DbIndexAuto)) {
              vscode.commands.executeCommand('postgres-explorer.dbindex.updateBackground', connId, database);
            }
          } catch (e) {
            this.outputChannel.appendLine(`[AutoRefreshService] Failed to trigger background index rebuild: ${e}`);
          }
        },
        this.outputChannel
      );
      poller.start(getPollIntervalMs());
      this.pollers.set(connectionId, poller);
    }

    // Ensure the database index exists (first build) or is fresh — covers the
    // activation scan, newly created connections, and tree reconnects.
    try {
      const { isProFeatureEnabled, ProFeature } = require('./featureGates');
      if (isProFeatureEnabled(ProFeature.DbIndexAuto)) {
        vscode.commands.executeCommand('postgres-explorer.dbindex.updateBackground', connectionId);
      }
    } catch (e) {
      this.outputChannel.appendLine(`[AutoRefreshService] Failed to trigger auto-index: ${e}`);
    }
  }

  /**
   * Called by DatabaseTreeProvider when a connection becomes inactive.
   * Pauses the SchemaPoller for the connection.
   */
  onConnectionDisconnected(connectionId: string): void {
    if (!this._enabled) {
      return;
    }
    const poller = this.pollers.get(connectionId);
    if (poller) {
      poller.pause();
    }
  }

  dispose(): void {
    for (const poller of this.pollers.values()) {
      poller.dispose();
    }
    this.pollers.clear();

    this.debouncer.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

export { getAutoRefreshEnabled, getPollIntervalMs };
