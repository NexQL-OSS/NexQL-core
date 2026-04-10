/**
 * SQL Templates for Table Operations
 */

export const TableSQL = {
  /**
   * SELECT statement
   */
  select: (schema: string, table: string, limit: number = 100) =>
    `SELECT * FROM "${schema}"."${table}" LIMIT ${limit};`,

  /**
   * INSERT statement template
   */
  insert: (schema: string, table: string) =>
    `-- Insert a single row
INSERT INTO "${schema}"."${table}" (
    -- column1,
    -- column2
)
VALUES (
    -- value1,
    -- value2
)
RETURNING *;

-- Use multi-row syntax to insert multiple rows at once
/*
INSERT INTO "${schema}"."${table}" (
    -- column1,
    -- column2
)
VALUES
    (-- value1, value2),
    (-- value1, value2)
RETURNING *;
*/`,

  /**
   * UPDATE statement template
   */
  update: (schema: string, table: string) =>
    `-- Update rows matching a condition
UPDATE "${schema}"."${table}"
SET
    column_name = new_value
WHERE condition; -- e.g., id = 1
-- RETURNING *;

-- Use RETURNING to see the updated rows
/*
UPDATE "${schema}"."${table}"
SET
    column_name = new_value
WHERE condition
RETURNING *;
*/`,

  /**
   * DELETE statement template
   */
  delete: (schema: string, table: string) =>
    `-- Delete rows matching a condition
DELETE FROM "${schema}"."${table}"
WHERE condition; -- e.g., id = 1

-- Use RETURNING to see the deleted rows
/*
DELETE FROM "${schema}"."${table}"
WHERE condition
RETURNING *;
*/`,

  /**
   * TRUNCATE statement
   */
  truncate: (schema: string, table: string) =>
    `-- Remove all rows from the table (faster than DELETE, cannot be filtered)
TRUNCATE TABLE "${schema}"."${table}";

-- Use CASCADE to also truncate tables that reference this table via foreign keys
-- TRUNCATE TABLE "${schema}"."${table}" CASCADE;`,

  /**
   * DROP TABLE statement — includes CASCADE as a commented variant
   */
  drop: (schema: string, table: string) =>
    `-- Drop the table permanently
DROP TABLE "${schema}"."${table}";

-- Use CASCADE to also drop dependent objects (views, foreign keys, etc.)
-- DROP TABLE "${schema}"."${table}" CASCADE;

-- Use IF EXISTS to suppress error if the table does not exist
-- DROP TABLE IF EXISTS "${schema}"."${table}";`,

  /**
   * VACUUM statement
   */
  vacuum: (schema: string, table: string) =>
    `-- Reclaim storage and update planner statistics
VACUUM (VERBOSE, ANALYZE) "${schema}"."${table}";

-- Use FULL to reclaim more space (locks the table — schedule during maintenance windows)
-- VACUUM (FULL, VERBOSE, ANALYZE) "${schema}"."${table}";`,

  /**
   * ANALYZE statement
   */
  analyze: (schema: string, table: string) =>
    `-- Update planner statistics for the table
ANALYZE VERBOSE "${schema}"."${table}";`,

  /**
   * REINDEX statement
   */
  reindex: (schema: string, table: string) =>
    `-- Rebuild all indexes on the table (locks writes — schedule during maintenance windows)
REINDEX TABLE "${schema}"."${table}";

-- Use CONCURRENTLY to rebuild without locking writes (PostgreSQL 12+)
-- REINDEX TABLE CONCURRENTLY "${schema}"."${table}";`,

  /**
   * CREATE TABLE script template
   */
  createScript: (schema: string, table: string) =>
    `-- Create a new table in schema "${schema}"
CREATE TABLE "${schema}"."${table}" (
    id          bigserial       PRIMARY KEY,
    name        varchar(255)    NOT NULL,
    description text,
    is_active   boolean         NOT NULL DEFAULT true,
    created_at  timestamptz     NOT NULL DEFAULT now(),
    updated_at  timestamptz     NOT NULL DEFAULT now()
);

-- Add a comment describing the table
-- COMMENT ON TABLE "${schema}"."${table}" IS 'Description of ${table}';`,
};
