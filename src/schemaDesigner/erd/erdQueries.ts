import type {
  ErdColumn,
  ErdForeignKey,
  ErdIndexRow,
  ErdPartitionEdge,
  ErdRlsInfo,
  ErdSnapshot,
  ErdTable,
} from './erdTypes';

export interface PgQueryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

const EMPTY_SNAPSHOT: ErdSnapshot = {
  schemas: [],
  tables: [],
  foreignKeys: [],
  indexes: [],
  rls: [],
  partitions: [],
};

/**
 * Load ERD data for one or more schemas in a single round-trip batch (no per-table column queries).
 */
export async function fetchErdSnapshot(client: PgQueryable, schemas: string[]): Promise<ErdSnapshot> {
  if (schemas.length === 0) {
    return { ...EMPTY_SNAPSHOT, schemas: [] };
  }

  const tablesResult = await client.query(
    `SELECT n.nspname AS schema_name,
            c.relname AS table_name,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS est_rows
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
       AND c.relkind = 'r'
     ORDER BY n.nspname, c.relname`,
    [schemas]
  );

  const columnsResult = await client.query(
    `SELECT n.nspname AS schema_name,
            c.relname AS table_name,
            a.attname AS column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = ANY($1::text[])
       AND c.relkind = 'r'
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY n.nspname, c.relname, a.attnum`,
    [schemas]
  );

  const pkResult = await client.query(
    `SELECT tc.table_schema, kcu.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_schema = kcu.constraint_schema
      AND tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = ANY($1::text[])`,
    [schemas]
  );

  const fkColResult = await client.query(
    `SELECT tc.table_schema, kcu.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_schema = kcu.constraint_schema
      AND tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = ANY($1::text[])`,
    [schemas]
  );

  // Pair FK and referenced PK/UNIQUE columns by ordinal_position. Do not use
  // constraint_column_usage for this — in PostgreSQL it has no ordinal_position.
  const fkResult = await client.query(
    `SELECT tc.constraint_name,
            tc.table_schema AS from_schema,
            tc.table_name AS from_table,
            kcu.column_name AS from_column,
            ref_kcu.table_schema AS to_schema,
            ref_kcu.table_name AS to_table,
            ref_kcu.column_name AS to_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_catalog = kcu.constraint_catalog
      AND tc.constraint_schema = kcu.constraint_schema
      AND tc.constraint_name = kcu.constraint_name
     JOIN information_schema.referential_constraints rc
       ON tc.constraint_catalog = rc.constraint_catalog
      AND tc.constraint_schema = rc.constraint_schema
      AND tc.constraint_name = rc.constraint_name
     JOIN information_schema.key_column_usage ref_kcu
       ON rc.unique_constraint_catalog = ref_kcu.constraint_catalog
      AND rc.unique_constraint_schema = ref_kcu.constraint_schema
      AND rc.unique_constraint_name = ref_kcu.constraint_name
      AND kcu.ordinal_position = ref_kcu.ordinal_position
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = ANY($1::text[])
     ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
    [schemas]
  );

  const idxResult = await client.query(
    `SELECT n.nspname AS schema_name,
            c.relname AS table_name,
            i.relname AS index_name
     FROM pg_index x
     JOIN pg_class c ON c.oid = x.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_class i ON i.oid = x.indexrelid
     WHERE n.nspname = ANY($1::text[])
       AND c.relkind = 'r'
       AND NOT x.indisprimary
     ORDER BY n.nspname, c.relname, i.relname`,
    [schemas]
  );

  const rlsResult = await client.query(
    `SELECT n.nspname AS schema_name,
            c.relname AS table_name,
            c.relrowsecurity AS relrowsecurity,
            COALESCE(array_agg(pol.polname ORDER BY pol.polname) FILTER (WHERE pol.polname IS NOT NULL), '{}') AS policy_names
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
     WHERE n.nspname = ANY($1::text[])
       AND c.relkind = 'r'
     GROUP BY n.nspname, c.relname, c.relrowsecurity`,
    [schemas]
  );

  const partResult = await client.query(
    `SELECT pn.nspname AS parent_schema,
            p.relname AS parent_table,
            cn.nspname AS child_schema,
            c.relname AS child_table
     FROM pg_inherits inh
     JOIN pg_class p ON p.oid = inh.inhparent
     JOIN pg_namespace pn ON pn.oid = p.relnamespace
     JOIN pg_class c ON c.oid = inh.inhrelid
     JOIN pg_namespace cn ON cn.oid = c.relnamespace
     WHERE (pn.nspname = ANY($1::text[]) OR cn.nspname = ANY($1::text[]))
       AND p.relkind IN ('r', 'p')`,
    [schemas]
  );

  const pkMap = new Map<string, Set<string>>();
  for (const row of pkResult.rows) {
    const key = `${String(row.table_schema)}.${String(row.table_name)}`;
    if (!pkMap.has(key)) {
      pkMap.set(key, new Set());
    }
    pkMap.get(key)!.add(String(row.column_name));
  }

  const fkMap = new Map<string, Set<string>>();
  for (const row of fkColResult.rows) {
    const key = `${String(row.table_schema)}.${String(row.table_name)}`;
    if (!fkMap.has(key)) {
      fkMap.set(key, new Set());
    }
    fkMap.get(key)!.add(String(row.column_name));
  }

  const columnsByTable = new Map<string, ErdColumn[]>();
  for (const row of columnsResult.rows) {
    const schema = String(row.schema_name);
    const tableName = String(row.table_name);
    const key = `${schema}.${tableName}`;
    const pkCols = pkMap.get(key) ?? new Set<string>();
    const fkCols = fkMap.get(key) ?? new Set<string>();
    const colName = String(row.column_name);
    const col: ErdColumn = {
      name: colName,
      type: String(row.data_type),
      notNull: Boolean(row.not_null),
      isPk: pkCols.has(colName),
      isFk: fkCols.has(colName),
    };
    if (!columnsByTable.has(key)) {
      columnsByTable.set(key, []);
    }
    columnsByTable.get(key)!.push(col);
  }

  const tables: ErdTable[] = [];
  for (const row of tablesResult.rows) {
    const schema = String(row.schema_name);
    const name = String(row.table_name);
    const key = `${schema}.${name}`;
    const rawEst = row.est_rows;
    const estRows =
      rawEst !== null && rawEst !== undefined && !Number.isNaN(Number(rawEst))
        ? Number(rawEst)
        : undefined;
    tables.push({
      schema,
      name,
      ...(estRows !== undefined ? { estRows } : {}),
      columns: columnsByTable.get(key) ?? [],
    });
  }

  const foreignKeys: ErdForeignKey[] = fkResult.rows.map((r) => ({
    constraintName: String(r.constraint_name),
    fromSchema: String(r.from_schema),
    fromTable: String(r.from_table),
    fromColumn: String(r.from_column),
    toSchema: String(r.to_schema),
    toTable: String(r.to_table),
    toColumn: String(r.to_column),
  }));

  const indexes: ErdIndexRow[] = idxResult.rows.map((r) => ({
    schema: String(r.schema_name),
    tableName: String(r.table_name),
    indexName: String(r.index_name),
  }));

  const rls: ErdRlsInfo[] = rlsResult.rows.map((r) => ({
    schema: String(r.schema_name),
    tableName: String(r.table_name),
    relrowsecurity: Boolean(r.relrowsecurity),
    policies: Array.isArray(r.policy_names)
      ? (r.policy_names as string[]).filter(Boolean)
      : [],
  }));

  const partitions: ErdPartitionEdge[] = partResult.rows.map((r) => ({
    parentSchema: String(r.parent_schema),
    parentTable: String(r.parent_table),
    childSchema: String(r.child_schema),
    childTable: String(r.child_table),
  }));

  return {
    schemas: [...schemas].sort(),
    tables,
    foreignKeys,
    indexes,
    rls,
    partitions,
  };
}
