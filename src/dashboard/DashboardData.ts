

export interface DashboardStats {
  dbName: string;
  owner: string;
  size: string;
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
  totalConnections: number;
  maxConnections: number;
  extensionCount: number;
  topTables: { name: string; size: string; rawSize: number }[];
  connectionStates: { state: string; count: number }[];
  objectCounts: {
    schemas: number;
    tables: number;
    views: number;
    functions: number;
    sequences: number;
  };
  activeQueries: {
    pid: number;
    usename: string;
    datname: string;
    state: string;
    waitEventType?: string;
    waitEvent?: string;
    xactStart?: string;
    duration: string;
    startTime: string;
    query: string;
  }[];
  blockingLocks: {
    blocked_pid: number;
    blocked_user: string;
    blocking_pid: number;
    blocking_user: string;
    blocked_query: string;
    blocking_query: string;
    lock_mode: string;
    locked_object: string;
  }[];
  metrics: {
    xact_commit: number;
    xact_rollback: number;
    blks_read: number;
    blks_hit: number;
    deadlocks: number;
    conflicts: number;
    temp_bytes: number;
    temp_files: number;
    checkpoints_timed: number;
    checkpoints_req: number;
    tuples_fetched: number;
    tuples_returned: number;
  };
  pgStatStatements?: {
    query: string;
    calls: number;
    total_time: number;
    mean_time: number;
    rows: number;
  }[];
  waitEvents: { type: string; count: number }[];
  longRunningQueries: number;
  indexHitRatio: number;
  oldestTransactionAgeSeconds: number;
  vacuumTablesNeedingAttention: number;

  /** WAL / replication (may be partially empty if views are inaccessible). */
  walReplication: WalReplicationStats;

  /** Schema health: indexes that have never been scanned. */
  unusedIndexes: { index_name: string; table_name: string; index_size: string; raw_size: number }[];
  /** Tables where sequential scans dominate over index scans. */
  highSeqScanTables: { table_name: string; seq_scan: number; idx_scan: number; seq_scan_pct: number; row_count: number }[];
  /** Tables with significant dead-tuple bloat. */
  tableBloat: { table_name: string; n_live_tup: number; n_dead_tup: number; bloat_pct: number; table_size: string }[];
  /** Currently running autovacuum workers. */
  autovacuumProgress: { pid: number; table_name: string; phase: string; heap_blks_scanned: number; heap_blks_total: number }[];
  /** Tables with notable dead tuples that need vacuum. */
  tablesNeedingVacuum: { table_name: string; n_dead_tup: number; n_live_tup: number; last_autovacuum: string | null; last_autoanalyze: string | null }[];
  /** Active connections grouped by application_name and state. */
  connectionsByApp: { application_name: string; state: string; count: number }[];
}

export interface WalReplicationStats {
  inRecovery: boolean;
  currentWalLsn: string | null;
  receiveLsn: string | null;
  replayLsn: string | null;
  /** Bytes standby is behind receive on replay (standby only). */
  replayLagBytes: number | null;
  replicas: Array<{
    application_name: string | null;
    client_addr: string | null;
    state: string | null;
    sent_lsn: string | null;
    write_lsn: string | null;
    flush_lsn: string | null;
    replay_lsn: string | null;
    write_lag: string | null;
    flush_lag: string | null;
    replay_lag: string | null;
    sync_state: string | null;
    backend_start: string | null;
  }>;
  walReceiver: {
    status: string | null;
    received_lsn: string | null;
    latest_end_lsn: string | null;
    slot_name: string | null;
    sender_host: string | null;
    sender_port: number | null;
    last_msg_receipt_time: string | null;
  } | null;
  settings: Record<string, string>;
  pgStatWal: Record<string, string | number> | null;
  replicationSlots: Array<{
    slot_name: string;
    plugin: string | null;
    slot_type: string | null;
    active: boolean;
    wal_status: string | null;
    restart_lsn: string | null;
    confirmed_flush_lsn: string | null;
  }>;
}

import { Client, PoolClient } from 'pg';

