/** RLS policy DDL templates (identifiers quoted; no dynamic SQL concatenation at runtime). */

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export const PolicySQL = {
  drop: (schema: string, table: string, policyName: string): string =>
    `-- Drop row-level security policy
DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${quoteIdent(schema)}.${quoteIdent(table)};`,
};
