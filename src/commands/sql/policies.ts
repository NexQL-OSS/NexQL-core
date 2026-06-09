/** RLS policy DDL templates (identifiers quoted; no dynamic SQL concatenation at runtime). */

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface PolicyDefinition {
  schema: string;
  table: string;
  name: string;
  /** PERMISSIVE (default) combines with OR; RESTRICTIVE combines with AND. */
  permissive?: boolean;
  command?: PolicyCommand;
  /** Roles the policy applies to. Empty (or PUBLIC) → applies to all roles. */
  roles?: string[];
  /** Row visibility predicate (USING). */
  using?: string;
  /** Predicate new/updated rows must satisfy (WITH CHECK). */
  withCheck?: string;
}

/** Render the TO clause; PUBLIC/CURRENT_USER/CURRENT_ROLE/SESSION_USER are reserved (unquoted). */
function renderRoles(roles?: string[]): string {
  const list = (roles ?? []).map((r) => r.trim()).filter(Boolean);
  if (list.length === 0 || (list.length === 1 && list[0].toUpperCase() === 'PUBLIC')) {
    return 'PUBLIC';
  }
  const reserved = new Set(['PUBLIC', 'CURRENT_USER', 'CURRENT_ROLE', 'SESSION_USER']);
  return list.map((r) => (reserved.has(r.toUpperCase()) ? r.toUpperCase() : quoteIdent(r))).join(', ');
}

export const PolicySQL = {
  /** Enable row-level security on a table (policies are inert until this is set). */
  enableRls: (schema: string, table: string): string =>
    `ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(table)} ENABLE ROW LEVEL SECURITY;`,

  /** Build a CREATE POLICY statement from a structured definition. */
  create: (def: PolicyDefinition): string => {
    const lines: string[] = [
      `CREATE POLICY ${quoteIdent(def.name)} ON ${quoteIdent(def.schema)}.${quoteIdent(def.table)}`,
      `    AS ${def.permissive === false ? 'RESTRICTIVE' : 'PERMISSIVE'}`,
      `    FOR ${def.command ?? 'ALL'}`,
      `    TO ${renderRoles(def.roles)}`,
    ];
    if (def.using && def.using.trim()) {
      lines.push(`    USING (${def.using.trim()})`);
    }
    if (def.withCheck && def.withCheck.trim()) {
      lines.push(`    WITH CHECK (${def.withCheck.trim()})`);
    }
    return lines.join('\n') + ';';
  },

  drop: (schema: string, table: string, policyName: string): string =>
    `-- Drop row-level security policy
DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${quoteIdent(schema)}.${quoteIdent(table)};`,
};

/**
 * Compose the full executable script for the RLS Policy Studio: optionally enable
 * row-level security on the table, then create the policy. Pure + testable.
 */
export function buildPolicyScript(def: PolicyDefinition, includeEnableRls: boolean): string {
  const parts: string[] = [];
  if (includeEnableRls) {
    parts.push(`-- Row-level security must be ON for policies to take effect\n${PolicySQL.enableRls(def.schema, def.table)}`);
  }
  parts.push(`-- Policy definition\n${PolicySQL.create(def)}`);
  return parts.join('\n\n');
}
