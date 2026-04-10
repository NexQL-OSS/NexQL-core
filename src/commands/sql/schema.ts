/**
 * SQL Templates for Schema Operations
 */

export const SchemaSQL = {
    /**
     * CREATE SCHEMA
     */
    create: () =>
        `-- Create schema
CREATE SCHEMA schema_name;

-- Use WITH AUTHORIZATION to set the owner
-- CREATE SCHEMA schema_name AUTHORIZATION owner_role;`,

    /**
     * DROP SCHEMA
     */
    drop: (schema: string) =>
        `-- Drop schema (BE CAREFUL!)
DROP SCHEMA ${schema};

-- Use CASCADE to also drop all objects in the schema
-- DROP SCHEMA ${schema} CASCADE;`,

    /**
     * GRANT privileges on schema
     */
    grant: (schema: string) =>
        `-- Grant privileges (modify as needed)
GRANT USAGE ON SCHEMA ${schema} TO role_name;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO role_name;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO role_name;
GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO role_name;

-- Set default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO role_name;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
    GRANT EXECUTE ON FUNCTIONS TO role_name;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
    GRANT SELECT, USAGE ON SEQUENCES TO role_name;`,

    /**
     * List all objects in schema
     */
    listObjects: (schema: string) =>
        `-- List all objects in schema with sizes
SELECT 
    CASE c.relkind
        WHEN 'r' THEN 'table'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized view'
        WHEN 'i' THEN 'index'
        WHEN 'S' THEN 'sequence'
        WHEN 's' THEN 'special'
        WHEN 'f' THEN 'foreign table'
        WHEN 'p' THEN 'partitioned table'
END as object_type,
    c.relname as object_name,
    pg_size_pretty(pg_total_relation_size(quote_ident('${schema}') || '.' || quote_ident(c.relname))) as size,
    CASE WHEN c.relkind = 'r' THEN
        (SELECT reltuples::bigint FROM pg_class WHERE oid = c.oid)
    ELSE NULL END as estimated_row_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '${schema}'
AND c.relkind in ('r', 'v', 'm', 'S', 'f', 'p')
ORDER BY c.relkind, pg_total_relation_size(c.oid) DESC;`
};
