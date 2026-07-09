/**
 * SQL queries for live database monitoring: activity, locks, slow queries.
 * Pure string builders (no vscode deps) shared by the dashboard, AI tools,
 * and the MCP server.
 *
 * `dbFilter` defaults to `current_database()` so queries run as-is through
 * the read-only tool executor; the dashboard passes `$1` to keep its
 * parameterized form.
 */

/**
 * Non-idle backends with query text truncated for LLM consumption.
 */
export function runningQueries(dbFilter: string = 'current_database()'): string {
  return `
SELECT pid,
       usename AS user,
       datname AS database,
       state,
       wait_event_type,
       wait_event,
       (now() - query_start)::text AS duration,
       query_start,
       LEFT(query, 500) AS query
FROM pg_stat_activity
WHERE pid != pg_backend_pid()
  AND state IS DISTINCT FROM 'idle'
  AND datname = ${dbFilter}
ORDER BY query_start ASC
LIMIT 100
`.trim();
}

/**
 * Blocked/blocking pid pairs from pg_locks joined to pg_stat_activity.
 */
export function blockingLocks(dbFilter: string = 'current_database()'): string {
  return `
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
AND blocked_activity.datname = ${dbFilter}
AND blocking_activity.datname = ${dbFilter}
`.trim();
}

/**
 * Connection counts grouped by state and wait status.
 */
export function connectionStates(dbFilter: string = 'current_database()'): string {
  return `
SELECT state, wait_event_type IS NOT NULL as waiting, count(*) as count
FROM pg_stat_activity
WHERE datname = ${dbFilter}
GROUP BY state, waiting
`.trim();
}

/**
 * Buffer-cache hit ratio for the current database from pg_stat_database.
 */
export function cacheHitRatio(dbFilter: string = 'current_database()'): string {
  return `
SELECT
  blks_hit,
  blks_read,
  CASE WHEN blks_hit + blks_read = 0 THEN NULL
       ELSE ROUND(blks_hit::numeric / (blks_hit + blks_read), 4)
  END AS cache_hit_ratio,
  xact_commit,
  xact_rollback,
  deadlocks,
  temp_files,
  temp_bytes
FROM pg_stat_database
WHERE datname = ${dbFilter}
`.trim();
}

/**
 * Top statements by mean execution time from pg_stat_statements.
 * Fails with "relation \"pg_stat_statements\" does not exist" when the
 * extension is not installed — callers should map that to a friendly hint.
 */
export function slowQueries(limit: number = 10): string {
  const capped = Math.min(Math.max(Math.floor(limit) || 10, 1), 50);
  return `
SELECT
  queryid::text,
  LEFT(query, 500) AS query,
  calls,
  ROUND(mean_exec_time::numeric, 2)   AS mean_ms,
  ROUND(total_exec_time::numeric, 2)  AS total_ms,
  ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
  rows
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
  AND query NOT LIKE 'BEGIN%'
  AND query NOT LIKE 'COMMIT%'
  AND query NOT LIKE 'ROLLBACK%'
  AND calls >= 5
ORDER BY mean_exec_time DESC
LIMIT ${capped}
`.trim();
}
