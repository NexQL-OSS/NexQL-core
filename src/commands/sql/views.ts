/**
 * SQL Templates for View Operations
 */

export const ViewSQL = {
  /**
   * SELECT from view
   */
  select: (schema: string, view: string, limit: number = 100) =>
    `SELECT * FROM "${schema}"."${view}" LIMIT ${limit};`,

  /**
   * CREATE OR REPLACE VIEW template
   */
  createOrReplace: (schema: string, view: string) =>
    `-- Create or replace the view definition
CREATE OR REPLACE VIEW "${schema}"."${view}" AS
SELECT
    -- column1,
    -- column2
FROM "${schema}".source_table
WHERE true; -- replace with actual condition

-- Add a comment describing the view
-- COMMENT ON VIEW "${schema}"."${view}" IS 'Description of ${view}';`,

  /**
   * DROP VIEW statement — includes CASCADE as a commented variant
   */
  drop: (schema: string, view: string) =>
    `-- Drop the view permanently
DROP VIEW "${schema}"."${view}";

-- Use CASCADE to also drop dependent objects (other views, rules, etc.)
-- DROP VIEW "${schema}"."${view}" CASCADE;

-- Use IF EXISTS to suppress error if the view does not exist
-- DROP VIEW IF EXISTS "${schema}"."${view}";`,

  /**
   * View definition and dependency details
   */
  definition: (schema: string, view: string) =>
    `-- Get view definition and owner
SELECT
    schemaname,
    viewname,
    viewowner,
    definition
FROM pg_views
WHERE schemaname = '${schema}'
  AND viewname = '${view}';

-- Check columns and tables this view depends on
SELECT DISTINCT
    v.table_schema,
    v.table_name,
    v.column_name
FROM information_schema.view_column_usage v
WHERE v.view_schema = '${schema}'
  AND v.view_name = '${view}'
ORDER BY v.table_schema, v.table_name, v.column_name;`,
};
