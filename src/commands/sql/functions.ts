/**
 * SQL Templates for Function Operations
 */

export const FunctionSQL = {
  /**
   * Call function — primary: SELECT (single value), variant: SELECT * FROM (table/set)
   */
  call: (schema: string, name: string, args: string) =>
    `-- Call function (returns single value)
SELECT ${schema}.${name}(${args});

-- Use SELECT * FROM when the function returns a table or set of rows
-- SELECT * FROM ${schema}.${name}(${args});`,

  /**
   * Create or replace function template
   */
  createOrReplace: (schema: string) =>
    `-- Create or replace function
CREATE OR REPLACE FUNCTION ${schema}.function_name(param1 integer, param2 text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT 'Result: ' || param2 || ' with value ' || param1::text;
$$;`,

  /**
   * Drop function — primary: DROP, variant: CASCADE
   */
  drop: (schema: string, name: string, args: string) =>
    `-- Drop function
DROP FUNCTION IF EXISTS ${schema}.${name}(${args});

-- Use CASCADE to also drop dependent objects (views, other functions, etc.)
-- DROP FUNCTION IF EXISTS ${schema}.${name}(${args}) CASCADE;`,

  /**
   * Function metadata query
   */
  metadata: (schema: string, name: string) =>
    `-- Get function details and metadata
SELECT
    p.proname AS function_name,
    pg_get_function_arguments(p.oid) AS arguments,
    pg_get_function_result(p.oid) AS return_type,
    l.lanname AS language,
    CASE p.provolatile
        WHEN 'i' THEN 'IMMUTABLE'
        WHEN 's' THEN 'STABLE'
        WHEN 'v' THEN 'VOLATILE'
    END AS volatility,
    p.prosecdef AS security_definer,
    p.proisstrict AS strict
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = '${schema}' AND p.proname = '${name}';`,
};
