/**
 * SQL Templates for Materialized View Operations
 */

export const MaterializedViewSQL = {
    /**
     * Select data from materialized view
     */
    select: (schema: string, matviewName: string) =>
        `SELECT *
FROM ${schema}.${matviewName}
LIMIT 100;`,

    /**
     * Refresh materialized view.
     * Variant: CONCURRENTLY (non-blocking, requires unique index)
     */
    refresh: (schema: string, matviewName: string) =>
        `REFRESH MATERIALIZED VIEW ${schema}.${matviewName};

-- Use CONCURRENTLY when you need non-blocking refresh (requires a unique index)
-- REFRESH MATERIALIZED VIEW CONCURRENTLY ${schema}.${matviewName};`,

    /**
     * Create materialized view template
     */
    create: (schema: string, matviewName: string) =>
        `CREATE MATERIALIZED VIEW ${schema}.${matviewName} AS
SELECT
    column1,
    column2,
    COUNT(*) AS count
FROM ${schema}.source_table
WHERE condition = true
WITH DATA;`,

    /**
     * Drop materialized view.
     * Variant: CASCADE to also drop dependent objects
     */
    drop: (schema: string, matviewName: string) =>
        `DROP MATERIALIZED VIEW ${schema}.${matviewName};

-- Use CASCADE to also drop dependent objects
-- DROP MATERIALIZED VIEW ${schema}.${matviewName} CASCADE;`,

    /**
     * Update query planner statistics
     */
    analyze: (schema: string, matviewName: string) =>
        `ANALYZE ${schema}.${matviewName};`,

    /**
     * Create a unique index on the materialized view.
     * A unique index is required to enable CONCURRENT refresh.
     */
    createIndex: (schema: string, matviewName: string) =>
        `CREATE UNIQUE INDEX ${matviewName}_unique_idx
    ON ${schema}.${matviewName} (id);`,
};
