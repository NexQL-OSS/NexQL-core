/**
 * SQL Templates for Column Operations
 */

export const ColumnSQL = {
    /**
     * SELECT statement for a specific column
     */
    select: (schema: string, table: string, column: string, limit: number = 100) =>
        `-- Select column
SELECT ${column}
FROM ${schema}.${table}
LIMIT ${limit};`,

    /**
     * ALTER COLUMN templates
     */
    alter: (schema: string, table: string, column: string) =>
        `-- Change data type
ALTER TABLE ${schema}.${table}
    ALTER COLUMN ${column} TYPE varchar(255);

-- Use SET NOT NULL to add a not-null constraint
-- ALTER TABLE ${schema}.${table}
--     ALTER COLUMN ${column} SET NOT NULL;

-- Use DROP NOT NULL to remove a not-null constraint
-- ALTER TABLE ${schema}.${table}
--     ALTER COLUMN ${column} DROP NOT NULL;

-- Use SET DEFAULT to add a default value
-- ALTER TABLE ${schema}.${table}
--     ALTER COLUMN ${column} SET DEFAULT 'default_value';

-- Use DROP DEFAULT to remove the default value
-- ALTER TABLE ${schema}.${table}
--     ALTER COLUMN ${column} DROP DEFAULT;

-- Use multiple clauses to change type, nullability, and default in one statement
-- ALTER TABLE ${schema}.${table}
--     ALTER COLUMN ${column} TYPE integer USING ${column}::integer,
--     ALTER COLUMN ${column} SET NOT NULL,
--     ALTER COLUMN ${column} SET DEFAULT 0;`,

    /**
     * DROP COLUMN template
     */
    drop: (schema: string, table: string, column: string) =>
        `-- Drop column (safe - fails if dependencies exist)
ALTER TABLE ${schema}.${table}
    DROP COLUMN ${column};

-- Use CASCADE to also drop all dependent objects
-- ALTER TABLE ${schema}.${table}
--     DROP COLUMN ${column} CASCADE;

-- Use IF EXISTS to suppress error if column does not exist
-- ALTER TABLE ${schema}.${table}
--     DROP COLUMN IF EXISTS ${column};`,

    /**
     * RENAME COLUMN template
     */
    rename: (schema: string, table: string, oldName: string, newName: string) =>
        `-- Rename column from '${oldName}' to '${newName}'
ALTER TABLE ${schema}.${table}
    RENAME COLUMN ${oldName} TO ${newName};`,

    /**
     * CREATE INDEX on column templates
     */
    createIndex: (schema: string, table: string, column: string, indexName: string) =>
        `-- Basic index (B-tree)
CREATE INDEX ${indexName}
ON ${schema}.${table} (${column});

-- Use UNIQUE to prevent duplicate values
-- CREATE UNIQUE INDEX ${indexName}
-- ON ${schema}.${table} (${column});

-- Use CONCURRENTLY to avoid locking the table during creation
-- CREATE INDEX CONCURRENTLY ${indexName}
-- ON ${schema}.${table} (${column});

-- Use USING to specify a different index method (hash, gin, gist, brin)
-- CREATE INDEX ${indexName}
-- ON ${schema}.${table} USING hash (${column});

-- Use WHERE to create a partial index on matching rows only
-- CREATE INDEX ${indexName}
-- ON ${schema}.${table} (${column})
-- WHERE ${column} IS NOT NULL;

-- Use DESC NULLS LAST to control sort order and null placement
-- CREATE INDEX ${indexName}
-- ON ${schema}.${table} (${column} DESC NULLS LAST);

-- Use an expression to create a functional index
-- CREATE INDEX ${indexName}
-- ON ${schema}.${table} (LOWER(${column}));`,
};
