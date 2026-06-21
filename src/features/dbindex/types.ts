export type BuildMode = 'auto' | 'guided';
export type BuildDepth = 'structure' | 'stats' | 'profiles';

export interface IndexScope {
  includedSchemas: string[];
  excludedObjects: string[];
  piiExcludedColumns: string[]; // formatted as 'schema.table.column'
}

export interface ObjectShard {
  file: string;
  schema: string;
  objects: number;
  bytes: number;
  hash: string;
}

export interface IndexManifest {
  formatVersion: number;
  connectionId: string;
  database: string;
  indexedAt: string;
  buildMode: BuildMode;
  buildDepth: BuildDepth;
  schemaFingerprint: string;
  pgVersion: string;
  environment: string;
  scope: IndexScope;
  counts: {
    tables: number;
    views: number;
    functions: number;
    enums: number;
  };
  shards: ObjectShard[];
  derived: {
    tokens: string;
    joinGraph: string;
    embeddings?: string;
    embeddingsMeta?: string;
  };
  stats: {
    buildMs: number;
    queriesRun: number;
    warnings: string[];
  };
}

export interface ColumnProfile {
  nDistinct: number;
  nullFrac: number;
  commonValues?: string[]; // pg_stats most_common_vals capped and stringified
  min?: string | null;
  max?: string | null;
}

export interface ColumnEntry {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  comment: string | null;
  ordinal: number;
  isPk?: boolean;
  profile?: ColumnProfile;
}

export interface ForeignKeyEntry {
  columns: string[];
  refTable: string; // 'schema.table'
  refColumns: string[];
  name: string;
  onDelete?: string;
}

export interface IndexEntry {
  name: string;
  columns: string[];
  unique: boolean;
  method: string;
  partial?: string | null;
}

export interface CheckEntry {
  name: string;
  expr: string;
}

export type DbObjectKind = 'table' | 'view' | 'matview' | 'function' | 'enum' | 'domain' | 'sequence';

export interface ObjectEntry {
  kind: DbObjectKind;
  oid: number;
  objectHash: string;
  comment: string | null;
  rowEstimate: number;
  sizeBytes: number;
  columns: ColumnEntry[];
  primaryKey?: string[];
  foreignKeys?: ForeignKeyEntry[];
  indexes?: IndexEntry[];
  checks?: CheckEntry[];

  // views / matviews
  definition?: string;

  // functions
  signature?: string;
  language?: string;
  volatility?: string;
  body?: string | null;

  // enums / domains
  values?: string[];
  baseType?: string;
  constraint?: string;
}

export interface TokenIndex {
  version: number;
  df: Record<string, number>; // document frequency of each token -> IDF computation
  postings: Record<string, [string, number][]>; // map token to array of [objectRef, weight]
  synonyms: Record<string, string[]>;
}

export interface JoinEdge {
  from: string;
  to: string;
  via: string;
  cols: [string, string][];
}

export interface JoinGraph {
  edges: JoinEdge[];
}

export interface EmbeddingMetaEntry {
  ref: string;
  objectHash: string;
  model: string;
  dim: number;
}
