/**
 * Shared types for ERD 2.0 (extension host + webview payload).
 */

export interface ErdColumn {
  name: string;
  type: string;
  notNull: boolean;
  isPk: boolean;
  isFk: boolean;
}

export interface ErdTable {
  name: string;
  schema: string;
  estRows?: number;
  columns: ErdColumn[];
}

export interface ErdForeignKey {
  constraintName: string;
  fromSchema: string;
  fromTable: string;
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
}

export interface ErdIndexRow {
  schema: string;
  tableName: string;
  indexName: string;
}

export interface ErdRlsInfo {
  schema: string;
  tableName: string;
  relrowsecurity: boolean;
  policies: string[];
}

export interface ErdPartitionEdge {
  parentSchema: string;
  parentTable: string;
  childSchema: string;
  childTable: string;
}

/** Full snapshot fetched on the host for one or more schemas. */
export interface ErdSnapshot {
  schemas: string[];
  tables: ErdTable[];
  foreignKeys: ErdForeignKey[];
  indexes: ErdIndexRow[];
  rls: ErdRlsInfo[];
  partitions: ErdPartitionEdge[];
}

/** Wire format injected into the webview. */
export interface ErdWebviewPayload {
  snapshot: ErdSnapshot;
  /** True when the connection profile forces read-only execution (informational for migration draft). */
  readOnlyConnection: boolean;
}

export function tableQual(schema: string, name: string): string {
  return `${schema}.${name}`;
}
