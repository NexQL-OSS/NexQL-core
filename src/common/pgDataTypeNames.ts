/**
 * Maps PostgreSQL type OIDs (from pg Field.dataTypeID) to stable typnames for UI and editors.
 * Built from pg-types builtins (pg_catalog base types); unknown OIDs get `oid:<n>` — never generic "string".
 */
import * as pgTypes from 'pg-types';

const BUILTIN_OID_TO_TYPNAME: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  const builtins = pgTypes.builtins as Record<string, number>;
  for (const [name, oid] of Object.entries(builtins)) {
    if (typeof oid === 'number') {
      m[oid] = name.toLowerCase();
    }
  }
  return m;
})();

export function getPgDataTypeName(dataTypeID: number): string {
  return BUILTIN_OID_TO_TYPNAME[dataTypeID] ?? `oid:${dataTypeID}`;
}
