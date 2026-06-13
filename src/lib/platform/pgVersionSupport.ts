/**
 * PostgreSQL version constants and PG12+ support helpers.
 * NexQL's documented minimum is PostgreSQL 12 (integration-tested in Docker).
 */

import { PG_VERSION_10, PG_VERSION_11 } from '../postgresServerVersion';

/** Documented minimum — matches docker-compose.test.yml and COMPATIBILITY.md. */
export const PG_VERSION_12 = 120_000;
export const PG_VERSION_13 = 130_000;
export const PG_VERSION_14 = 140_000;
export const PG_VERSION_15 = 150_000;
export const PG_VERSION_16 = 160_000;
export const PG_VERSION_17 = 170_000;

export { PG_VERSION_10, PG_VERSION_11 };

/** True when the server meets NexQL's supported floor (PG 12+). */
export function isSupportedPostgresVersion(serverVersionNum: number): boolean {
  return serverVersionNum >= PG_VERSION_12;
}

/** Major version from `SHOW server_version_num` (e.g. 120006 → 12). */
export function postgresMajorFromVersionNum(serverVersionNum: number): number {
  return Math.floor(serverVersionNum / 10_000);
}
