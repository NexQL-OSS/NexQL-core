/**
 * pg_cron — job scheduling inside PostgreSQL (extension: pg_cron).
 * See https://github.com/citusdata/pg_cron
 */

export const PgCronSQL = {
  listJobs: (): string =>
    `SELECT jobid, schedule, command, nodename, nodeport, database, username, active, jobname
FROM cron.job
ORDER BY jobname NULLS LAST, jobid;`,

  installExtension: (): string =>
    `-- pg_cron runs periodic SQL as a background worker.
-- On managed services, pg_cron may be pre-installed; on self-hosted, ensure shared_preload_libraries includes 'pg_cron' and restart PostgreSQL before CREATE EXTENSION.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- List scheduled jobs
SELECT * FROM cron.job ORDER BY jobid;`,

  jobDetail: (jobid: number): string =>
    `SELECT * FROM cron.job WHERE jobid = ${jobid};`,

  jobRunHistory: (jobid: number): string =>
    `-- Recent runs (requires cron.job_run_details; pg_cron 1.3+)
SELECT jobid, runid, job_pid, database, username, command, status, return_message,
       start_time, end_time
FROM cron.job_run_details
WHERE jobid = ${jobid}
ORDER BY start_time DESC
LIMIT 100;`,

  unschedule: (jobid: number): string =>
    `-- Remove job ${jobid} from the schedule
SELECT cron.unschedule(${jobid}::bigint);`,

  scheduleNewJob: (): string =>
    `-- Schedule SQL (cron expression: minute hour day-of-month month day-of-week)
-- Name + schedule + command (use dollar-quoting for multi-line SQL)

SELECT cron.schedule(
  'my_nightly_job',     -- job name (optional in some versions)
  '0 2 * * *',          -- daily at 02:00
  $$VACUUM ANALYZE public.my_table;$$
);

-- One-argument form (schedule + command only):
-- SELECT cron.schedule('*/15 * * * *', $$SELECT refresh_materialized_view('public.stats_mv');$$);

SELECT * FROM cron.job ORDER BY jobid DESC LIMIT 5;`,

  alterJobNote: (): string =>
    `-- pg_cron 1.4+: alter schedule, command, database, username, active
-- SELECT cron.alter_job(job_id := 1, schedule := '0 * * * *', command := $$SELECT 1$$);

SELECT jobid, jobname, schedule, active, database, username
FROM cron.job
ORDER BY jobid;`,

  /**
   * Documents that pg_dump scheduling belongs on the server OS or VS Code tasks — not inside cron.schedule SQL.
   * Includes a harmless maintenance example for pg_cron.
   */
  scheduleBackupShellExample: (): string =>
    `-- pg_cron runs SQL inside PostgreSQL, not your developer machine shell.
-- For pg_dump on a schedule use: OS cron/systemd on the DB host, or a VS Code task (type pgstudio-pgdump).
--
-- Example pg_cron maintenance job:

SELECT cron.schedule(
  'nightly_vacuum_example',
  '0 3 * * *',
  $$VACUUM ANALYZE public.my_table;$$
);

SELECT * FROM cron.job ORDER BY jobid DESC LIMIT 5;`,
};
