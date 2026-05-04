/** Dump format flag values for pg_dump -F */
export type PgDumpFormatFlag = 'c' | 'p' | 'd' | 't';

export interface PgDumpFormState {
  format: PgDumpFormatFlag;
  verbose: boolean;
  schemaOnly: boolean;
  dataOnly: boolean;
  blobs: boolean;
  parallelJobs: number;
  compression: number | null;
  outputPath: string;
  database: string;
  /** Optional schema.table for single-table dump (legacy) */
  tableQualified?: string;
  /** Multiple -t flags (preferred when chosen from catalog picker) */
  tableQualifiedList?: string[];
  /** Multiple -n flags (schema subset; ignored by pg_dump when -t is used) */
  schemaNameList?: string[];
  /** Optional single-schema dump (e.g. tasks) */
  schemaName?: string;
  /** Optional extra argv tokens (after built-in flags, before final dbname) */
  extraArgv?: string[];
}

export interface PgRestoreFormState {
  verbose: boolean;
  jobs: number;
  targetDatabase: string;
  /** Archive file or directory path */
  inputPath: string;
  /** When set, only restore TOC entries whose raw lines are included */
  selectedListLines?: string[];
  /** Optional extra argv tokens (after -j/-v, before -d) */
  extraArgv?: string[];
}

export interface PgDumpallFormState {
  verbose: boolean;
  globalsOnly: boolean;
  rolesOnly: boolean;
  outputPath: string;
  /** Optional extra argv tokens (after built-in flags, before -f) */
  extraArgv?: string[];
}
