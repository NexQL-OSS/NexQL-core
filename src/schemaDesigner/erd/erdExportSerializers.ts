import type { ErdForeignKey, ErdSnapshot, ErdTable } from './erdTypes';
import { tableQual } from './erdTypes';

function mermaidId(schema: string, table: string): string {
  const s = `${schema}_${table}`.replace(/[^a-zA-Z0-9_]/g, '_');
  return s.length > 0 ? s : 'T';
}

function escMermaidType(t: string): string {
  return String(t).replace(/[{}[\]"']/g, '_');
}

/**
 * Mermaid erDiagram source for the current snapshot (FK layer).
 */
export function buildMermaidErDiagram(snapshot: ErdSnapshot): string {
  const lines: string[] = ['erDiagram'];
  const seen = new Set<string>();

  for (const tbl of snapshot.tables) {
    const id = mermaidId(tbl.schema, tbl.name);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    lines.push(`  ${id} {`);
    for (const c of tbl.columns) {
      const marker = c.isPk ? ' PK' : '';
      lines.push(`    ${escMermaidType(c.type)} ${c.name.replace(/\s/g, '_')}${marker}`);
    }
    lines.push('  }');
  }

  const fkSeen = new Set<string>();
  for (const fk of snapshot.foreignKeys) {
    const a = mermaidId(fk.fromSchema, fk.fromTable);
    const b = mermaidId(fk.toSchema, fk.toTable);
    const key = `${fk.constraintName}|${a}|${b}`;
    if (fkSeen.has(key)) {
      continue;
    }
    fkSeen.add(key);
    lines.push(`  ${a} }o--|| ${b} : "${fk.constraintName}"`);
  }

  return lines.join('\n');
}

function dbmlQuoteIdent(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * DBML document for tables and refs (Postgres-oriented types as-is).
 */
export function buildDbml(snapshot: ErdSnapshot): string {
  const blocks: string[] = [];
  const tableKeys = new Set(snapshot.tables.map((t) => tableQual(t.schema, t.name)));

  for (const t of snapshot.tables) {
    const header = `Table ${dbmlQuoteIdent(t.schema)}.${dbmlQuoteIdent(t.name)} {`;
    const fieldLines = t.columns.map((c) => {
      const flags: string[] = [];
      if (c.isPk) {
        flags.push('pk');
      }
      if (c.notNull) {
        flags.push('not null');
      }
      const opt = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      return `  ${dbmlQuoteIdent(c.name)} ${c.type}${opt}`;
    });
    blocks.push([header, ...fieldLines, '}', ''].join('\n'));
  }

  let refIdx = 0;
  const refSeen = new Set<string>();
  for (const fk of snapshot.foreignKeys) {
    const fromQ = `${dbmlQuoteIdent(fk.fromSchema)}.${dbmlQuoteIdent(fk.fromTable)}`;
    const toQ = `${dbmlQuoteIdent(fk.toSchema)}.${dbmlQuoteIdent(fk.toTable)}`;
    if (!tableKeys.has(tableQual(fk.fromSchema, fk.fromTable)) || !tableKeys.has(tableQual(fk.toSchema, fk.toTable))) {
      continue;
    }
    const key = `${fromQ}.${fk.fromColumn}->${toQ}.${fk.toColumn}`;
    if (refSeen.has(key)) {
      continue;
    }
    refSeen.add(key);
    refIdx += 1;
    blocks.push(
      `Ref r${refIdx} {\n  ${fromQ}.${dbmlQuoteIdent(fk.fromColumn)} > ${toQ}.${dbmlQuoteIdent(fk.toColumn)}\n}\n`
    );
  }

  return blocks.join('\n');
}

/** Subset for webview when tables were edited client-side. */
export function buildMermaidFromTables(tables: ErdTable[], foreignKeys: ErdForeignKey[]): string {
  return buildMermaidErDiagram({
    schemas: [...new Set(tables.map((t) => t.schema))].sort(),
    tables,
    foreignKeys,
    indexes: [],
    rls: [],
    partitions: [],
  });
}

export function buildDbmlFromTables(tables: ErdTable[], foreignKeys: ErdForeignKey[]): string {
  return buildDbml({
    schemas: [...new Set(tables.map((t) => t.schema))].sort(),
    tables,
    foreignKeys,
    indexes: [],
    rls: [],
    partitions: [],
  });
}
