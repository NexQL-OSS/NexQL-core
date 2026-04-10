import * as vscode from 'vscode';
import { ConnectionManager } from './ConnectionManager';

const FINGERPRINT_SQL = `
SELECT
  COUNT(*)::text                                    AS object_count,
  COALESCE(MAX(c.oid)::text, '0')                   AS max_oid,
  COALESCE(SUM(c.reltuples)::bigint::text, '0')     AS total_rows_estimate,
  (SELECT COUNT(*)::text FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
     AND nspname NOT LIKE 'pg_%')                   AS schema_count,
  COALESCE((SELECT MAX(oid)::text FROM pg_namespace
            WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
              AND nspname NOT LIKE 'pg_%'), '0')     AS max_schema_oid
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND c.relkind IN ('r', 'v', 'f', 'm', 'p')
`;

const MAX_CONSECUTIVE_FAILURES = 3;

export class SchemaPoller implements vscode.Disposable {
  private fingerprints: Map<string, string> = new Map();
  private consecutiveFailures: number = 0;
  private timer: NodeJS.Timeout | undefined;
  private paused: boolean = false;

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
    this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] Starting — poll interval ${intervalMs}ms.`);
    this.scheduleNext(intervalMs);
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
    this.scheduleNext(intervalMs);
  }

  /**
   * Update the polling interval while running.
   * If currently paused, the new interval takes effect on next resume.
   */
  updateInterval(intervalMs: number): void {
    if (!this.paused && this.timer !== undefined) {
      this.stopTimer();
      this.scheduleNext(intervalMs);
    }
  }

  dispose(): void {
    this.stopTimer();
    this.fingerprints.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private scheduleNext(intervalMs: number): void {
    this.timer = setTimeout(() => this.poll(intervalMs), intervalMs);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(intervalMs: number): Promise<void> {
    const connections: any[] = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const connection = connections.find(c => c.id === this.connectionId);

    if (!connection) {
      this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] Connection not found in configuration; stopping poller.`);
      return;
    }

    // Poll only the database this connection is configured for
    const database = connection.database || 'postgres';
    await this.pollDatabase(connection, database);

    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      this.scheduleNext(intervalMs);
    }
  }

  private async pollDatabase(connection: any, database: string): Promise<void> {
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
      } else if (previous === undefined) {
        this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] Initial fingerprint stored for "${database}": ${fingerprint}`);
      } else {
        this.outputChannel.appendLine(`[SchemaPoller:${this.connectionId}] No change in "${database}" (${fingerprint})`);
      }
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
