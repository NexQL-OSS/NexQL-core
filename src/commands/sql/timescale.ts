/** Pure SQL templates for TimescaleDB maintenance workflows. */

export const TimescaleSQL = {
  createHypertable: (schema: string, table: string, timeColumn: string): string =>
    `SELECT create_hypertable('${schema}.${table}', '${timeColumn}', if_not_exists => TRUE);`,

  addCompressionPolicy: (schema: string, table: string, intervalDays: number): string =>
    `SELECT add_compression_policy('${schema}.${table}', INTERVAL '${intervalDays} days');`,

  addRetentionPolicy: (schema: string, table: string, intervalDays: number): string =>
    `SELECT add_retention_policy('${schema}.${table}', INTERVAL '${intervalDays} days');`,

  listHypertables: (): string =>
    `SELECT hypertable_schema, hypertable_name, num_chunks
     FROM timescaledb_information.hypertables
     ORDER BY 1, 2;`,
};
