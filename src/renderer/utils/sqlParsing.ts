/**
 * Extracts schema and table from a SQL statement containing a FROM or JOIN clause
 * with a qualified `schema.table` reference.
 *
 * Handles:
 *   - FROM schema.table
 *   - FROM schema.table WHERE ...
 *   - JOIN schema.table ON ...
 *   - FROM schema.table AS alias
 *
 * Returns `{}` when no match is found (e.g., subqueries, CTEs, unqualified table names).
 */
export function parseBreadcrumbFromSql(sql: string): { schema?: string; table?: string } {
  // Match FROM or JOIN followed by schema.table, optionally followed by alias or clause keyword
  // Identifiers may be plain or double-quoted
  const identPart = `(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
  const pattern = new RegExp(
    `(?:FROM|JOIN)\\s+(${identPart})\\.(${identPart})(?:\\s+(?:AS\\s+${identPart}|WHERE|ON|LEFT|RIGHT|INNER|OUTER|CROSS|JOIN|GROUP|ORDER|LIMIT|HAVING|UNION|EXCEPT|INTERSECT|;|$))?`,
    'i'
  );

  const match = pattern.exec(sql);
  if (!match) {
    return {};
  }

  // Strip surrounding double-quotes if present
  const stripQuotes = (s: string) => s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;

  return {
    schema: stripQuotes(match[1]),
    table: stripQuotes(match[2]),
  };
}

/**
 * Scans an array of notebook cell SQL strings in order and returns a title
 * derived from the first cell that contains a SELECT statement.
 *
 * Title format:
 *   - `View {schema}.{table}` when schema/table can be parsed from the SELECT
 *   - A truncated version of the SELECT clause (max 50 chars) otherwise
 *
 * Returns `""` when no SELECT statement is found in any cell.
 */
export function deriveNotebookTitle(cells: string[]): string {
  for (const cell of cells) {
    if (!/SELECT/i.test(cell)) {
      continue;
    }

    // Try to extract schema.table from this cell
    const { schema, table } = parseBreadcrumbFromSql(cell);
    if (schema && table) {
      return `View ${schema}.${table}`;
    }

    // Fall back to a truncated version of the SELECT statement
    const selectMatch = /SELECT\b.*/i.exec(cell);
    if (selectMatch) {
      const raw = selectMatch[0].trim().replace(/\s+/g, ' ');
      return raw.length > 50 ? raw.slice(0, 50) : raw;
    }
  }

  return '';
}
