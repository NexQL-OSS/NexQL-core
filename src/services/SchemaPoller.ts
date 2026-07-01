import * as vscode from 'vscode';
import { ConnectionManager } from './ConnectionManager';

const FINGERPRINT_SQL = `
SELECT
  (SELECT COUNT(*)::text FROM pg_class c
   WHERE c.relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema')) AS object_count,
  (SELECT COALESCE(MAX(oid)::text, '0') FROM pg_class) AS max_oid,
  (SELECT COALESCE(SUM(n_live_tup)::text, '0') FROM pg_stat_user_tables) AS total_rows_estimate,
  (SELECT COUNT(*)::text FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema') AS schema_count,
  (SELECT COALESCE(MAX(oid)::text, '0') FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema') AS max_schema_oid
`;

const MAX_CONSECUTIVE_FAILURES = 3;

export class SchemaPoller implements vscode.Disposable {
  private fingerprints: Map<string, string> = new Map();
  private consecutiveFailures: number = 0;
  private timer: NodeJS.Timeout | undefined;
  private paused: boolean = false;

  private baseIntervalMs: number = 30000;
  private currentIntervalMs: number = 30000;
  private noChangeCount: number = 0;
  private readonly MAX_POLL_INTERVAL_MS = 300000; // 5 minutes

  constructor(
    private readonly connectionId: string,
    private readonly onFingerprintChanged: (connectionId: string, database: string) => void,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  /**
   * Start polling at the given interval (milliseconds).
   */
  start(intervalMs: number): void {
    this.stopTimer();
    this.paused = false;
    this.baseIntervalMs = intervalMs;
    this.currentIntervalMs = intervalMs;
    this.noChangeCount = 0;
    this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] Starting — poll interval ${intervalMs}ms.`);
    this.scheduleNext(this.currentIntervalMs);
  }

  /**
   * Pause polling without resetting state.
   */
  pause(): void {
    this.paused = true;
    this.stopTimer();
  }

  /**
   * Resume polling at the given interval.
   */
  resume(intervalMs: number): void {
    this.paused = false;
    this.baseIntervalMs = intervalMs;
    this.currentIntervalMs = intervalMs;
    this.noChangeCount = 0;
    this.scheduleNext(this.currentIntervalMs);
  }

  /**
   * Update the polling interval while running.
   * If currently paused, the new interval takes effect on next resume.
   */
  updateInterval(intervalMs: number): void {
    this.baseIntervalMs = intervalMs;
    this.currentIntervalMs = intervalMs;
    this.noChangeCount = 0;
    if (!this.paused && this.timer !== undefined) {
      this.stopTimer();
      this.scheduleNext(this.currentIntervalMs);
    }
  }

  dispose(): void {
    this.stopTimer();
    this.fingerprints.clear();
  }

  public getFingerprint(database: string): string | undefined {
    return this.fingerprints.get(database);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private scheduleNext(intervalMs: number): void {
    this.timer = setTimeout(() => this.poll(), intervalMs);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    const connections: any[] = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const connection = connections.find(c => c.id === this.connectionId);

    if (!connection) {
      this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] Connection not found in configuration; stopping poller.`);
      return;
    }

    // Poll only the database this connection is configured for
    const database = connection.database || 'postgres';
    const changed = await this.pollDatabase(connection, database);

    if (changed) {
      this.noChangeCount = 0;
      this.currentIntervalMs = this.baseIntervalMs;
    } else {
      this.noChangeCount++;
      if (this.noChangeCount >= 5) {
        // Back off: 1.5x up to 5 minutes
        this.currentIntervalMs = Math.min(Math.floor(this.currentIntervalMs * 1.5), this.MAX_POLL_INTERVAL_MS);
        if (this.noChangeCount === 5 || this.noChangeCount % 5 === 0) {
          this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] No changes detected for ${this.noChangeCount} polls. Backing off interval to ${this.currentIntervalMs}ms.`);
        }
      }
    }

    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      this.scheduleNext(this.currentIntervalMs);
    }
  }

  private async pollDatabase(connection: any, database: string): Promise<boolean> {
    let client: any;
    try {
      client = await ConnectionManager.getInstance().getPooledClient({
        ...connection,
        database,
      });

      const result = await client.query(FINGERPRINT_SQL);
      const row = result.rows[0];
      const fingerprint = `${row.object_count}|${row.max_oid}|${row.total_rows_estimate}|${row.schema_count}|${row.max_schema_oid}`;

      // Reset failure counter on success
      this.consecutiveFailures = 0;

      const previous = this.fingerprints.get(database);
      this.fingerprints.set(database, fingerprint);

      if (previous !== undefined && previous !== fingerprint) {
        this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] Fingerprint changed for "${database}": ${previous} → ${fingerprint}. Triggering refresh.`);
        this.onFingerprintChanged(this.connectionId, database);
        return true;
      } else if (previous === undefined) {
        this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] Initial fingerprint stored for "${database}": ${fingerprint}`);
      } else {
        this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] No change in "${database}" (${fingerprint})`);
      }
      return false;
    } catch (err: any) {
      this.consecutiveFailures++;
      const message = err?.message ?? String(err);
      this.outputChannel.appendLine(
        `[SchemaPoller] Poll failed for connection ${this.connectionId}, database "${database}": ${message}`
      );

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.outputChannel.appendLine(
          `[SchemaPoller] Stopping poller for connection ${this.connectionId} after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`
        );
        this.stopTimer();
      }
      return false;
    } finally {
      if (client) {
        try {
          client.release();
        } catch (_) {
          // ignore release errors
        }
      }
    }
  }
}