export async function fetchStats(client: Client | PoolClient, dbName: string): Promise<DashboardStats> {
  // Fetch data with error handling for each query to prevent one failure from breaking the entire dashboard
  const [
    dbInfoRes,
    connRes,
    tableRes,
    extRes,
    countsRes,
    activeQueriesRes,
    locksRes,
    metricsRes,
    settingsRes,
    pgStatRes,
    waitsRes,
    longQueriesRes,
    indexHitRes,
    oldestTxRes,
    vacuumHealthRes,
    walSnapshotRes,
    walReplRes,
    walSettingsRes,
    walReceiverRes,
    pgStatWalRes,
    replSlotsRes,
    unusedIndexesRes,
    highSeqScanRes,
    tableBloatRes,
    autovacuumProgressRes,
    tablesNeedingVacuumRes,
    connectionsByAppRes,
  ] = await Promise.allSettled([
    // DB Info
    client.query(`
            SELECT pg_catalog.pg_get_userbyid(d.datdba) as owner,
                   pg_size_pretty(pg_database_size(d.datname)) as size
            FROM pg_database d
            WHERE d.datname = $1
        `, [dbName]),

    // Connection States (Active, Idle, Waiting)
    client.query(`
            SELECT state, wait_event_type IS NOT NULL as waiting, count(*) as count
            FROM pg_stat_activity
            WHERE datname = $1
            GROUP BY state, waiting
        `, [dbName]),

    // Top Tables
    client.query(`
            SELECT schemaname || '.' || tablename as name,
                   pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as size,
                   pg_total_relation_size(schemaname || '.' || tablename) as raw_size
            FROM pg_tables
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
            ORDER BY raw_size DESC
            LIMIT 10
        `),

    // Extension Count
    client.query(`SELECT count(*) as count FROM pg_available_extensions WHERE installed_version IS NOT NULL`),

    // Object Counts
    client.query(`
            SELECT
                (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema')) as schemas,
                (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) as tables,
                (SELECT count(*) FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) as views,
                (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')) as functions,
                (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')) as sequences
        `),

    // Active Queries (including idle)
    client.query(`
           SELECT pid, usename, datname, state,
             wait_event_type,
             wait_event,
            xact_start,
                   (now() - query_start)::text as duration,
                   query_start,
                   query
            FROM pg_stat_activity
            WHERE pid != pg_backend_pid()
            AND datname = $1
            ORDER BY state = 'active' DESC, query_start ASC
            LIMIT 100
        `, [dbName]),

    // Blocking Locks
    client.query(`
            SELECT
                blocked_locks.pid     AS blocked_pid,
                blocked_activity.usename  AS blocked_user,
                blocking_locks.pid     AS blocking_pid,
                blocking_activity.usename AS blocking_user,
                blocked_activity.query    AS blocked_query,
                blocking_activity.query   AS blocking_query,
                blocked_locks.mode        AS lock_mode,
                COALESCE(c.relname, 'null') AS locked_object
            FROM  pg_catalog.pg_locks         blocked_locks
            JOIN pg_catalog.pg_stat_activity blocked_activity  ON blocked_activity.pid = blocked_locks.pid
            JOIN pg_catalog.pg_locks         blocking_locks 
                ON blocking_locks.locktype = blocked_locks.locktype
                AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
                AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
                AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
                AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
                AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
                AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
                AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
                AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
                AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
                AND blocking_locks.pid != blocked_locks.pid
            JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
            LEFT JOIN pg_catalog.pg_class c ON c.oid = blocked_locks.relation
            WHERE NOT blocked_locks.granted
            AND blocking_activity.datname = $1
        `, [dbName]),

    // Database Metrics (Throughput & I/O & Conflicts/Deadlocks)
    // Select all columns to be robust against version differences (e.g. checkpoints_timed removed in PG 17)
    client.query(`
            SELECT *
            FROM pg_stat_database 
            WHERE datname = $1
        `, [dbName]),

    // Settings (Max Connections)
    client.query(`SHOW max_connections`),

    // pg_stat_statements (Top Queries) - Safe selection that returns empty if extension missing
    // We use a check to avoid error log spam if possible, or just let it fail gracefully via allSettled
    client.query(`
            SELECT query, calls, total_time, mean_time, rows
            FROM pg_stat_statements
            WHERE dbid = (SELECT oid FROM pg_database WHERE datname = $1)
            ORDER BY total_time DESC
            LIMIT 10
    `, [dbName]),

    // Wait Events Information
    client.query(`
            SELECT wait_event_type, count(*) as count
            FROM pg_stat_activity
            WHERE wait_event_type IS NOT NULL
            AND datname = $1
            GROUP BY wait_event_type
            ORDER BY count DESC
            LIMIT 3
    `, [dbName]),

    // Long Running Queries Count (> 5 seconds)
    client.query(`
            SELECT count(*) as count
            FROM pg_stat_activity
            WHERE state = 'active'
            AND (now() - query_start) > interval '5 seconds'
            AND datname = $1
    `, [dbName])

        ,

        // Index hit ratio (different from shared buffer cache hit ratio)
        client.query(`
          SELECT
            COALESCE(
        100.0 * SUM(idx_blks_hit) / NULLIF(SUM(idx_blks_hit + idx_blks_read), 0),
        100.0
            ) AS index_hit_ratio
          FROM pg_statio_user_tables
        `),

        // Oldest open transaction age (seconds)
        client.query(`
          SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - xact_start))), 0)::bigint AS oldest_tx_age_seconds
          FROM pg_stat_activity
          WHERE datname = $1
            AND xact_start IS NOT NULL
            AND pid != pg_backend_pid()
        `, [dbName]),

        // Vacuum attention signal: user tables with substantial dead tuples
        client.query(`
          SELECT COUNT(*)::int AS tables_needing_attention
          FROM pg_stat_user_tables
          WHERE n_dead_tup > GREATEST((n_live_tup * 0.2)::bigint, 1000)
        `),

    // WAL / replication snapshot (safe on primary and standby)
    client.query(`
      SELECT
        pg_is_in_recovery() AS in_recovery,
        CASE WHEN NOT pg_is_in_recovery() THEN pg_current_wal_lsn()::text ELSE NULL END AS current_wal_lsn,
        CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn()::text ELSE NULL END AS receive_lsn,
        CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text ELSE NULL END AS replay_lsn,
        CASE
          WHEN pg_is_in_recovery()
            AND pg_last_wal_receive_lsn() IS NOT NULL
            AND pg_last_wal_replay_lsn() IS NOT NULL
          THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())
          ELSE NULL
        END AS replay_lag_bytes
    `),

    client.query(`
      SELECT
        application_name,
        client_addr::text AS client_addr,
        state,
        sent_lsn::text AS sent_lsn,
        write_lsn::text AS write_lsn,
        flush_lsn::text AS flush_lsn,
        replay_lsn::text AS replay_lsn,
        write_lag::text AS write_lag,
        flush_lag::text AS flush_lag,
        replay_lag::text AS replay_lag,
        sync_state,
        backend_start::text AS backend_start
      FROM pg_stat_replication
      ORDER BY application_name NULLS LAST, pid
    `),

    client.query(`
      SELECT name, setting, unit
      FROM pg_settings
      WHERE name IN (
        'wal_level',
        'max_wal_size',
        'min_wal_size',
        'archive_mode',
        'synchronous_standby_names',
        'archive_command'
      )
    `),

    client.query(`
      SELECT
        status,
        received_lsn::text AS received_lsn,
        latest_end_lsn::text AS latest_end_lsn,
        slot_name,
        sender_host::text AS sender_host,
        sender_port,
        last_msg_receipt_time::text AS last_msg_receipt_time
      FROM pg_stat_wal_receiver
      LIMIT 1
    `),

    client.query(`
      SELECT
        wal_records,
        wal_fpi,
        wal_bytes,
        wal_buffers_full,
        wal_write,
        wal_sync,
        wal_write_time,
        wal_sync_time,
        stats_reset::text AS stats_reset
      FROM pg_stat_wal
    `),

    client.query(`
      SELECT
        slot_name,
        plugin::text AS plugin,
        slot_type,
        active,
        wal_status::text AS wal_status,
        restart_lsn::text AS restart_lsn,
        confirmed_flush_lsn::text AS confirmed_flush_lsn
      FROM pg_replication_slots
      ORDER BY slot_name
    `),

    // Unused indexes (never scanned)
    client.query(`
      SELECT schemaname || '.' || indexrelname AS index_name,
             tablename AS table_name,
             pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
             pg_relation_size(indexrelid) AS raw_size
      FROM pg_stat_user_indexes
      WHERE idx_scan = 0
        AND schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY raw_size DESC
      LIMIT 20
    `),

    // Tables with high sequential scan ratio
    client.query(`
      SELECT schemaname || '.' || relname AS table_name,
             seq_scan,
             COALESCE(idx_scan, 0) AS idx_scan,
             CASE WHEN seq_scan + COALESCE(idx_scan, 0) > 0
                  THEN ROUND(100.0 * seq_scan / (seq_scan + COALESCE(idx_scan, 0)), 1)
                  ELSE 0 END AS seq_scan_pct,
             n_live_tup AS row_count
      FROM pg_stat_user_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND seq_scan + COALESCE(idx_scan, 0) > 100
      ORDER BY seq_scan_pct DESC, seq_scan DESC
      LIMIT 20
    `),

    // Table bloat via dead tuple ratio
    client.query(`
      SELECT schemaname || '.' || relname AS table_name,
             n_live_tup,
             n_dead_tup,
             CASE WHEN n_live_tup + n_dead_tup > 0
                  THEN ROUND(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 1)
                  ELSE 0 END AS bloat_pct,
             pg_size_pretty(pg_relation_size(relid)) AS table_size
      FROM pg_stat_user_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND n_dead_tup > 1000
      ORDER BY bloat_pct DESC
      LIMIT 20
    `),

    // Currently running autovacuum workers
    client.query(`
      SELECT pid,
             datname,
             relid::regclass::text AS table_name,
             phase,
             COALESCE(heap_blks_scanned, 0) AS heap_blks_scanned,
             COALESCE(heap_blks_total, 0) AS heap_blks_total
      FROM pg_stat_progress_vacuum
    `),

    // Tables needing vacuum (notable dead tuples)
    client.query(`
      SELECT schemaname || '.' || relname AS table_name,
             n_dead_tup,
             n_live_tup,
             last_autovacuum::text,
             last_autoanalyze::text
      FROM pg_stat_user_tables
      WHERE n_dead_tup > 500
        AND schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n_dead_tup DESC
      LIMIT 20
    `),

    // Connections grouped by application_name and state
    client.query(`
      SELECT COALESCE(NULLIF(application_name, ''), 'unknown') AS application_name,
             COALESCE(state, 'unknown') AS state,
             COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
      GROUP BY application_name, state
      ORDER BY count DESC
      LIMIT 20
    `),
  ]);

  // Helper to safely extract result or return empty default
  const getResult = (result: PromiseSettledResult<any>, defaultValue: any = { rows: [] }) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      console.error('Dashboard query failed:', result.reason?.message || result.reason);
      return defaultValue;
    }
  };

  const dbInfo = getResult(dbInfoRes).rows[0] || {};
  const connections = getResult(connRes).rows;
  const counts = getResult(countsRes).rows[0] || { schemas: 0, tables: 0, views: 0, functions: 0, sequences: 0 };
  const tableRows = getResult(tableRes).rows;
  const extCount = getResult(extRes).rows[0]?.count || 0;
  const activeQueriesRows = getResult(activeQueriesRes).rows;
  const locksRows = getResult(locksRes).rows;
  const metricsRow = getResult(metricsRes).rows[0] || {
    xact_commit: 0, xact_rollback: 0, blks_read: 0, blks_hit: 0, deadlocks: 0, conflicts: 0,
    temp_bytes: 0, temp_files: 0, checkpoints_timed: 0, checkpoints_req: 0,
    tup_fetched: 0, tup_returned: 0
  };
  const maxConnRow = getResult(settingsRes).rows[0] || { max_connections: '100' };
  const pgStatRows = getResult(pgStatRes).rows || [];
  const waitEventsRows = getResult(waitsRes).rows;
  const longQueriesRow = getResult(longQueriesRes).rows[0] || { count: 0 };
  const indexHitRow = getResult(indexHitRes).rows[0] || { index_hit_ratio: 100 };
  const oldestTxRow = getResult(oldestTxRes).rows[0] || { oldest_tx_age_seconds: 0 };
  const vacuumHealthRow = getResult(vacuumHealthRes).rows[0] || { tables_needing_attention: 0 };

  const walSnapRow = getResult(walSnapshotRes).rows[0];
  const replRows = getResult(walReplRes).rows;
  const walSettingRows = getResult(walSettingsRes).rows;
  const walRecvRow = getResult(walReceiverRes).rows[0];
  const pgWalRow = getResult(pgStatWalRes).rows[0];
  const slotRows = getResult(replSlotsRes).rows;

  const unusedIndexRows = getResult(unusedIndexesRes).rows;
  const highSeqScanRows = getResult(highSeqScanRes).rows;
  const tableBloatRows = getResult(tableBloatRes).rows;
  const autovacuumProgressRows = getResult(autovacuumProgressRes).rows;
  const tablesNeedingVacuumRows = getResult(tablesNeedingVacuumRes).rows;
  const connectionsByAppRows = getResult(connectionsByAppRes).rows;

  const walSettingsMap: Record<string, string> = {};
  for (const r of walSettingRows) {
    const u = r.unit && String(r.unit).trim() !== '' ? ` ${r.unit}` : '';
    walSettingsMap[r.name] = `${r.setting ?? ''}${u}`;
  }

  const walReceiver: WalReplicationStats['walReceiver'] = walRecvRow
    ? {
        status: walRecvRow.status ?? null,
        received_lsn: walRecvRow.received_lsn ?? null,
        latest_end_lsn: walRecvRow.latest_end_lsn ?? null,
        slot_name: walRecvRow.slot_name ?? null,
        sender_host: walRecvRow.sender_host ?? null,
        sender_port: walRecvRow.sender_port != null ? Number(walRecvRow.sender_port) : null,
        last_msg_receipt_time: walRecvRow.last_msg_receipt_time ?? null,
      }
    : null;

  let pgStatWalOut: WalReplicationStats['pgStatWal'] = null;
  if (pgWalRow) {
    pgStatWalOut = {
      wal_records: Number(pgWalRow.wal_records || 0),
      wal_fpi: Number(pgWalRow.wal_fpi || 0),
      wal_bytes: Number(pgWalRow.wal_bytes || 0),
      wal_buffers_full: Number(pgWalRow.wal_buffers_full || 0),
      wal_write: Number(pgWalRow.wal_write || 0),
      wal_sync: Number(pgWalRow.wal_sync || 0),
      wal_write_time: Number(pgWalRow.wal_write_time || 0),
      wal_sync_time: Number(pgWalRow.wal_sync_time || 0),
      stats_reset: String(pgWalRow.stats_reset || ''),
    };
  }

  const walReplication: WalReplicationStats = {
    inRecovery: Boolean(walSnapRow?.in_recovery),
    currentWalLsn: walSnapRow?.current_wal_lsn ?? null,
    receiveLsn: walSnapRow?.receive_lsn ?? null,
    replayLsn: walSnapRow?.replay_lsn ?? null,
    replayLagBytes:
      walSnapRow?.replay_lag_bytes != null && walSnapRow.replay_lag_bytes !== ''
        ? Number(walSnapRow.replay_lag_bytes)
        : null,
    replicas: replRows.map((r: any) => ({
      application_name: r.application_name ?? null,
      client_addr: r.client_addr ?? null,
      state: r.state ?? null,
      sent_lsn: r.sent_lsn ?? null,
      write_lsn: r.write_lsn ?? null,
      flush_lsn: r.flush_lsn ?? null,
      replay_lsn: r.replay_lsn ?? null,
      write_lag: r.write_lag ?? null,
      flush_lag: r.flush_lag ?? null,
      replay_lag: r.replay_lag ?? null,
      sync_state: r.sync_state ?? null,
      backend_start: r.backend_start ?? null,
    })),
    walReceiver,
    settings: walSettingsMap,
    pgStatWal: pgStatWalOut,
    replicationSlots: slotRows.map((r: any) => ({
      slot_name: String(r.slot_name ?? ''),
      plugin: r.plugin ?? null,
      slot_type: r.slot_type ?? null,
      active: Boolean(r.active),
      wal_status: r.wal_status ?? null,
      restart_lsn: r.restart_lsn ?? null,
      confirmed_flush_lsn: r.confirmed_flush_lsn ?? null,
    })),
  };

  let active = 0;
  let idle = 0;
  let waiting = 0;
  let total = 0;
  const connectionStates: { state: string; count: number }[] = [];

  connections.forEach((row: any) => {
    const count = parseInt(row.count);
    total += count;
    if (row.state === 'active') active += count;
    if (row.state === 'idle') idle += count;
    if (row.waiting) waiting += count;
    connectionStates.push({ state: row.state || 'unknown', count });
  });

  return {
    dbName: dbName,
    owner: dbInfo?.owner || 'Unknown',
    size: dbInfo?.size || 'Unknown',
    activeConnections: active,
    idleConnections: idle,
    waitingConnections: waiting,
    totalConnections: total,
    maxConnections: parseInt(maxConnRow.max_connections),
    extensionCount: parseInt(extCount),
    topTables: tableRows.map((r: any) => ({
      name: r.name,
      size: r.size,
      rawSize: parseInt(r.raw_size)
    })),
    connectionStates,
    objectCounts: {
      schemas: parseInt(counts.schemas || '0'),
      tables: parseInt(counts.tables || '0'),
      views: parseInt(counts.views || '0'),
      functions: parseInt(counts.functions || '0'),
      sequences: parseInt(counts.sequences || '0')
    },
    activeQueries: activeQueriesRows.map((r: any) => {
      // Format duration to be more readable (e.g., remove milliseconds if too long, or keep as is from PG)
      // PG 'interval' cast to text usually looks like "00:00:05.123456" or "1 day 00:00:05"
      let duration = r.duration || '';
      // Optional: Truncate milliseconds for cleaner look if it's just a time string
      if (duration.includes('.')) {
        duration = duration.split('.')[0];
      }

      return {
        pid: r.pid,
        usename: r.usename,
        datname: r.datname,
        state: r.state,
        waitEventType: r.wait_event_type,
        waitEvent: r.wait_event,
        xactStart: r.xact_start ? new Date(r.xact_start).toLocaleString() : '-',
        duration: duration,
        startTime: r.query_start ? new Date(r.query_start).toLocaleString() : '-',
        query: r.query
      };
    }),
    blockingLocks: locksRows,
    metrics: {
      xact_commit: parseInt(metricsRow.xact_commit || '0'),
      xact_rollback: parseInt(metricsRow.xact_rollback || '0'),
      blks_read: parseInt(metricsRow.blks_read || '0'),
      blks_hit: parseInt(metricsRow.blks_hit || '0'),
      deadlocks: parseInt(metricsRow.deadlocks || '0'),
      conflicts: parseInt(metricsRow.conflicts || '0'),
      temp_bytes: parseInt(metricsRow.temp_bytes || '0'),
      temp_files: parseInt(metricsRow.temp_files || '0'),
      checkpoints_timed: parseInt(metricsRow.checkpoints_timed || '0'),
      checkpoints_req: parseInt(metricsRow.checkpoints_req || '0'),
      tuples_fetched: parseInt(metricsRow.tup_fetched || '0'),
      tuples_returned: parseInt(metricsRow.tup_returned || '0')
    },
    pgStatStatements: pgStatRows.map((r: any) => ({
      query: r.query,
      calls: parseInt(r.calls || '0'),
      total_time: parseFloat(r.total_time || '0'),
      mean_time: parseFloat(r.mean_time || '0'),
      rows: parseInt(r.rows || '0')
    })),
    waitEvents: waitEventsRows.map((r: any) => ({
      type: r.wait_event_type,
      count: parseInt(r.count)
    })),
    longRunningQueries: parseInt(longQueriesRow.count),
    indexHitRatio: Math.max(0, Math.min(100, Number(indexHitRow.index_hit_ratio || 100))),
    oldestTransactionAgeSeconds: parseInt(oldestTxRow.oldest_tx_age_seconds || '0'),
    vacuumTablesNeedingAttention: parseInt(vacuumHealthRow.tables_needing_attention || '0'),
    walReplication,
    unusedIndexes: unusedIndexRows.map((r: any) => ({
      index_name: r.index_name,
      table_name: r.table_name,
      index_size: r.index_size,
      raw_size: parseInt(r.raw_size || '0'),
    })),
    highSeqScanTables: highSeqScanRows.map((r: any) => ({
      table_name: r.table_name,
      seq_scan: parseInt(r.seq_scan || '0'),
      idx_scan: parseInt(r.idx_scan || '0'),
      seq_scan_pct: parseFloat(r.seq_scan_pct || '0'),
      row_count: parseInt(r.row_count || '0'),
    })),
    tableBloat: tableBloatRows.map((r: any) => ({
      table_name: r.table_name,
      n_live_tup: parseInt(r.n_live_tup || '0'),
      n_dead_tup: parseInt(r.n_dead_tup || '0'),
      bloat_pct: parseFloat(r.bloat_pct || '0'),
      table_size: r.table_size,
    })),
    autovacuumProgress: autovacuumProgressRows.map((r: any) => ({
      pid: parseInt(r.pid || '0'),
      table_name: r.table_name,
      phase: r.phase,
      heap_blks_scanned: parseInt(r.heap_blks_scanned || '0'),
      heap_blks_total: parseInt(r.heap_blks_total || '0'),
    })),
    tablesNeedingVacuum: tablesNeedingVacuumRows.map((r: any) => ({
      table_name: r.table_name,
      n_dead_tup: parseInt(r.n_dead_tup || '0'),
      n_live_tup: parseInt(r.n_live_tup || '0'),
      last_autovacuum: r.last_autovacuum ?? null,
      last_autoanalyze: r.last_autoanalyze ?? null,
    })),
    connectionsByApp: connectionsByAppRows.map((r: any) => ({
      application_name: r.application_name,
      state: r.state,
      count: parseInt(r.count || '0'),
    })),
  };
}

