import { Parser } from '@dbml/core';

function identPg(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`;
}

function fieldTypeToSql(typeVal: unknown): string {
  if (typeVal == null) {
    return 'text';
  }
  if (typeof typeVal === 'string') {
    return typeVal;
  }
  if (typeof typeVal === 'object' && typeVal !== null && 'type_name' in typeVal) {
    const o = typeVal as { type_name: string; args?: string | null };
    const base = String(o.type_name);
    return o.args ? `${base}(${o.args})` : base;
  }
  return String(typeVal);
}

/**
 * Parse DBML text and emit PostgreSQL CREATE TABLE statements (best-effort).
 * Does not emit FK Ref lines as ALTER (optional follow-up).
 */
export function dbmlToPostgresCreateTables(dbmlText: string): { sql: string[]; errors: string[] } {
  const errors: string[] = [];
  let sql: string[] = [];

  try {
    let db;
    try {
      db = new Parser().parse(dbmlText.trim(), 'dbmlv2');
    } catch {
      db = new Parser().parse(dbmlText.trim(), 'dbml');
    }
    const stmts: string[] = [];

    for (const schema of db.schemas) {
      const schemaName = schema.name || 'public';
      for (const table of schema.tables) {
        const colDefs: string[] = [];
        const pkCols: string[] = [];

        for (const field of table.fields) {
          const colName = identPg(field.name);
          const typ = fieldTypeToSql(field.type);
          const parts: string[] = [colName, typ];
          if (field.not_null) {
            parts.push('NOT NULL');
          }
          if (field.dbdefault != null && String(field.dbdefault).length > 0) {
            parts.push(`DEFAULT ${field.dbdefault}`);
          }
          if (field.unique && !field.pk) {
            parts.push('UNIQUE');
          }
          colDefs.push(parts.join(' '));
          if (field.pk) {
            pkCols.push(colName);
          }
        }

        if (pkCols.length > 0) {
          colDefs.push(`PRIMARY KEY (${pkCols.join(', ')})`);
        }

        const tSql = `CREATE TABLE ${identPg(schemaName)}.${identPg(table.name)} (\n  ${colDefs.join(',\n  ')}\n);`;
        stmts.push(tSql);
      }
    }

    sql = stmts;
  } catch (e: unknown) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return { sql, errors };
}
