/**
 * Pure mapping from ERD edit patches to PostgreSQL DDL (reviewed in a notebook).
 */

export type ErdModelPatch =
  | { kind: 'renameTable'; schema: string; from: string; to: string }
  | { kind: 'renameColumn'; schema: string; table: string; from: string; to: string }
  | {
      kind: 'addColumn';
      schema: string;
      table: string;
      name: string;
      dataType: string;
      notNull: boolean;
    };

function ident(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * Produce ordered DDL statements for patches. Caller wraps with transaction boilerplate.
 */
export function patchesToMigrationSql(patches: ErdModelPatch[]): string[] {
  const stmts: string[] = [];
  const renames = patches.filter((p): p is Extract<ErdModelPatch, { kind: 'renameTable' }> => p.kind === 'renameTable');
  const colRenames = patches.filter((p): p is Extract<ErdModelPatch, { kind: 'renameColumn' }> => p.kind === 'renameColumn');
  const adds = patches.filter((p): p is Extract<ErdModelPatch, { kind: 'addColumn' }> => p.kind === 'addColumn');

  for (const p of renames) {
    const a = ident(p.schema);
    const f = ident(p.from);
    const t = ident(p.to);
    stmts.push(`ALTER TABLE ${a}.${f} RENAME TO ${t};`);
  }

  for (const p of colRenames) {
    const sch = ident(p.schema);
    const tbl = ident(p.table);
    const c1 = ident(p.from);
    const c2 = ident(p.to);
    stmts.push(`ALTER TABLE ${sch}.${tbl} RENAME COLUMN ${c1} TO ${c2};`);
  }

  for (const p of adds) {
    const sch = ident(p.schema);
    const tbl = ident(p.table);
    const col = ident(p.name);
    const nn = p.notNull ? ' NOT NULL' : '';
    stmts.push(`ALTER TABLE ${sch}.${tbl} ADD COLUMN ${col} ${p.dataType.trim()}${nn};`);
  }

  return stmts;
}
