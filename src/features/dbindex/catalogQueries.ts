import { DbObjectKind } from './types';

export interface RawRelationRow {
  oid: number;
  schema_name: string;
  name: string;
  kind: string;
  comment: string | null;
  row_estimate: string | number;
  size_bytes: string | number;
}

export interface RawColumnRow {
  table_oid: number;
  name: string;
  type: string;
  not_null: boolean;
  default_value: string | null;
  comment: string | null;
  ordinal: number;
}

export interface RawConstraintRow {
  table_oid: number;
  name: string;
  type: string;
  definition: string;
  ref_table_oid: number | null;
  key_positions: number[] | null;
  ref_key_positions: number[] | null;
}

export interface RawIndexRow {
  table_oid: number;
  name: string;
  unique: boolean;
  method: string;
  definition: string;
  key_positions: number[] | null;
}

export interface RawViewRow {
  oid: number;
  definition: string;
}

export interface RawFunctionRow {
  oid: number;
  schema_name: string;
  name: string;
  arguments: string;
  result_type: string;
  language: string;
  volatility: string;
  body: string;
  comment: string | null;
}

export interface RawEnumRow {
  oid: number;
  schema_name: string;
  name: string;
  value: string;
  sort_order: number;
}

export interface RawDomainRow {
  oid: number;
  schema_name: string;
  name: string;
  base_type: string;
  constraint_name: string | null;
  constraint_definition: string | null;
}

// 1. Fetch relations (tables, views, materialized views, foreign tables, partitioned tables)
export const RELATIONS_QUERY = `
SELECT
  c.oid::integer AS oid,
  n.nspname AS schema_name,
  c.relname AS name,
  c.relkind AS kind,
  d.description AS comment,
  c.reltuples::bigint AS row_estimate,
  pg_total_relation_size(c.oid)::bigint AS size_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
WHERE n.nspname = ANY($1)
  AND c.relkind IN ('r', 'v', 'f', 'm', 'p')
`;

// 2. Fetch columns for multiple relations by OID
export const COLUMNS_QUERY = `
SELECT
  a.attrelid::integer AS table_oid,
  a.attname AS name,
  format_type(a.atttypid, a.atttypmod) AS type,
  a.attnotnull AS not_null,
  pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
  d.description AS comment,
  a.attnum AS ordinal
FROM pg_attribute a
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
LEFT JOIN pg_description d ON d.objoid = a.attrelid AND d.objsubid = a.attnum
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND a.attrelid = ANY($1)
ORDER BY a.attrelid, a.attnum
`;

// 3. Fetch constraints for multiple relations by OID
export const CONSTRAINTS_QUERY = `
SELECT
  con.conrelid::integer AS table_oid,
  con.conname AS name,
  con.contype AS type,
  pg_get_constraintdef(con.oid) AS definition,
  con.confrelid::integer AS ref_table_oid,
  con.conkey::integer[] AS key_positions,
  con.confkey::integer[] AS ref_key_positions
FROM pg_constraint con
WHERE con.conrelid = ANY($1)
`;

// 4. Fetch indexes for multiple relations by OID (excluding constraint indexes that are PK/Unique to reduce noise)
export const INDEXES_QUERY = `
SELECT
  ind.indrelid::integer AS table_oid,
  c.relname AS name,
  ind.indisunique AS unique,
  am.amname AS method,
  pg_get_indexdef(ind.indexrelid) AS definition,
  ind.indkey::integer[] AS key_positions
FROM pg_index ind
JOIN pg_class c ON c.oid = ind.indexrelid
JOIN pg_class tc ON tc.oid = ind.indrelid
JOIN pg_am am ON am.oid = c.relam
WHERE ind.indrelid = ANY($1)
`;

// 5. Fetch definitions for views and materialized views
export const VIEW_DEFINITIONS_QUERY = `
SELECT
  c.oid::integer AS oid,
  pg_get_viewdef(c.oid) AS definition
FROM pg_class c
WHERE c.relkind IN ('v', 'm')
  AND c.oid = ANY($1)
`;

// 6. Fetch functions in schemas
export const FUNCTIONS_QUERY = `
SELECT
  p.oid::integer AS oid,
  n.nspname AS schema_name,
  p.proname AS name,
  pg_get_function_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS result_type,
  l.lanname AS language,
  p.provolatile AS volatility,
  p.prosrc AS body,
  d.description AS comment
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
LEFT JOIN pg_description d ON d.objoid = p.oid
WHERE n.nspname = ANY($1)
`;

// 7. Fetch enums in schemas
export const ENUMS_QUERY = `
SELECT
  t.oid::integer AS oid,
  n.nspname AS schema_name,
  t.typname AS name,
  e.enumlabel AS value,
  e.enumsortorder::integer AS sort_order
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = ANY($1)
ORDER BY t.oid, e.enumsortorder
`;

// 8. Fetch domains in schemas
export const DOMAINS_QUERY = `
SELECT
  t.oid::integer AS oid,
  n.nspname AS schema_name,
  t.typname AS name,
  format_type(t.typbasetype, t.typtypmod) AS base_type,
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid) AS constraint_definition
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_constraint con ON con.contypid = t.oid
WHERE n.nspname = ANY($1)
  AND t.typtype = 'd'
`;

// 9. Schema fingerprint — must stay in sync with IndexManifest.schemaFingerprint format.
// Note: this differs from SchemaPoller's fingerprint (n_live_tup, unfiltered pg_class);
// staleness checks against a manifest must use THIS query, never the poller's.
export const SCHEMA_FINGERPRINT_QUERY = `
SELECT
  COUNT(*)::text                                    AS object_count,
  COALESCE(MAX(c.oid)::text, '0')                   AS max_oid,
  COALESCE(SUM(c.reltuples)::bigint::text, '0')     AS total_rows_estimate,
  (SELECT COUNT(*)::text FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
     AND nspname NOT LIKE 'pg_%')                   AS schema_count,
  COALESCE((SELECT MAX(oid)::text FROM pg_namespace
            WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
              AND nspname NOT LIKE 'pg_%'), '0')     AS max_schema_oid
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND c.relkind IN ('r', 'v', 'f', 'm', 'p')
`;

export async function fetchSchemaFingerprint(client: { query: (sql: string) => Promise<{ rows: any[] }> }): Promise<string> {
  const result = await client.query(SCHEMA_FINGERPRINT_QUERY);
  const row = result.rows[0];
  return `${row.object_count}|${row.max_oid}|${row.total_rows_estimate}|${row.schema_count}|${row.max_schema_oid}`;
}

// 10. Non-system schemas in a database
export const NON_SYSTEM_SCHEMAS_QUERY = `
SELECT nspname
FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND nspname NOT LIKE 'pg_%'
ORDER BY nspname
`;

export async function listNonSystemSchemas(client: { query: (sql: string) => Promise<{ rows: any[] }> }): Promise<string[]> {
  const result = await client.query(NON_SYSTEM_SCHEMAS_QUERY);
  return result.rows.map((r: any) => r.nspname);
}

export function mapRelkindToDbObjectKind(relkind: string): DbObjectKind {
  switch (relkind) {
    case 'r': return 'table';
    case 'v': return 'view';
    case 'm': return 'matview';
    case 'f': return 'table'; // treats foreign tables like tables for NL grounding
    case 'p': return 'table'; // treats partitioned tables as tables
    default: return 'table';
  }
}
