import type {
  ColumnDiff,
  ColumnSnapshot,
  ConstraintDiff,
  ConstraintSnapshot,
  DiffStatus,
  IndexDiff,
  IndexSnapshot,
  SchemaSnapshot,
  TableDiff,
} from './schemaDiffTypes';

/**
 * Pure diff + migration statement generation (no VS Code / I/O).
 * Used by {@link SchemaDiffPanel} and unit tests.
 */
export function computeSchemaDiff(source: SchemaSnapshot, target: SchemaSnapshot): TableDiff[] {
  const diffs: TableDiff[] = [];
  const sourceMap = new Map(source.tables.map((t) => [t.name, t]));
  const targetMap = new Map(target.tables.map((t) => [t.name, t]));

  const allTableNames = new Set([...sourceMap.keys(), ...targetMap.keys()]);

  for (const tableName of allTableNames) {
    const srcTable = sourceMap.get(tableName);
    const tgtTable = targetMap.get(tableName);

    if (!srcTable) {
      diffs.push({
        name: tableName,
        status: 'added',
        columnDiffs: (tgtTable!.columns || []).map((c) => ({ name: c.column_name, status: 'added', after: c })),
        constraintDiffs: (tgtTable!.constraints || []).map((c) => ({ name: c.name, status: 'added', after: c })),
        indexDiffs: (tgtTable!.indexes || []).map((i) => ({ name: i.name, status: 'added', after: i })),
      });
      continue;
    }

    if (!tgtTable) {
      diffs.push({
        name: tableName,
        status: 'removed',
        columnDiffs: (srcTable.columns || []).map((c) => ({ name: c.column_name, status: 'removed', before: c })),
        constraintDiffs: (srcTable.constraints || []).map((c) => ({ name: c.name, status: 'removed', before: c })),
        indexDiffs: (srcTable.indexes || []).map((i) => ({ name: i.name, status: 'removed', before: i })),
      });
      continue;
    }

    const columnDiffs = diffColumns(srcTable.columns, tgtTable.columns);
    const constraintDiffs = diffConstraints(srcTable.constraints, tgtTable.constraints);
    const indexDiffs = diffIndexes(srcTable.indexes, tgtTable.indexes);

    const hasChanges =
      columnDiffs.some((d) => d.status !== 'unchanged') ||
      constraintDiffs.some((d) => d.status !== 'unchanged') ||
      indexDiffs.some((d) => d.status !== 'unchanged');

    diffs.push({
      name: tableName,
      status: hasChanges ? 'changed' : 'unchanged',
      columnDiffs,
      constraintDiffs,
      indexDiffs,
    });
  }

  const order: Record<DiffStatus, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 };
  diffs.sort((a, b) => order[a.status] - order[b.status]);

  return diffs;
}

export function diffColumns(src: ColumnSnapshot[], tgt: ColumnSnapshot[]): ColumnDiff[] {
  const srcMap = new Map(src.map((c) => [c.column_name, c]));
  const tgtMap = new Map(tgt.map((c) => [c.column_name, c]));
  const diffs: ColumnDiff[] = [];

  for (const [name, srcCol] of srcMap) {
    const tgtCol = tgtMap.get(name);
    if (!tgtCol) {
      diffs.push({ name, status: 'removed', before: srcCol });
    } else {
      const changed =
        srcCol.data_type !== tgtCol.data_type ||
        srcCol.not_null !== tgtCol.not_null ||
        (srcCol.default_value || '') !== (tgtCol.default_value || '');
      diffs.push({ name, status: changed ? 'changed' : 'unchanged', before: srcCol, after: tgtCol });
    }
  }
  for (const [name, tgtCol] of tgtMap) {
    if (!srcMap.has(name)) {
      diffs.push({ name, status: 'added', after: tgtCol });
    }
  }
  return diffs;
}

export function diffConstraints(src: ConstraintSnapshot[], tgt: ConstraintSnapshot[]): ConstraintDiff[] {
  const srcMap = new Map(src.map((c) => [c.name, c]));
  const tgtMap = new Map(tgt.map((c) => [c.name, c]));
  const diffs: ConstraintDiff[] = [];

  for (const [name, srcCon] of srcMap) {
    const tgtCon = tgtMap.get(name);
    if (!tgtCon) {
      diffs.push({ name, status: 'removed', before: srcCon });
    } else {
      const changed = srcCon.definition !== tgtCon.definition;
      diffs.push({ name, status: changed ? 'changed' : 'unchanged', before: srcCon, after: tgtCon });
    }
  }
  for (const [name, tgtCon] of tgtMap) {
    if (!srcMap.has(name)) {
      diffs.push({ name, status: 'added', after: tgtCon });
    }
  }
  return diffs;
}

