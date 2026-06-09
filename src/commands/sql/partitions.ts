function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export type PartitionStrategy = 'range' | 'list' | 'hash' | 'default';

export interface PartitionDefinition {
  parentSchema: string;
  parentTable: string;
  partitionSchema?: string;
  partitionName: string;
  strategy: PartitionStrategy;
  /** RANGE: raw lower/upper bound expressions, e.g. "'2024-01-01'" or "MINVALUE". */
  from?: string;
  to?: string;
  /** LIST: raw comma-separated value expressions, e.g. "'EU', 'US'". */
  values?: string;
  /** HASH: modulus + remainder. */
  modulus?: number;
  remainder?: number;
}

/** Render the FOR VALUES / DEFAULT bound clause for a partition definition. */
export function renderPartitionBound(def: PartitionDefinition): string {
  switch (def.strategy) {
    case 'range':
      return `FOR VALUES FROM (${def.from ?? ''}) TO (${def.to ?? ''})`;
    case 'list':
      return `FOR VALUES IN (${def.values ?? ''})`;
    case 'hash':
      return `FOR VALUES WITH (MODULUS ${def.modulus ?? 0}, REMAINDER ${def.remainder ?? 0})`;
    case 'default':
      return 'DEFAULT';
  }
}

export const PartitionSQL = {
  list: (schema: string, table: string) => `
SELECT c.relname AS partition_name,
       n.nspname AS partition_schema,
       pg_get_expr(c.relpartbound, c.oid, true) AS partition_bound,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
       c.reltuples::bigint AS estimated_rows
FROM pg_inherits i
JOIN pg_class c ON i.inhrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_class p ON i.inhparent = p.oid
JOIN pg_namespace pn ON p.relnamespace = pn.oid
WHERE pn.nspname = '${schema}' AND p.relname = '${table}'
ORDER BY c.relname
`,

  isPartitioned: (schema: string, table: string) => `
SELECT c.relkind = 'p' AS is_partitioned,
       pg_get_partkeydef(c.oid) AS partition_key
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = '${schema}' AND c.relname = '${table}'
`,

  attach: (schema: string, table: string, partitionSchema: string, partitionName: string, partitionBound: string) =>
    `ALTER TABLE "${schema}"."${table}" ATTACH PARTITION "${partitionSchema}"."${partitionName}" ${partitionBound};`,

  detach: (schema: string, table: string, partitionName: string) =>
    `ALTER TABLE "${schema}"."${table}" DETACH PARTITION "${partitionName}";`,

  createRangePartition: (schema: string, table: string) => `-- Create a new range partition on ${schema}.${table}
CREATE TABLE "${schema}"."partition_name" PARTITION OF "${schema}"."${table}"
  FOR VALUES FROM ('start_value') TO ('end_value');
`,

  createListPartition: (schema: string, table: string) => `-- Create a new list partition on ${schema}.${table}
CREATE TABLE "${schema}"."partition_name" PARTITION OF "${schema}"."${table}"
  FOR VALUES IN ('value1', 'value2');
`,

  /** Build a concrete CREATE TABLE ... PARTITION OF statement from a definition. */
  createPartition: (def: PartitionDefinition): string => {
    const partSchema = def.partitionSchema || def.parentSchema;
    const child = `${quoteIdent(partSchema)}.${quoteIdent(def.partitionName)}`;
    const parent = `${quoteIdent(def.parentSchema)}.${quoteIdent(def.parentTable)}`;
    return `CREATE TABLE ${child} PARTITION OF ${parent}\n  ${renderPartitionBound(def)};`;
  },
};
