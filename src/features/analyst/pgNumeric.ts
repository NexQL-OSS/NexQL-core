/**
 * PostgreSQL type names treated as numeric for analyst features.
 * Kept in sync with ChartControls NUMERIC_PG_TYPES.
 */
const NUMERIC_PG_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'numeric',
  'decimal',
  'money',
  'real',
  'double precision',
  'bigint',
  'integer',
  'smallint',
]);

export function isPgNumericType(typeName: string | undefined): boolean {
  if (!typeName) {
    return false;
  }
  const t = typeName.toLowerCase().trim();
  if (NUMERIC_PG_TYPES.has(t)) {
    return true;
  }
  return t.startsWith('int') || t.startsWith('float') || t.startsWith('numeric');
}
