import type { PoolClient } from 'pg';

/** PostgreSQL 10 — logical replication catalogs, `pg_class.relispartition`, `relkind` `p`, `pg_sequences`, etc. */
export const PG_VERSION_10 = 100_000;

/** PostgreSQL 11 — `pg_proc.prokind`, SQL procedures */
export const PG_VERSION_11 = 110_000;

export type PgQueryable = Pick<PoolClient, 'query'>;

export async function queryServerVersionNum(client: PgQueryable): Promise<number> {
  try {
    const r = await client.query<{ server_version_num: string }>(`SHOW server_version_num`);
    const n = Number(r.rows?.[0]?.server_version_num);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
