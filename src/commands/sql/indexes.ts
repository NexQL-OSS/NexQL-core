/**
 * SQL Templates for Index Operations
 */

export const IndexSQL = {
    /**
     * DROP INDEX statement
     */
    drop: (schema: string, indexName: string) =>
        `-- Drop index
DROP INDEX "${schema}"."${indexName}";

-- Use CONCURRENTLY to avoid locking the table
-- DROP INDEX CONCURRENTLY "${schema}"."${indexName}";

-- Use IF EXISTS to suppress error if not found
-- DROP INDEX IF EXISTS "${schema}"."${indexName}";`,

    /**
     * REINDEX statement
     */
    reindex: (schema: string, indexName: string) =>
        `-- Reindex (locks table)
REINDEX INDEX "${schema}"."${indexName}";

-- Use CONCURRENTLY to avoid locking the table (PostgreSQL 12+)
-- REINDEX INDEX CONCURRENTLY "${schema}"."${indexName}";`,

    /**
     * ALTER INDEX statement
     */
    alter: (schema: string, indexName: string) =>
        `-- Rename index
ALTER INDEX "${schema}"."${indexName}" RENAME TO new_index_name;

-- Use SET TABLESPACE to move index to a different tablespace
-- ALTER INDEX "${schema}"."${indexName}" SET TABLESPACE new_tablespace;

-- Use ALTER COLUMN SET STATISTICS to adjust per-column statistics
-- ALTER INDEX "${schema}"."${indexName}" ALTER COLUMN column_name SET STATISTICS 1000;`,

    /**
     * Index usage statistics
     */
    usageStats: (schema: string, indexName: string) =>
        `-- Index Usage Statistics
SELECT 
    schemaname,
    relname,
    indexrelid,
    idx_scan as scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched,
    pg_size_pretty(pg_relation_size(indexrelid)) as size,
    CASE 
        WHEN idx_scan = 0 THEN 'UNUSED'
        WHEN idx_scan < 50 THEN 'LOW USAGE'
        ELSE 'ACTIVE'
    END as usage_status
FROM pg_stat_user_indexes
WHERE schemaname = '${schema}' 
  AND indexrelname = '${indexName}';

-- Cache Hit Ratio
SELECT 
    relname, 
    indexrelname,
    idx_blks_read as disk_reads,
    idx_blks_hit as cache_hits,
    ROUND(100.0 * idx_blks_hit / GREATEST(idx_blks_hit + idx_blks_read, 1), 2) as cache_hit_ratio
FROM pg_statio_user_indexes
WHERE schemaname = '${schema}' 
  AND indexrelname = '${indexName}';`,
};