export function diffIndexes(src: IndexSnapshot[], tgt: IndexSnapshot[]): IndexDiff[] {
  const srcMap = new Map(src.map((i) => [i.name, i]));
  const tgtMap = new Map(tgt.map((i) => [i.name, i]));
  const diffs: IndexDiff[] = [];

  for (const [name, srcIdx] of srcMap) {
    const tgtIdx = tgtMap.get(name);
    if (!tgtIdx) {
      diffs.push({ name, status: 'removed', before: srcIdx });
    } else {
      const changed = srcIdx.definition !== tgtIdx.definition;
      diffs.push({ name, status: changed ? 'changed' : 'unchanged', before: srcIdx, after: tgtIdx });
    }
  }
  for (const [name, tgtIdx] of tgtMap) {
    if (!srcMap.has(name)) {
      diffs.push({ name, status: 'added', after: tgtIdx });
    }
  }
  return diffs;
}

/**
 * SQL statements to migrate **source** schema toward **target** (source = current, target = desired).
 */
export function buildMigrationStatements(
  sourceSchema: string,
  targetSchema: string,
  diffs: TableDiff[],
): string[] {
  const stmts: string[] = [];

  for (const table of diffs) {
    if (table.status === 'unchanged') {
      continue;
    }

    if (table.status === 'added') {
      const cols = table.columnDiffs.filter((c) => c.status === 'added' && c.after);
      const colDefs = cols.map((c) => {
        const nn = c.after!.not_null ? ' NOT NULL' : '';
        const def = c.after!.default_value ? ` DEFAULT ${c.after!.default_value}` : '';
        return `  "${c.name}" ${c.after!.data_type}${nn}${def}`;
      });
      stmts.push(
        `-- Table added in ${targetSchema}\nCREATE TABLE "${sourceSchema}"."${table.name}" (\n${colDefs.join(',\n')}\n);`,
      );
      continue;
    }

    if (table.status === 'removed') {
      stmts.push(
        `-- Table removed in ${targetSchema}\n-- DROP TABLE "${sourceSchema}"."${table.name}"; -- Uncomment to drop`,
      );
      continue;
    }

    stmts.push(`-- Changes for table: ${table.name}`);

    for (const col of table.columnDiffs) {
      if (col.status === 'added' && col.after) {
        const nn = col.after.not_null ? ' NOT NULL' : '';
        const def = col.after.default_value ? ` DEFAULT ${col.after.default_value}` : '';
        stmts.push(
          `ALTER TABLE "${sourceSchema}"."${table.name}"\n  ADD COLUMN "${col.name}" ${col.after.data_type}${nn}${def};`,
        );
      } else if (col.status === 'removed') {
        stmts.push(
          `-- ALTER TABLE "${sourceSchema}"."${table.name}"\n--   DROP COLUMN "${col.name}"; -- Uncomment to drop`,
        );
      } else if (col.status === 'changed' && col.before && col.after) {
        if (col.before.data_type !== col.after.data_type) {
          stmts.push(
            `ALTER TABLE "${sourceSchema}"."${table.name}"\n  ALTER COLUMN "${col.name}" TYPE ${col.after.data_type};`,
          );
        }
        if (col.before.not_null !== col.after.not_null) {
          stmts.push(
            `ALTER TABLE "${sourceSchema}"."${table.name}"\n  ALTER COLUMN "${col.name}" ${col.after.not_null ? 'SET' : 'DROP'} NOT NULL;`,
          );
        }
        if ((col.before.default_value || '') !== (col.after.default_value || '')) {
          if (col.after.default_value) {
            stmts.push(
              `ALTER TABLE "${sourceSchema}"."${table.name}"\n  ALTER COLUMN "${col.name}" SET DEFAULT ${col.after.default_value};`,
            );
          } else {
            stmts.push(
              `ALTER TABLE "${sourceSchema}"."${table.name}"\n  ALTER COLUMN "${col.name}" DROP DEFAULT;`,
            );
          }
        }
      }
    }

    for (const con of table.constraintDiffs) {
      if (con.status === 'added' && con.after) {
        stmts.push(
          `ALTER TABLE "${sourceSchema}"."${table.name}"\n  ADD CONSTRAINT "${con.name}" ${con.after.definition};`,
        );
      } else if (con.status === 'removed') {
        stmts.push(
          `-- ALTER TABLE "${sourceSchema}"."${table.name}"\n--   DROP CONSTRAINT "${con.name}"; -- Uncomment to drop`,
        );
      }
    }

    for (const idx of table.indexDiffs) {
      if (idx.status === 'added' && idx.after) {
        stmts.push(
          idx.after.definition.replace(new RegExp(`ON ${targetSchema}\\.`, 'g'), `ON ${sourceSchema}.`) + ';',
        );
      } else if (idx.status === 'removed') {
        stmts.push(`-- DROP INDEX "${idx.name}"; -- Uncomment to drop`);
      }
    }
  }

  return stmts;
}
