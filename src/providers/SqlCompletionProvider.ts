import * as vscode from 'vscode';
import { ConnectionManager } from '../services/ConnectionManager';
import { SqlParser } from './kernel/SqlParser';
import { outputChannel } from '../extension';
import { sqlFormatIdentifier } from './sql-completion-shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TableInfo {
  schema: string;
  objectName: string;
  objectType: string;
  arguments?: string;
  callArguments?: string;
  /** Materialized view: whether relation is populated (pg_class.relispopulated). */
  isPopulated?: boolean;
}

interface ColumnInfo {
  schema: string;
  tableName: string;
  columnName: string;
  dataType: string;
  /** information_schema — composite / domain typing hints */
  udtSchema?: string;
  udtName?: string;
}

interface ForeignKeyInfo {
  schema: string;
  tableName: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

interface RelationContext {
  schema: string | null;
  objectName: string;
  alias: string;
}

interface ParsedQuery {
  cleanText: string;
  clause: SqlClause;
  relations: RelationContext[];
  aliasMap: Map<string, RelationContext>;
  qualifiedMap: Map<string, RelationContext>;
  referencedTables: Set<string>;
  cteColumns: Map<string, string[]>;
  dotQualifier: string | null;
  hasQualifiedPrefix: boolean;
  dotPartial: string | null;
  insertTarget: RelationContext | null;
  updateTarget: RelationContext | null;
  /** Subquery / derived columns: alias -> projected column names */
  derivedColumns: Map<string, string[]>;
  /** Inner SELECT bodies for derived-table aliases (wildcard expansion) */
  derivedBodies: Map<string, string>;
  /** Raw CTE bodies for wildcard expansion */
  cteBodies: Map<string, string>;
  /** Column data type (information_schema) before cursor in WHERE/HAVING for operator filtering */
  precedingWhereColumnType: string | null;
}

interface SchemaCache {
  objects: TableInfo[];
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  searchPath: string[];
  /** Composite types (typtype=c): key lower(schema.typname) -> attribute names */
  compositeAttrs: Map<string, string[]>;
  /** Role names for GRANT ... TO */
  roles: string[];
  updatedAt: number;
}

const EMPTY_CACHE: SchemaCache = {
  objects: [],
  columns: [],
  foreignKeys: [],
  searchPath: ['public'],
  compositeAttrs: new Map(),
  roles: [],
  updatedAt: 0
};

enum SqlClause {
  Unknown = 'unknown',
  Select = 'select',
  From = 'from',
  Join = 'join',
  Where = 'where',
  GroupBy = 'groupBy',
  OrderBy = 'orderBy',
  Having = 'having',
  On = 'on',
  InsertColumns = 'insertColumns',
  InsertTarget = 'insertTarget',
  UpdateSet = 'updateSet',
  Returning = 'returning',
  DeleteFrom = 'deleteFrom',
  DeleteUsing = 'deleteUsing',
  ExplainOptions = 'explainOptions',
  CopyOptions = 'copyOptions',
  CreateTableColumn = 'createTableColumn',
  AlterTableOp = 'alterTableOp',
  GrantOn = 'grantOn',
  GrantTo = 'grantTo'
}

// ---------------------------------------------------------------------------
// Keyword / snippet catalogs
// ---------------------------------------------------------------------------

const AGGREGATE_FUNCTIONS: Array<{ label: string; snippet: string; detail: string }> = [
  { label: 'COUNT(*)', snippet: 'COUNT(*)', detail: 'Count all rows' },
  { label: 'COUNT', snippet: 'COUNT(${1:column})', detail: 'Count non-null values' },
  { label: 'SUM', snippet: 'SUM(${1:column})', detail: 'Sum of values' },
  { label: 'AVG', snippet: 'AVG(${1:column})', detail: 'Average value' },
  { label: 'MIN', snippet: 'MIN(${1:column})', detail: 'Minimum value' },
  { label: 'MAX', snippet: 'MAX(${1:column})', detail: 'Maximum value' },
  { label: 'STRING_AGG', snippet: "STRING_AGG(${1:column}, '${2:,}')", detail: 'Concatenate strings' },
  { label: 'ARRAY_AGG', snippet: 'ARRAY_AGG(${1:column})', detail: 'Aggregate into array' },
  { label: 'JSON_AGG', snippet: 'JSON_AGG(${1:column})', detail: 'Aggregate into JSON array' },
  { label: 'JSONB_AGG', snippet: 'JSONB_AGG(${1:column})', detail: 'Aggregate into JSONB array' },
  { label: 'BOOL_AND', snippet: 'BOOL_AND(${1:column})', detail: 'True if all true' },
  { label: 'BOOL_OR', snippet: 'BOOL_OR(${1:column})', detail: 'True if any true' }
];

const WINDOW_FUNCTIONS: Array<{ label: string; snippet: string; detail: string }> = [
  { label: 'ROW_NUMBER()', snippet: 'ROW_NUMBER() OVER (${1:PARTITION BY ${2:col} }ORDER BY ${3:col})', detail: 'Row number within partition' },
  { label: 'RANK()', snippet: 'RANK() OVER (${1:PARTITION BY ${2:col} }ORDER BY ${3:col})', detail: 'Rank with gaps' },
  { label: 'DENSE_RANK()', snippet: 'DENSE_RANK() OVER (${1:PARTITION BY ${2:col} }ORDER BY ${3:col})', detail: 'Rank without gaps' },
  { label: 'LAG', snippet: 'LAG(${1:column}, ${2:1}) OVER (ORDER BY ${3:col})', detail: 'Previous row value' },
  { label: 'LEAD', snippet: 'LEAD(${1:column}, ${2:1}) OVER (ORDER BY ${3:col})', detail: 'Next row value' },
  { label: 'FIRST_VALUE', snippet: 'FIRST_VALUE(${1:column}) OVER (ORDER BY ${2:col})', detail: 'First value in partition' },
  { label: 'LAST_VALUE', snippet: 'LAST_VALUE(${1:column}) OVER (ORDER BY ${2:col})', detail: 'Last value in partition' },
  { label: 'NTILE', snippet: 'NTILE(${1:4}) OVER (ORDER BY ${2:col})', detail: 'Distribute into N buckets' },
  { label: 'PERCENT_RANK()', snippet: 'PERCENT_RANK() OVER (ORDER BY ${1:col})', detail: 'Relative rank 0-1' },
  { label: 'CUME_DIST()', snippet: 'CUME_DIST() OVER (ORDER BY ${1:col})', detail: 'Cumulative distribution' }
];

const SCALAR_FUNCTIONS: Array<{ label: string; snippet: string; detail: string }> = [
  { label: 'COALESCE', snippet: 'COALESCE(${1:col}, ${2:default})', detail: 'First non-null value' },
  { label: 'NULLIF', snippet: 'NULLIF(${1:col}, ${2:value})', detail: 'Null if equal' },
  { label: 'GREATEST', snippet: 'GREATEST(${1:a}, ${2:b})', detail: 'Largest value' },
  { label: 'LEAST', snippet: 'LEAST(${1:a}, ${2:b})', detail: 'Smallest value' },
  { label: 'NOW()', snippet: 'NOW()', detail: 'Current timestamp with tz' },
  { label: 'CURRENT_TIMESTAMP', snippet: 'CURRENT_TIMESTAMP', detail: 'Current timestamp' },
  { label: 'CURRENT_DATE', snippet: 'CURRENT_DATE', detail: 'Current date' },
  { label: 'EXTRACT', snippet: "EXTRACT(${1|YEAR,MONTH,DAY,HOUR,MINUTE,SECOND,DOW,DOY,EPOCH|} FROM ${2:col})", detail: 'Extract date part' },
  { label: 'DATE_TRUNC', snippet: "DATE_TRUNC('${1|year,month,week,day,hour,minute,second|}', ${2:col})", detail: 'Truncate to date part' },
  { label: 'DATE_PART', snippet: "DATE_PART('${1|year,month,day,hour,minute,second|}', ${2:col})", detail: 'Extract date part (numeric)' },
  { label: 'TO_CHAR', snippet: "TO_CHAR(${1:col}, '${2:YYYY-MM-DD}')", detail: 'Format to string' },
  { label: 'TO_DATE', snippet: "TO_DATE('${1:str}', '${2:YYYY-MM-DD}')", detail: 'Parse date from string' },
  { label: 'INTERVAL', snippet: "INTERVAL '${1:7 days}'", detail: 'Time interval literal' },
  { label: 'UPPER', snippet: 'UPPER(${1:col})', detail: 'Uppercase string' },
  { label: 'LOWER', snippet: 'LOWER(${1:col})', detail: 'Lowercase string' },
  { label: 'TRIM', snippet: 'TRIM(${1:col})', detail: 'Remove leading/trailing whitespace' },
  { label: 'LENGTH', snippet: 'LENGTH(${1:col})', detail: 'String length' },
  { label: 'CONCAT', snippet: 'CONCAT(${1:a}, ${2:b})', detail: 'Concatenate strings' },
  { label: 'REPLACE', snippet: "REPLACE(${1:col}, '${2:from}', '${3:to}')", detail: 'Replace substring' },
  { label: 'SUBSTRING', snippet: "SUBSTRING(${1:col} FROM ${2:1} FOR ${3:10})", detail: 'Extract substring' },
  { label: 'SPLIT_PART', snippet: "SPLIT_PART(${1:col}, '${2:delimiter}', ${3:1})", detail: 'Split and return part' },
  { label: 'REGEXP_REPLACE', snippet: "REGEXP_REPLACE(${1:col}, '${2:pattern}', '${3:replacement}')", detail: 'Regex replace' },
  { label: 'CAST', snippet: 'CAST(${1:col} AS ${2:type})', detail: 'Type cast' },
  { label: 'GENERATE_SERIES', snippet: 'GENERATE_SERIES(${1:1}, ${2:10}, ${3:1})', detail: 'Generate a series of values' },
  { label: 'UNNEST', snippet: 'UNNEST(${1:array_col})', detail: 'Expand array to rows' },
  { label: 'JSON_BUILD_OBJECT', snippet: "JSON_BUILD_OBJECT('${1:key}', ${2:value})", detail: 'Build JSON object' },
  { label: 'JSONB_BUILD_OBJECT', snippet: "JSONB_BUILD_OBJECT('${1:key}', ${2:value})", detail: 'Build JSONB object' },
  { label: 'TO_JSON', snippet: 'TO_JSON(${1:value})', detail: 'Convert to JSON' },
  { label: 'ROW_TO_JSON', snippet: 'ROW_TO_JSON(${1:row})', detail: 'Convert row to JSON' },
  { label: 'ARRAY_LENGTH', snippet: 'ARRAY_LENGTH(${1:col}, 1)', detail: 'Length of array dimension' },
  { label: 'CARDINALITY', snippet: 'CARDINALITY(${1:col})', detail: 'Number of elements in array' }
];

const EXPLAIN_OPTION_KEYWORDS: Array<{ label: string; snippet: string; detail: string }> = [
  { label: 'ANALYZE', snippet: 'ANALYZE', detail: 'EXPLAIN option' },
  { label: 'VERBOSE', snippet: 'VERBOSE', detail: 'EXPLAIN option' },
  { label: 'COSTS', snippet: 'COSTS', detail: 'EXPLAIN option' },
  { label: 'BUFFERS', snippet: 'BUFFERS', detail: 'EXPLAIN option' },
  { label: 'TIMING', snippet: 'TIMING', detail: 'EXPLAIN option' },
  { label: 'SUMMARY', snippet: 'SUMMARY', detail: 'EXPLAIN option' },
  { label: 'FORMAT TEXT', snippet: 'FORMAT TEXT', detail: 'EXPLAIN output format' },
  { label: 'FORMAT JSON', snippet: 'FORMAT JSON', detail: 'EXPLAIN output format' },
  { label: 'FORMAT XML', snippet: 'FORMAT XML', detail: 'EXPLAIN output format' },
  { label: 'FORMAT YAML', snippet: 'FORMAT YAML', detail: 'EXPLAIN output format' },
  { label: 'WAL', snippet: 'WAL', detail: 'EXPLAIN option (PG13+)' },
  { label: 'SETTINGS', snippet: 'SETTINGS', detail: 'EXPLAIN option' }
];

const COPY_WITH_OPTIONS: Array<{ label: string; snippet: string; detail: string }> = [
  { label: 'FORMAT CSV', snippet: 'FORMAT CSV', detail: 'COPY format' },
  { label: 'FORMAT TEXT', snippet: 'FORMAT TEXT', detail: 'COPY format' },
  { label: 'FORMAT BINARY', snippet: 'FORMAT BINARY', detail: 'COPY format' },
  { label: 'DELIMITER', snippet: "DELIMITER '${1:,}'", detail: 'COPY TEXT delimiter' },
  { label: 'NULL', snippet: "NULL '${1:\\\\N}'", detail: 'COPY null string' },
  { label: 'HEADER', snippet: 'HEADER', detail: 'CSV header row' },
  { label: 'QUOTE', snippet: "QUOTE '${1:\"}'", detail: 'CSV quote character' },
  { label: 'ESCAPE', snippet: "ESCAPE '\\'", detail: 'CSV escape' },
  { label: 'ENCODING', snippet: 'UTF8', detail: 'Character encoding' },
  { label: 'FREEZE', snippet: 'FREEZE', detail: 'COPY FREEZE' },
  { label: 'FORCE_QUOTE', snippet: 'FORCE_QUOTE (*)', detail: 'CSV force quote' },
  { label: 'FORCE_NOT_NULL', snippet: 'FORCE_NOT_NULL (${1:col})', detail: 'CSV columns' }
];

const PG_TYPE_GROUPS = {
  numeric: /smallint|integer|bigint|decimal|numeric|real|double|serial|money/i,
  dateTime: /date|time|timestamp|interval/i,
  string: /character|varchar|text|name|uuid|bytea|bit/i,
  boolean: /boolean/i,
  json: /jsonb?|json/i,
  geometric: /point|line|lseg|box|path|polygon|circle/i,
  network: /cidr|inet|macaddr/i,
  array: /\[\]/i,
  fullText: /tsvector|tsquery/i
};

const CREATE_TABLE_SNIPPETS: Array<{ label: string; snippet: string; detail: string }> = [
  { label: 'id SERIAL PRIMARY KEY', snippet: 'id SERIAL PRIMARY KEY', detail: 'Common surrogate key' },
  { label: 'INTEGER', snippet: 'INTEGER', detail: 'Type' },
  { label: 'BIGINT', snippet: 'BIGINT', detail: 'Type' },
  { label: 'TEXT', snippet: 'TEXT', detail: 'Type' },
  { label: 'VARCHAR(n)', snippet: 'VARCHAR(${1:255})', detail: 'Variable-length text' },
  { label: 'BOOLEAN', snippet: 'BOOLEAN', detail: 'Type' },
  { label: 'TIMESTAMPTZ', snippet: 'TIMESTAMPTZ', detail: 'Timestamp with time zone' },
  { label: 'UUID', snippet: 'UUID', detail: 'Type' },
  { label: 'JSONB', snippet: 'JSONB', detail: 'Binary JSON' },
  { label: 'NUMERIC(p,s)', snippet: 'NUMERIC(${1:10},${2:2})', detail: 'Exact numeric' },
  { label: 'NOT NULL', snippet: 'NOT NULL', detail: 'Constraint' },
  { label: 'PRIMARY KEY', snippet: 'PRIMARY KEY', detail: 'Constraint' },
  { label: 'REFERENCES', snippet: 'REFERENCES ${1:table}(${2:id})', detail: 'FK' },
  { label: 'UNIQUE', snippet: 'UNIQUE', detail: 'Constraint' },
  { label: 'DEFAULT', snippet: 'DEFAULT ${1:value}', detail: 'Default value' },
  { label: 'CHECK (...)', snippet: 'CHECK (${1:condition})', detail: 'Check constraint' },
  { label: 'GENERATED ALWAYS AS IDENTITY', snippet: 'GENERATED ALWAYS AS IDENTITY', detail: 'Identity column' }
];

const ALTER_TABLE_KEYWORDS = [
  'ADD COLUMN',
  'DROP COLUMN',
  'RENAME COLUMN',
  'RENAME TO',
  'ALTER COLUMN',
  'SET SCHEMA',
  'ENABLE TRIGGER',
  'DISABLE TRIGGER',
  'ATTACH PARTITION',
  'DETACH PARTITION'
];

const GROUP_ORDER_SNIPPETS = [
  { label: 'LIMIT 100', snippet: 'LIMIT 100', detail: 'Cap rows' },
  { label: 'OFFSET 0', snippet: 'OFFSET 0', detail: 'Skip rows' },
  { label: 'HAVING COUNT(*) > 1', snippet: 'HAVING COUNT(*) > 1', detail: 'Filter aggregates' },
  { label: 'GROUP BY ROLLUP (...)', snippet: 'GROUP BY ROLLUP (${1:col})', detail: 'Rollup' },
  { label: 'GROUP BY GROUPING SETS (...)', snippet: 'GROUP BY GROUPING SETS (${1:()})', detail: 'Grouping sets' }
];

const WHERE_OPERATORS: Array<{ label: string; snippet: string; detail: string }> = [
  { label: 'IS NULL', snippet: 'IS NULL', detail: 'Check for null' },
  { label: 'IS NOT NULL', snippet: 'IS NOT NULL', detail: 'Check for non-null' },
  { label: 'IN (...)', snippet: 'IN (${1:value})', detail: 'Match any value in list' },
  { label: 'NOT IN (...)', snippet: 'NOT IN (${1:value})', detail: 'Not in list' },
  { label: 'BETWEEN', snippet: 'BETWEEN ${1:low} AND ${2:high}', detail: 'Inclusive range check' },
  { label: 'LIKE', snippet: "LIKE '${1:%pattern%}'", detail: 'Pattern match (case sensitive)' },
  { label: 'ILIKE', snippet: "ILIKE '${1:%pattern%}'", detail: 'Pattern match (case insensitive)' },
  { label: 'NOT LIKE', snippet: "NOT LIKE '${1:%pattern%}'", detail: 'Negate pattern match' },
  { label: '~', snippet: "~ '${1:regex}'", detail: 'Regex match (case sensitive)' },
  { label: '~*', snippet: "~* '${1:regex}'", detail: 'Regex match (case insensitive)' },
  { label: 'ANY', snippet: 'ANY(${1:array_col})', detail: 'Match any element in array' },
  { label: 'ALL', snippet: 'ALL(${1:subquery})', detail: 'Match all elements' },
  { label: 'EXISTS', snippet: 'EXISTS (${1:SELECT 1 FROM ...})', detail: 'Subquery exists' },
  { label: 'NOT EXISTS', snippet: 'NOT EXISTS (${1:SELECT 1 FROM ...})', detail: 'Subquery does not exist' }
];

const SQL_RESERVED_ALIAS = new Set([
  'select', 'from', 'where', 'join', 'on', 'group', 'order', 'having', 'limit', 'offset',
  'left', 'right', 'inner', 'outer', 'full', 'cross', 'into', 'values', 'set', 'returning',
  'as', 'and', 'or', 'not', 'update', 'delete', 'insert', 'table', 'call', 'truncate'
]);

/** Relation kinds suitable for "table named q in search_path" disambiguation vs schema-qualified `q.` */
const RELATION_OBJECT_TYPES = new Set(['table', 'view', 'materialized view']);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private static instance: SqlCompletionProvider | null = null;

  private schemaCache: Map<string, SchemaCache> = new Map();
  private catalogEpoch: Map<string, number> = new Map();
  private fetchLocks: Map<string, Promise<void>> = new Map();

  private readonly CACHE_TTL_MS = 120_000;

  private static readonly RELATION_LEAD_IN =
    '(?:from|join|update|into|table|delete\\s+from|truncate\\s+table|call)\\s+(?:lateral\\s+)?';

  private static readonly CATALOG_OBJECTS_SQL = `
              SELECT * FROM (
              SELECT 'table' AS object_type, n.nspname AS schema, c.relname AS object_name,
                     NULL::text AS arguments, NULL::text AS call_arguments,
                     NULL::boolean AS is_populated
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              UNION ALL
              SELECT 'view', n.nspname, c.relname, NULL::text, NULL::text, NULL::boolean
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'v'
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              UNION ALL
              SELECT 'materialized view', n.nspname, c.relname, NULL::text, NULL::text, c.relispopulated
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'm'
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              UNION ALL
              SELECT
                  CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END,
                  n.nspname,
                  p.proname,
                  pg_get_function_arguments(p.oid) AS arguments,
                  pg_get_function_identity_arguments(p.oid) AS call_arguments,
                  NULL::boolean AS is_populated
              FROM pg_proc p
              JOIN pg_namespace n ON p.pronamespace = n.oid
              WHERE p.prokind IN ('f', 'p')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              ) q ORDER BY schema, object_name
                `;

  private static readonly CATALOG_COLUMNS_SQL = `
                    SELECT
                        table_schema as schema,
                        table_name,
                        column_name,
                        data_type,
                        udt_schema,
                        udt_name
                    FROM information_schema.columns
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name, ordinal_position
                `;

  private static readonly CATALOG_COMPOSITE_SQL = `
              SELECT n.nspname AS schema, t.typname AS type_name,
                     array_agg(a.attname ORDER BY a.attnum) AS attrs
              FROM pg_type t
              JOIN pg_namespace n ON n.oid = t.typnamespace
              JOIN pg_attribute a ON a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
              WHERE t.typtype = 'c'
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              GROUP BY n.nspname, t.typname
                `;

  private static readonly CATALOG_FK_SQL = `
                    SELECT
                      n.nspname AS schema,
                      c.relname AS table_name,
                      array_agg(a.attname ORDER BY u.attposition) AS columns,
                      rn.nspname AS ref_schema,
                      rc.relname AS ref_table,
                      array_agg(ra.attname ORDER BY u.attposition) AS ref_columns
                    FROM pg_constraint con
                    JOIN pg_class c ON con.conrelid = c.oid
                    JOIN pg_namespace n ON c.relnamespace = n.oid
                    JOIN pg_class rc ON con.confrelid = rc.oid
                    JOIN pg_namespace rn ON rc.relnamespace = rn.oid
                    JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(conkey, confkey, attposition) ON true
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.conkey
                    JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = u.confkey
                    WHERE con.contype = 'f'
                    GROUP BY con.oid, n.nspname, c.relname, rn.nspname, rc.relname;
                `;

  public static setInstance(instance: SqlCompletionProvider): void {
    SqlCompletionProvider.instance = instance;
  }

  public static getInstance(): SqlCompletionProvider | null {
    return SqlCompletionProvider.instance;
  }

  /** Shared prefix builder for completion + signature help (notebook-aware). */
  public static sqlTextBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    const lines = document.getText().split(/\r?\n/);
    let inCellText: string;
    if (position.line >= lines.length) {
      inCellText = lines.join('\n');
    } else {
      const beforeLines = lines.slice(0, position.line).join('\n');
      const linePrefix = (lines[position.line] || '').slice(0, position.character);
      inCellText = beforeLines ? `${beforeLines}\n${linePrefix}` : linePrefix;
    }

    if (document.uri.scheme !== 'vscode-notebook-cell') {
      return inCellText;
    }

    const notebook = vscode.workspace.notebookDocuments.find(nb =>
      nb.getCells().some(cell => cell.document.uri.toString() === document.uri.toString())
    );
    if (!notebook) {
      return inCellText;
    }

    const cells = notebook.getCells();
    const idx = cells.findIndex(cell => cell.document.uri.toString() === document.uri.toString());
    const priorSql = cells
      .slice(0, idx)
      .filter(cell => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'sql')
      .map(cell => cell.document.getText().trim())
      .filter(Boolean)
      .join(';\n');

    return priorSql ? `${priorSql};\n${inCellText}` : inCellText;
  }

  /** Prior SQL cells + **entire** current cell (for relations/clauses after cursor — e.g. SELECT list with FROM below). */
  public static sqlFullNotebookSqlRaw(document: vscode.TextDocument): string {
    const fullCell = document.getText();
    if (document.uri.scheme !== 'vscode-notebook-cell') {
      return fullCell;
    }

    const notebook = vscode.workspace.notebookDocuments.find(nb =>
      nb.getCells().some(cell => cell.document.uri.toString() === document.uri.toString())
    );
    if (!notebook) {
      return fullCell;
    }

    const cells = notebook.getCells();
    const idx = cells.findIndex(cell => cell.document.uri.toString() === document.uri.toString());
    const priorSql = cells
      .slice(0, idx)
      .filter(cell => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'sql')
      .map(cell => cell.document.getText().trim())
      .filter(Boolean)
      .join(';\n');

    return priorSql ? `${priorSql};\n${fullCell}` : fullCell;
  }

  public invalidate(connectionId: string, database?: string): void {
    if (database) {
      const cacheKey = `${connectionId}-${database}`;
      this._bumpEpoch(cacheKey);
      this.schemaCache.delete(cacheKey);
      return;
    }

    const prefix = `${connectionId}-`;
    for (const key of [...this.schemaCache.keys()]) {
      if (key.startsWith(prefix)) {
        this._bumpEpoch(key);
        this.schemaCache.delete(key);
      }
    }
  }

  public invalidateAll(): void {
    this.catalogEpoch.clear();
    this.fetchLocks.clear();
    this.schemaCache.clear();
  }

  /** Used by signature help and other providers sharing the same notebook connection. */
  public async ensureSchemaForNotebook(document: vscode.TextDocument): Promise<SchemaCache | null> {
    const conn = await this._getNotebookConnection(document);
    if (!conn) {
      return null;
    }
    const cfg = await this._resolveConnectionConfig(conn.connectionId);
    if (!cfg) {
      return null;
    }
    const cacheKey = `${conn.connectionId}-${conn.database}`;
    await this._ensureCache(cacheKey, cfg, conn.database);
    return this.schemaCache.get(cacheKey) ?? null;
  }

  public async warmCache(connectionId: string, database: string): Promise<void> {
    const cacheKey = `${connectionId}-${database}`;
    const cfg = await this._resolveConnectionConfig(connectionId);
    if (!cfg) {
      return;
    }
    const epoch = this.catalogEpoch.get(cacheKey) ?? 0;
    let lock = this.fetchLocks.get(cacheKey);
    if (!lock) {
      lock = this._fetchAndStoreCache(cacheKey, cfg, database, epoch);
      this.fetchLocks.set(cacheKey, lock);
    }
    try {
      await lock;
    } finally {
      if (this.fetchLocks.get(cacheKey) === lock) {
        this.fetchLocks.delete(cacheKey);
      }
    }
  }

  private _bumpEpoch(cacheKey: string): void {
    this.catalogEpoch.set(cacheKey, (this.catalogEpoch.get(cacheKey) ?? 0) + 1);
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    try {
      const conn = await this._getNotebookConnection(document);
      if (!conn) {
        return [];
      }

      const { connectionId, database } = conn;
      const cacheKey = `${connectionId}-${database}`;
      const cfg = await this._resolveConnectionConfig(connectionId);

      if (!cfg) {
        const parsed = this._parseQuery(document, position);
        this._enrichWildcardColumns(parsed, EMPTY_CACHE.columns);
        if (parsed.clause === SqlClause.Where || parsed.clause === SqlClause.Having) {
          parsed.precedingWhereColumnType = this._resolvePrecedingColumnDataType(parsed.cleanText, parsed, EMPTY_CACHE.columns);
        }
        const items = this._buildCompletions(parsed, EMPTY_CACHE, document, position);
        items.push(
          ...this._keywordItems([
            'SELECT',
            'INSERT INTO',
            'UPDATE',
            'DELETE FROM',
            'WITH',
            'CREATE TABLE',
            'EXPLAIN ANALYZE'
          ])
        );
        return items;
      }

      await this._ensureCache(cacheKey, cfg, database);
      const cache = this.schemaCache.get(cacheKey) ?? EMPTY_CACHE;

      const parsed = this._parseQuery(document, position);
      this._enrichWildcardColumns(parsed, cache.columns);
      if (parsed.clause === SqlClause.Where || parsed.clause === SqlClause.Having) {
        parsed.precedingWhereColumnType = this._resolvePrecedingColumnDataType(parsed.cleanText, parsed, cache.columns);
      }
      return this._buildCompletions(parsed, cache, document, position);
    } catch (error) {
      outputChannel?.appendLine(`[SqlCompletionProvider] ${error}`);
      return [];
    }
  }

  // ===========================================================================
  // Cache
  // ===========================================================================

  private async _ensureCache(
    cacheKey: string,
    cfg: { id: string; host: string; port: number; username: string; name: string },
    database: string
  ): Promise<void> {
    const cached = this.schemaCache.get(cacheKey);
    if (cached && Date.now() - cached.updatedAt < this.CACHE_TTL_MS) {
      return;
    }

    let lock = this.fetchLocks.get(cacheKey);
    if (!lock) {
      const epoch = this.catalogEpoch.get(cacheKey) ?? 0;
      lock = this._fetchAndStoreCache(cacheKey, cfg, database, epoch);
      this.fetchLocks.set(cacheKey, lock);
    }

    try {
      await lock;
    } finally {
      if (this.fetchLocks.get(cacheKey) === lock) {
        this.fetchLocks.delete(cacheKey);
      }
    }
  }

  private async _fetchAndStoreCache(
    cacheKey: string,
    cfg: { id: string; host: string; port: number; username: string; name: string },
    database: string,
    epochAtStart: number
  ): Promise<void> {
    let client;
    try {
      client = await ConnectionManager.getInstance().getPooledClient({
        id: cfg.id,
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        database,
        name: cfg.name
      });

      const objectsResult = await client.query(SqlCompletionProvider.CATALOG_OBJECTS_SQL);
      const objects = this._dedupeTables(
        objectsResult.rows.map(
          (row: {
            schema: string;
            object_name: string;
            object_type: string;
            arguments?: string;
            call_arguments?: string;
            is_populated?: boolean | null;
          }) => ({
            schema: row.schema,
            objectName: row.object_name,
            objectType: row.object_type,
            arguments: row.arguments,
            callArguments: row.call_arguments,
            isPopulated: row.is_populated ?? undefined
          })
        )
      );

      const columnsResult = await client.query(SqlCompletionProvider.CATALOG_COLUMNS_SQL);
      const columns = this._dedupeColumns(
        columnsResult.rows.map(
          (row: {
            schema: string;
            table_name: string;
            column_name: string;
            data_type: string;
            udt_schema?: string;
            udt_name?: string;
          }) => ({
            schema: row.schema,
            tableName: row.table_name,
            columnName: row.column_name,
            dataType: row.data_type,
            udtSchema: row.udt_schema,
            udtName: row.udt_name
          })
        )
      );

      const fkResult = await client.query(SqlCompletionProvider.CATALOG_FK_SQL);
      const foreignKeys: ForeignKeyInfo[] = fkResult.rows.map(
        (row: { schema: string; table_name: string; columns: string[]; ref_schema: string; ref_table: string; ref_columns: string[] }) => ({
          schema: row.schema,
          tableName: row.table_name,
          columns: row.columns || [],
          referencedSchema: row.ref_schema,
          referencedTable: row.ref_table,
          referencedColumns: row.ref_columns || []
        })
      );

      const searchPathResult = await client.query('SHOW search_path');
      const searchPath = this._parseSearchPath(searchPathResult.rows[0]?.search_path || '', cfg.username);

      const compositeResult = await client.query(SqlCompletionProvider.CATALOG_COMPOSITE_SQL);
      const compositeAttrs = new Map<string, string[]>();
      for (const row of compositeResult.rows as { schema: string; type_name: string; attrs: string[] }[]) {
        const key = `${row.schema}.${row.type_name}`.toLowerCase();
        compositeAttrs.set(key, row.attrs || []);
      }

      const rolesResult = await client.query(`SELECT rolname FROM pg_roles ORDER BY rolname`);
      const roles = (rolesResult.rows as { rolname: string }[]).map(r => r.rolname);

      if ((this.catalogEpoch.get(cacheKey) ?? 0) !== epochAtStart) {
        return;
      }

      this.schemaCache.set(cacheKey, {
        objects,
        columns,
        foreignKeys,
        searchPath,
        compositeAttrs,
        roles,
        updatedAt: Date.now()
      });
    } catch (error) {
      outputChannel?.appendLine(`[SqlCompletionProvider] catalog fetch failed: ${error}`);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  private _parseSearchPath(raw: string, username: string): string[] {
    return raw
      .split(',')
      .map(segment => segment.trim())
      .map(segment => segment.replace(/^"|"$/g, ''))
      .map(segment => (segment === '$user' ? username : segment))
      .filter(Boolean)
      .map(s => s.toLowerCase());
  }

  // ===========================================================================
  // Single parse pass
  // ===========================================================================

  private _parseQuery(document: vscode.TextDocument, position: vscode.Position): ParsedQuery {
    const textBeforeCursor = this._getTextBeforeCursor(document, position);
    const cleanText = SqlParser.stripCommentsAndStrings(textBeforeCursor);

    const fullRaw = SqlCompletionProvider.sqlFullNotebookSqlRaw(document);
    const fullClean = SqlParser.stripCommentsAndStrings(fullRaw);
    const cursorIdx = Math.min(cleanText.length, fullClean.length);

    const { stmt: activeStmt, cursorInStmt } = this._activeStatementSliceForCursor(fullClean, cursorIdx);

    const tailTrim = cleanText.trimEnd();
    const strictDot = /(\"[^\"]*\"|[a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)?$/i.exec(tailTrim);
    const hasQualifiedPrefix = strictDot !== null;
    const dotQualifier = strictDot ? SqlParser.normalizeIdentifier(strictDot[1]) : null;
    const dotPartial = strictDot && strictDot[2] ? strictDot[2].toLowerCase() : null;

    /** CTEs: full notebook buffer. Relations / derived tables / clause: full active statement (includes FROM after cursor). */
    const { columns: cteColumns, bodies: cteBodies } = this._parseCtes(fullClean);
    const { relations, aliasMap, qualifiedMap, referencedTables } = this._extractAllRelations(activeStmt);
    const { columns: derivedColumns, bodies: derivedBodies } = this._extractDerivedSubqueries(activeStmt);

    const cursorBounded = Math.max(0, Math.min(cursorInStmt, activeStmt.length));
    let clause = this._detectClauseAtCursor(activeStmt, cursorBounded);
    clause = this._refineClause(activeStmt, clause);

    const insertTarget = this._extractInsertTarget(activeStmt, aliasMap, qualifiedMap);
    const updateTarget = this._extractUpdateTarget(activeStmt, aliasMap, qualifiedMap);

    return {
      cleanText,
      clause,
      relations,
      aliasMap,
      qualifiedMap,
      referencedTables,
      cteColumns,
      cteBodies,
      derivedColumns,
      derivedBodies,
      dotQualifier,
      hasQualifiedPrefix,
      dotPartial,
      insertTarget,
      updateTarget,
      precedingWhereColumnType: null
    };
  }

  private _refineClause(stmt: string, clause: SqlClause): SqlClause {
    if (clause === SqlClause.InsertColumns) {
      return clause;
    }
    if (this._detectExplainOptions(stmt)) {
      return SqlClause.ExplainOptions;
    }
    if (this._detectCopyWithOptions(stmt)) {
      return SqlClause.CopyOptions;
    }
    if (this._detectGrantOnContext(stmt)) {
      return SqlClause.GrantOn;
    }
    if (this._detectGrantToContext(stmt)) {
      return SqlClause.GrantTo;
    }
    if (this._detectCreateTableColumn(stmt)) {
      return SqlClause.CreateTableColumn;
    }
    if (this._detectAlterTableOp(stmt)) {
      return SqlClause.AlterTableOp;
    }
    if (this._isInsertTargetOnly(stmt)) {
      return SqlClause.InsertTarget;
    }
    return clause;
  }

  private _isInsertTargetOnly(stmt: string): boolean {
    const openCols = /\binsert\s+into\s+(?:"[^"]+"|[a-z_][a-z0-9_]*(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))*)\s*\(/i.exec(stmt);
    if (openCols) {
      return false;
    }
    let last = -1;
    const re = /\binsert\s+into\s+/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(stmt)) !== null) {
      last = mm.index;
    }
    if (last < 0) {
      return false;
    }
    const tail = stmt.slice(last).replace(/\binsert\s+into\s+/i, '').trimStart();
    if (tail.startsWith('(')) {
      return false;
    }
    if (/^(select|with)\b/i.test(tail)) {
      return false;
    }
    if (/^values\b/i.test(tail)) {
      return false;
    }
    return true;
  }

  private _detectExplainOptions(stmt: string): boolean {
    const m = /\bexplain\s+/i.exec(stmt);
    if (!m) {
      return false;
    }
    let pos = m.index + m[0].length;
    while (pos < stmt.length && /\s/.test(stmt[pos])) {
      pos++;
    }
    if (/^analyze\b/i.test(stmt.slice(pos))) {
      pos += stmt.slice(pos).match(/^analyze\b/i)![0].length;
      while (pos < stmt.length && /\s/.test(stmt[pos])) {
        pos++;
      }
    }
    if (stmt[pos] !== '(') {
      return false;
    }
    let d = 0;
    for (let i = pos; i < stmt.length; i++) {
      const ch = stmt[i];
      if (ch === '(') {
        d++;
      } else if (ch === ')') {
        d--;
        if (d === 0) {
          return false;
        }
      }
    }
    return d > 0;
  }

  private _detectCopyWithOptions(stmt: string): boolean {
    const m = /\bwith\s*\(/i.exec(stmt);
    if (!m || !/\bcopy\b/i.test(stmt)) {
      return false;
    }
    const openIdx = m.index + m[0].length - 1;
    let d = 0;
    for (let i = openIdx; i < stmt.length; i++) {
      const ch = stmt[i];
      if (ch === '(') {
        d++;
      } else if (ch === ')') {
        d--;
        if (d === 0) {
          return false;
        }
      }
    }
    return d > 0;
  }

  private _detectGrantOnContext(stmt: string): boolean {
    const grant = /\bgrant\b/i.exec(stmt);
    if (!grant) {
      return false;
    }
    const tail = stmt.slice(grant.index).trimEnd();
    return /\bon\s+$/i.test(tail);
  }

  private _detectGrantToContext(stmt: string): boolean {
    const grant = /\bgrant\b/i.exec(stmt);
    if (!grant) {
      return false;
    }
    const tail = stmt.slice(grant.index).trimEnd();
    return /\bto\s+$/i.test(tail);
  }

  private _detectCreateTableColumn(stmt: string): boolean {
    const m = /\bcreate\s+table\b/i.exec(stmt);
    if (!m) {
      return false;
    }
    let pos = m.index + m[0].length;
    while (pos < stmt.length && /\s/.test(stmt[pos])) {
      pos++;
    }
    if (/^if\s+not\s+exists\s+/i.test(stmt.slice(pos))) {
      pos += stmt.slice(pos).match(/^if\s+not\s+exists\s+/i)![0].length;
      while (pos < stmt.length && /\s/.test(stmt[pos])) {
        pos++;
      }
    }
    while (pos < stmt.length && stmt[pos] !== '(') {
      pos++;
    }
    if (stmt[pos] !== '(') {
      return false;
    }
    let d = 0;
    for (let i = pos; i < stmt.length; i++) {
      const ch = stmt[i];
      if (ch === '(') {
        d++;
      } else if (ch === ')') {
        d--;
        if (d === 0) {
          return false;
        }
      }
    }
    return d > 0;
  }

  private _detectAlterTableOp(stmt: string): boolean {
    const m = /\balter\s+table\b/i.exec(stmt);
    if (!m) {
      return false;
    }
    const tail = stmt.slice(m.index + m[0].length).trimStart();
    const rest = tail.replace(/^("[^"]+"|[a-z_][a-z0-9_]*(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))*)\s+/i, '').trimStart();
    return rest.length === 0 || !/^(add|drop|rename|alter|enable|disable|attach|detach)\b/i.test(rest);
  }

  private _resolvePrecedingColumnDataType(cleanText: string, parsed: Pick<ParsedQuery, 'aliasMap' | 'relations'>, cols: ColumnInfo[]): string | null {
    const tail = cleanText.trimEnd();
    const dotForm = tail.match(/(?:^|[^\w.])(["\w][\w"]*)\.(["\w][\w"]*)\s*$/);
    if (dotForm) {
      const alias = SqlParser.normalizeIdentifier(dotForm[1]);
      const colName = SqlParser.normalizeIdentifier(dotForm[2]);
      const rel = parsed.aliasMap.get(alias);
      if (rel) {
        const hit = cols.find(
          c =>
            c.tableName.toLowerCase() === rel.objectName.toLowerCase() &&
            (!rel.schema || c.schema.toLowerCase() === rel.schema.toLowerCase()) &&
            c.columnName.toLowerCase() === colName.toLowerCase()
        );
        return hit?.dataType ?? null;
      }
    }
    const bare = tail.match(/(?:^|[^\w.])(["\w][\w"]*)\s*$/);
    if (bare) {
      const name = SqlParser.normalizeIdentifier(bare[1]);
      for (const rel of parsed.relations) {
        const hit = cols.find(
          c =>
            c.tableName.toLowerCase() === rel.objectName.toLowerCase() &&
            (!rel.schema || c.schema.toLowerCase() === rel.schema.toLowerCase()) &&
            c.columnName.toLowerCase() === name.toLowerCase()
        );
        if (hit) {
          return hit.dataType;
        }
      }
    }
    return null;
  }

  private _enrichWildcardColumns(parsed: ParsedQuery, cacheColumns: ColumnInfo[]): void {
    for (const [name, body] of parsed.cteBodies) {
      let cols = parsed.cteColumns.get(name) ?? [];
      cols = this._expandStarMarkers(cols, body, cacheColumns);
      if (cols.length > 0) {
        parsed.cteColumns.set(name, cols);
      }
    }
    for (const [alias, cols] of parsed.derivedColumns) {
      const innerBody = parsed.derivedBodies.get(alias);
      const expanded = innerBody ? this._expandStarMarkers(cols, innerBody, cacheColumns) : cols.filter(c => c !== '*');
      if (expanded.length > 0) {
        parsed.derivedColumns.set(alias, expanded);
      }
    }
  }

  private _expandStarMarkers(markers: string[], body: string, cacheColumns: ColumnInfo[]): string[] {
    if (!markers.some(m => m === '*' || m.endsWith('.*'))) {
      return markers.filter(m => m !== '*');
    }
    const fromIdx = this._findTopLevelFromIndex(body);
    if (fromIdx < 0) {
      return markers.filter(x => x !== '*' && !x.endsWith('.*'));
    }
    const fromRest = body.slice(fromIdx);
    const { relations } = this._extractAllRelations(fromRest);
    const tableCols = (rel: RelationContext) =>
      cacheColumns
        .filter(
          c =>
            c.tableName.toLowerCase() === rel.objectName.toLowerCase() &&
            (!rel.schema || c.schema.toLowerCase() === rel.schema.toLowerCase())
        )
        .map(c => c.columnName);

    const out: string[] = [];
    for (const m of markers) {
      if (m === '*') {
        for (const r of relations) {
          out.push(...tableCols(r));
        }
      } else if (m.endsWith('.*')) {
        const al = m.slice(0, -2).toLowerCase();
        const rel = relations.find(rr => rr.alias.toLowerCase() === al || rr.objectName.toLowerCase() === al);
        if (rel) {
          out.push(...tableCols(rel));
        }
      } else if (m !== '*') {
        out.push(m);
      }
    }
    return [...new Set(out)];
  }

  private _findTopLevelFromIndex(sql: string): number {
    let depth = 0;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0 && /^from\b/i.test(sql.slice(i))) {
        return i;
      }
    }
    return -1;
  }

  private _extractDerivedSubqueries(stmt: string): { columns: Map<string, string[]>; bodies: Map<string, string> } {
    const columns = new Map<string, string[]>();
    const bodies = new Map<string, string>();
    const len = stmt.length;
    let depth = 0;
    let i = 0;
    while (i < len) {
      const c = stmt[i];
      if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0) {
        const slice = stmt.slice(i);
        let kwLen = 0;
        const fromSub = slice.match(/^from\s+(?:lateral\s+)?\(/i);
        const joinSub = slice.match(/^(?:(?:left|right|full\s+outer|inner|cross)\s+)+join\s+(?:lateral\s+)?\(/i);
        if (fromSub) {
          kwLen = fromSub[0].length;
        } else if (joinSub) {
          kwLen = joinSub[0].length;
        }
        if (kwLen > 0) {
          const openParen = i + kwLen - 1;
          let d = 1;
          let j = openParen + 1;
          while (j < len && d > 0) {
            if (stmt[j] === '(') {
              d++;
            } else if (stmt[j] === ')') {
              d--;
            }
            j++;
          }
          const inner = stmt.slice(openParen + 1, j - 1);
          if (/^\s*select\b/i.test(inner)) {
            const after = stmt.slice(j).trimStart();
            const aliasM = after.match(/^(?:as\s+)?("[^"]+"|[a-z_][a-z0-9_]*)/i);
            if (aliasM) {
              const aliasTok = SqlParser.normalizeIdentifier(aliasM[1].replace(/^as\s+/i, ''));
              bodies.set(aliasTok, inner);
              columns.set(aliasTok, this._extractSelectColumnNames(inner));
            }
            i = j;
            continue;
          }
        }
      }
      i++;
    }
    return { columns, bodies };
  }

  /**
   * Statement text used for clause + relation extraction. If the cursor sits immediately after `;`,
   * use the preceding statement (matches pre-rulebook behavior and typical UX).
   */
  private _activeStatementForClause(cleanText: string): string {
    const trimmed = cleanText.trimEnd();
    let depth = 0;
    const semis: number[] = [];
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      } else if (ch === ';' && depth === 0) {
        semis.push(i);
      }
    }
    if (semis.length === 0) {
      return trimmed;
    }
    const lastSemi = semis[semis.length - 1];
    const afterLast = trimmed.slice(lastSemi + 1).trimStart();
    if (afterLast.length > 0) {
      return afterLast;
    }
    const prevSemi = semis.length >= 2 ? semis[semis.length - 2] : -1;
    return trimmed.slice(prevSemi + 1, lastSemi).trim();
  }

  /**
   * Active SQL statement (depth-0 `;` split) that contains `cursorIdx`, and cursor offset inside that slice.
   * Uses length-aligned stripped text (same as prefix strip) so cursor position matches the editor.
   */
  private _activeStatementSliceForCursor(trimmedFull: string, cursorIdx: number): { stmt: string; cursorInStmt: number } {
    const trimmed = trimmedFull.trimEnd();
    const idx = Math.min(Math.max(0, cursorIdx), trimmed.length);
    let depth = 0;
    let stmtStart = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
      } else if (ch === ';' && depth === 0) {
        if (idx <= i) {
          return { stmt: trimmed.slice(stmtStart, i), cursorInStmt: idx - stmtStart };
        }
        stmtStart = i + 1;
      }
    }
    return { stmt: trimmed.slice(stmtStart), cursorInStmt: idx - stmtStart };
  }

  /**
   * Like `_detectClause`, but only keywords at or before `cursorInStmt` apply — fixes SELECT-list completion
   * when `FROM ...` appears after the cursor (user edits the projection list).
   */
  private _detectClauseAtCursor(stmt: string, cursorInStmt: number): SqlClause {
    const clauseRegex =
      /\(|\)|\b(select|from|delete\s+from|where|using|join|left\s+join|right\s+join|inner\s+join|cross\s+join|full\s+outer\s+join|group\s+by|order\s+by|having|on|insert\s+into|update|set|returning)\b/gi;

    const bound = Math.max(0, Math.min(cursorInStmt, stmt.length));
    let depth = 0;
    let clause: SqlClause = SqlClause.Unknown;
    let updateSeen = false;
    let deleteFromSeen = false;

    let match: RegExpExecArray | null;
    clauseRegex.lastIndex = 0;
    while ((match = clauseRegex.exec(stmt)) !== null) {
      if (match.index > bound) {
        break;
      }
      const token = match[0];
      if (token === '(') {
        depth++;
        continue;
      }
      if (token === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth !== 0) {
        continue;
      }

      const low = token.toLowerCase();
      if (low === 'select') {
        clause = SqlClause.Select;
      } else if (low === 'delete from') {
        clause = SqlClause.DeleteFrom;
        deleteFromSeen = true;
      } else if (low === 'using' && deleteFromSeen) {
        clause = SqlClause.DeleteUsing;
      } else if (low === 'from') {
        clause = SqlClause.From;
      } else if (
        low === 'join' ||
        low === 'left join' ||
        low === 'right join' ||
        low === 'inner join' ||
        low === 'cross join' ||
        low === 'full outer join'
      ) {
        clause = SqlClause.Join;
      } else if (low === 'where') {
        clause = SqlClause.Where;
      } else if (low === 'group by') {
        clause = SqlClause.GroupBy;
      } else if (low === 'order by') {
        clause = SqlClause.OrderBy;
      } else if (low === 'having') {
        clause = SqlClause.Having;
      } else if (low === 'on') {
        clause = SqlClause.On;
      } else if (low === 'returning') {
        clause = SqlClause.Returning;
      } else if (low === 'insert into') {
        clause = SqlClause.Unknown;
      } else if (low === 'update') {
        updateSeen = true;
        clause = SqlClause.Unknown;
      } else if (low === 'set' && updateSeen) {
        clause = SqlClause.UpdateSet;
      }
    }

    const insertCol = /\binsert\s+into\s+(?:"[^"]+"|[a-z_][a-z0-9_]*(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))*)\s*\(/i.exec(stmt);
    if (insertCol && insertCol.index !== undefined && insertCol.index < bound) {
      const openIdx = insertCol.index + insertCol[0].length - 1;
      if (stmt[openIdx] === '(' && bound > openIdx) {
        let pd = 0;
        for (let i = openIdx; i < bound; i++) {
          const ch = stmt[i];
          if (ch === '(') {
            pd++;
          } else if (ch === ')') {
            pd--;
          }
        }
        if (pd > 0) {
          return SqlClause.InsertColumns;
        }
      }
    }

    return clause;
  }

  /**
   * Last clause keyword at paren depth 0; INSERT column list overrides via paren depth.
   */
  private _detectClause(stmt: string): SqlClause {
    const clauseRegex =
      /\(|\)|\b(select|from|delete\s+from|where|using|join|left\s+join|right\s+join|inner\s+join|cross\s+join|full\s+outer\s+join|group\s+by|order\s+by|having|on|insert\s+into|update|set|returning)\b/gi;

    let depth = 0;
    let clause: SqlClause = SqlClause.Unknown;
    let updateSeen = false;
    let deleteFromSeen = false;

    let match: RegExpExecArray | null;
    while ((match = clauseRegex.exec(stmt)) !== null) {
      const token = match[0];
      if (token === '(') {
        depth++;
        continue;
      }
      if (token === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth !== 0) {
        continue;
      }

      const low = token.toLowerCase();
      if (low === 'select') {
        clause = SqlClause.Select;
      } else if (low === 'delete from') {
        clause = SqlClause.DeleteFrom;
        deleteFromSeen = true;
      } else if (low === 'using' && deleteFromSeen) {
        clause = SqlClause.DeleteUsing;
      } else if (low === 'from') {
        clause = SqlClause.From;
      } else if (
        low === 'join' ||
        low === 'left join' ||
        low === 'right join' ||
        low === 'inner join' ||
        low === 'cross join' ||
        low === 'full outer join'
      ) {
        clause = SqlClause.Join;
      } else if (low === 'where') {
        clause = SqlClause.Where;
      } else if (low === 'group by') {
        clause = SqlClause.GroupBy;
      } else if (low === 'order by') {
        clause = SqlClause.OrderBy;
      } else if (low === 'having') {
        clause = SqlClause.Having;
      } else if (low === 'on') {
        clause = SqlClause.On;
      } else if (low === 'returning') {
        clause = SqlClause.Returning;
      } else if (low === 'insert into') {
        clause = SqlClause.Unknown;
      } else if (low === 'update') {
        updateSeen = true;
        clause = SqlClause.Unknown;
      } else if (low === 'set' && updateSeen) {
        clause = SqlClause.UpdateSet;
      }
    }

    const insertCol = /\binsert\s+into\s+(?:"[^"]+"|[a-z_][a-z0-9_]*(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))*)\s*\(/i.exec(stmt);
    if (insertCol && insertCol.index !== undefined) {
      const afterParen = stmt.slice(insertCol.index + insertCol[0].length);
      let pd = 1;
      for (const ch of afterParen) {
        if (ch === '(') {
          pd++;
        } else if (ch === ')') {
          pd--;
          if (pd === 0) {
            break;
          }
        }
      }
      if (pd > 0) {
        return SqlClause.InsertColumns;
      }
    }

    return clause;
  }

  private _extractAllRelations(cleanText: string): {
    relations: RelationContext[];
    aliasMap: Map<string, RelationContext>;
    qualifiedMap: Map<string, RelationContext>;
    referencedTables: Set<string>;
  } {
    const relations: RelationContext[] = [];
    const aliasMap = new Map<string, RelationContext>();
    const qualifiedMap = new Map<string, RelationContext>();
    const referencedTables = new Set<string>();

    const identifier = '(?:"[^"]+"|[a-z_][a-z0-9_]*)';
    const relationRegex = new RegExp(
      `${SqlCompletionProvider.RELATION_LEAD_IN}(${identifier}(?:\\s*\\.\\s*${identifier}){0,2})(?:\\s+(?:as\\s+)?(${identifier}))?`,
      'gi'
    );

    let m: RegExpExecArray | null;
    while ((m = relationRegex.exec(cleanText)) !== null) {
      let aliasTok = m[2] || null;
      if (aliasTok && SQL_RESERVED_ALIAS.has(aliasTok.toLowerCase())) {
        aliasTok = null;
      }
      const rawName = m[1].trim();
      if (rawName.startsWith('(')) {
        continue;
      }
      const parsed = this._parseQualifiedIdentifier(rawName);
      const schema = parsed.schema;
      const objectName = parsed.name;
      if (!objectName || objectName === '(') {
        continue;
      }

      const aliasNorm = aliasTok ? SqlParser.normalizeIdentifier(aliasTok) : objectName;
      const rel: RelationContext = { schema, objectName, alias: aliasNorm };

      relations.push(rel);
      referencedTables.add(objectName);

      aliasMap.set(aliasNorm, rel);
      if (aliasNorm !== objectName) {
        aliasMap.set(objectName, rel);
      }

      const qKey = `${schema ?? ''}.${objectName}`;
      qualifiedMap.set(qKey, rel);
      qualifiedMap.set(objectName, rel);
    }

    return { relations, aliasMap, qualifiedMap, referencedTables };
  }

  private _parseQualifiedIdentifier(input: string): { schema: string | null; name: string } {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
        current += ch;
        continue;
      }
      if (ch === '.' && !inQuotes) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    if (parts.length === 0) {
      return { schema: null, name: '' };
    }
    if (parts.length === 1) {
      return { schema: null, name: SqlParser.normalizeIdentifier(parts[0]) };
    }
    const schema = SqlParser.normalizeIdentifier(parts[parts.length - 2]);
    const name = SqlParser.normalizeIdentifier(parts[parts.length - 1]);
    return { schema, name };
  }

  private _parseCtes(activeStmt: string): { columns: Map<string, string[]>; bodies: Map<string, string> } {
    const columns = new Map<string, string[]>();
    const bodies = new Map<string, string>();
    const s = activeStmt.trimStart();
    if (!/^with\s+/i.test(s)) {
      return { columns, bodies };
    }
    let pos = s.match(/^with\s+/i)![0].length;
    if (/^recursive\s+/i.test(s.slice(pos))) {
      pos += s.slice(pos).match(/^recursive\s+/i)![0].length;
    }
    while (pos < s.length) {
      while (pos < s.length && /\s/.test(s[pos])) {
        pos++;
      }
      if (pos >= s.length) {
        break;
      }
      if (s[pos] === ',') {
        pos++;
        continue;
      }
      const nameM = s.slice(pos).match(/^("[^"]+"|[a-z_][a-z0-9_]*)\s+as\s*\(/i);
      if (!nameM) {
        break;
      }
      const cteName = SqlParser.normalizeIdentifier(nameM[1]);
      pos += nameM[0].length;
      const bodyStart = pos;
      let depth = 1;
      while (pos < s.length && depth > 0) {
        const ch = s[pos];
        if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          depth--;
        }
        pos++;
      }
      const body = s.slice(bodyStart, pos - 1);
      bodies.set(cteName, body);
      columns.set(cteName, this._extractSelectColumnNames(body));
      while (pos < s.length && /\s/.test(s[pos])) {
        pos++;
      }
      if (pos < s.length && s[pos] === ',') {
        pos++;
        continue;
      }
      break;
    }
    return { columns, bodies };
  }

  private _extractSelectColumnNames(selectBody: string): string[] {
    const fromIdx = this._findTopLevelFromIndex(selectBody);
    const selectList = fromIdx >= 0 ? selectBody.slice(0, fromIdx) : selectBody;
    const cols: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= selectList.length; i++) {
      const ch = selectList[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      } else if ((ch === ',' || i === selectList.length) && depth === 0) {
        const part = selectList.slice(start, i).trim();
        if (/^\s*\*\s*$/.test(part)) {
          cols.push('*');
        } else {
          const qualStar = /^\s*("[^"]+"|[a-z_][a-z0-9_]*)\s*\.\s*\*\s*$/i.exec(part);
          if (qualStar) {
            cols.push(`${SqlParser.normalizeIdentifier(qualStar[1])}.*`);
          } else {
            const aliasMatch =
              part.match(/\bas\s+("[^"]+"|[a-z_][a-z0-9_]*)$/i) ||
              part.match(/("[^"]+"|[a-z_][a-z0-9_]*)$/i);
            if (aliasMatch) {
              cols.push(SqlParser.normalizeIdentifier(aliasMatch[1]));
            }
          }
        }
        start = i + 1;
      }
    }
    return cols;
  }

  private _extractInsertTarget(
    cleanText: string,
    aliasMap: Map<string, RelationContext>,
    qualifiedMap: Map<string, RelationContext>
  ): RelationContext | null {
    const m = cleanText.match(
      /\binsert\s+into\s+(?:"[^"]+"|[a-z_][a-z0-9_]*(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))*)/i
    );
    if (!m) {
      return null;
    }
    return this._resolveRelationFromText(m[0].replace(/^insert\s+into\s+/i, '').trim(), aliasMap, qualifiedMap);
  }

  private _extractUpdateTarget(
    cleanText: string,
    aliasMap: Map<string, RelationContext>,
    qualifiedMap: Map<string, RelationContext>
  ): RelationContext | null {
    const m = cleanText.match(/\bupdate\s+(?:"[^"]+"|[a-z_][a-z0-9_]*(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))*)/i);
    if (!m) {
      return null;
    }
    return this._resolveRelationFromText(m[0].replace(/^update\s+/i, '').trim(), aliasMap, qualifiedMap);
  }

  private _resolveRelationFromText(
    name: string,
    aliasMap: Map<string, RelationContext>,
    qualifiedMap: Map<string, RelationContext>
  ): RelationContext {
    const parsed = this._parseQualifiedIdentifier(name);
    const { schema, name: objName } = parsed;
    const hit =
      qualifiedMap.get(`${schema ?? ''}.${objName}`) ||
      qualifiedMap.get(objName) ||
      aliasMap.get(objName);
    if (hit) {
      return hit;
    }
    return { schema, objectName: objName, alias: objName };
  }

  // ===========================================================================
  // Completion builder (rule cascade)
  // ===========================================================================

  private _typedPrefix(document: vscode.TextDocument, position: vscode.Position): string {
    const wordRange = document.getWordRangeAtPosition(position);
    return wordRange ? document.getText(wordRange).toLowerCase() : '';
  }

  private _buildCompletions(
    parsed: ParsedQuery,
    cache: SchemaCache,
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const typedPrefix = this._typedPrefix(document, position);
    const items: vscode.CompletionItem[] = [];

    if (parsed.hasQualifiedPrefix && parsed.dotQualifier) {
      return this._qualifiedPrefixCompletions(parsed, cache);
    }

    if (parsed.clause === SqlClause.InsertTarget) {
      return this._relationObjectItems(cache.objects, cache.searchPath);
    }

    if (parsed.clause === SqlClause.InsertColumns && parsed.insertTarget) {
      return this._columnItemsOrdinal(cache.columns, parsed.insertTarget, true, typedPrefix);
    }

    if (parsed.clause === SqlClause.UpdateSet && parsed.updateTarget) {
      items.push(...this._columnItemsOrdinal(cache.columns, parsed.updateTarget, true, typedPrefix));
      items.push(...this._scalarFunctionItems());
      return items;
    }

    if (parsed.clause === SqlClause.On) {
      return this._onClauseCompletions(parsed, cache, typedPrefix);
    }

    if (parsed.clause === SqlClause.DeleteFrom) {
      items.push(...this._relationObjectItems(cache.objects, cache.searchPath));
      items.push(
        ...this._keywordItems(['USING', 'WHERE', 'RETURNING', 'ORDER BY', 'LIMIT', 'OFFSET'])
      );
      return items;
    }

    if (parsed.clause === SqlClause.DeleteUsing) {
      items.push(...this._relationObjectItems(cache.objects, cache.searchPath));
      items.push(...this._keywordItems(['WHERE', 'RETURNING']));
      return items;
    }

    if (parsed.clause === SqlClause.ExplainOptions) {
      return EXPLAIN_OPTION_KEYWORDS.map(op => {
        const item = new vscode.CompletionItem(op.label, vscode.CompletionItemKind.EnumMember);
        item.detail = op.detail;
        item.insertText = new vscode.SnippetString(op.snippet);
        item.sortText = `0-${op.label}`;
        return item;
      });
    }

    if (parsed.clause === SqlClause.CopyOptions) {
      return COPY_WITH_OPTIONS.map(op => {
        const item = new vscode.CompletionItem(op.label, vscode.CompletionItemKind.EnumMember);
        item.detail = op.detail;
        item.insertText = new vscode.SnippetString(op.snippet);
        item.sortText = `0-${op.label}`;
        return item;
      });
    }

    if (parsed.clause === SqlClause.CreateTableColumn) {
      return CREATE_TABLE_SNIPPETS.map(t => {
        const item = new vscode.CompletionItem(t.label, vscode.CompletionItemKind.Snippet);
        item.detail = t.detail;
        item.insertText = new vscode.SnippetString(t.snippet);
        item.sortText = `0-${t.label}`;
        return item;
      });
    }

    if (parsed.clause === SqlClause.AlterTableOp) {
      return this._keywordItems(ALTER_TABLE_KEYWORDS);
    }

    if (parsed.clause === SqlClause.GrantOn) {
      items.push(...this._relationObjectItems(cache.objects, cache.searchPath));
      items.push(...this._keywordItems(['SCHEMA', 'ALL TABLES IN SCHEMA', 'ALL SEQUENCES IN SCHEMA', 'DATABASE']));
      return items;
    }

    if (parsed.clause === SqlClause.GrantTo) {
      return cache.roles.map(r => {
        const item = new vscode.CompletionItem(r, vscode.CompletionItemKind.Unit);
        item.detail = 'Role';
        item.insertText = sqlFormatIdentifier(r);
        item.filterText = r;
        return item;
      });
    }

    if (parsed.clause === SqlClause.From || parsed.clause === SqlClause.Join) {
      items.push(...this._relationObjectItems(cache.objects, cache.searchPath));
      items.push(
        ...this._keywordItems([
          'JOIN',
          'LEFT JOIN',
          'RIGHT JOIN',
          'INNER JOIN',
          'FULL OUTER JOIN',
          'CROSS JOIN',
          'LATERAL',
          'WHERE',
          'GROUP BY',
          'ORDER BY',
          'LIMIT'
        ])
      );
      return items;
    }

    if (parsed.clause === SqlClause.Select) {
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0', typedPrefix));
      items.push(...this._derivedColumnItems(parsed, typedPrefix));
      items.push(...this._cteColumnItems(parsed, typedPrefix));
      items.push(...this._aggregateFunctionItems());
      items.push(...this._windowFunctionItems());
      items.push(...this._scalarFunctionItems());
      items.push(
        ...this._keywordItems([
          'DISTINCT',
          'FROM',
          'WHERE',
          'AS',
          'CASE',
          'WHEN',
          'THEN',
          'ELSE',
          'END',
          'OVER',
          'PARTITION BY',
          'COALESCE',
          'NULLIF',
          'CAST',
          'EXISTS'
        ])
      );
      this._markPreselectForPrefix(items, typedPrefix);
      return items;
    }

    if (parsed.clause === SqlClause.Where || parsed.clause === SqlClause.Having) {
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0', typedPrefix));
      items.push(...this._derivedColumnItems(parsed, typedPrefix));
      items.push(...this._cteColumnItems(parsed, typedPrefix));
      items.push(...this._scalarFunctionItems());
      items.push(...this._filteredWhereOperators(parsed.precedingWhereColumnType));
      if (parsed.precedingWhereColumnType && PG_TYPE_GROUPS.json.test(parsed.precedingWhereColumnType)) {
        items.push(
          ...[
            { label: '->', snippet: '->${1:key}', detail: 'JSON path' },
            { label: '->>', snippet: "->>'${1:key}'", detail: 'JSON path text' },
            { label: '#>', snippet: "#>'{${1:path}}'", detail: 'JSON path array' },
            { label: '#>>', snippet: "#>>'{${1:path}}'", detail: 'JSON path text' }
          ].map(op => {
            const item = new vscode.CompletionItem(op.label, vscode.CompletionItemKind.Operator);
            item.detail = op.detail;
            item.insertText = new vscode.SnippetString(op.snippet);
            item.sortText = `5-json-${op.label}`;
            return item;
          })
        );
      }
      items.push(
        ...this._keywordItems([
          'AND',
          'OR',
          'NOT',
          'EXISTS',
          'IN',
          'NOT IN',
          'BETWEEN',
          'IS NULL',
          'IS NOT NULL',
          'ANY',
          'ALL',
          'LIKE',
          'ILIKE',
          'CASE',
          'WHEN'
        ])
      );
      this._markPreselectForPrefix(items, typedPrefix);
      return items;
    }

    if (parsed.clause === SqlClause.GroupBy || parsed.clause === SqlClause.OrderBy) {
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0', typedPrefix));
      items.push(...this._derivedColumnItems(parsed, typedPrefix));
      items.push(...this._scalarFunctionItems());
      items.push(
        ...GROUP_ORDER_SNIPPETS.map(s => {
          const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Snippet);
          item.detail = s.detail;
          item.insertText = new vscode.SnippetString(s.snippet);
          item.sortText = `8-${s.label}`;
          return item;
        })
      );
      if (parsed.clause === SqlClause.OrderBy) {
        items.push(...this._keywordItems(['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']));
      }
      return items;
    }

    if (parsed.clause === SqlClause.Returning) {
      const target = parsed.updateTarget || parsed.insertTarget;
      if (target) {
        items.push(...this._columnItemsOrdinal(cache.columns, target, false, typedPrefix));
      }
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0', typedPrefix));
      return items;
    }

    items.push(...this._objectItemsAll(cache.objects, cache.searchPath));
    items.push(...this._contextualColumnItems(parsed, cache.columns, '0', typedPrefix));
    items.push(
      ...this._keywordItems([
        'SELECT',
        'INSERT INTO',
        'UPDATE',
        'DELETE FROM',
        'CREATE TABLE',
        'ALTER TABLE',
        'DROP TABLE',
        'WITH',
        'EXPLAIN',
        'EXPLAIN ANALYZE',
        'VACUUM',
        'ANALYZE'
      ])
    );
    return items;
  }

  private _markPreselectForPrefix(items: vscode.CompletionItem[], typedPrefix: string): void {
    if (!typedPrefix) {
      return;
    }
    const hit = items.find(
      i =>
        typeof i.label === 'string' &&
        i.label.toLowerCase().startsWith(typedPrefix) &&
        i.kind === vscode.CompletionItemKind.Field
    );
    if (hit) {
      hit.preselect = true;
    }
  }

  private _derivedColumnItems(parsed: ParsedQuery, typedPrefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const [alias, cols] of parsed.derivedColumns) {
      const safeAlias = sqlFormatIdentifier(alias);
      cols.forEach((col, idx) => {
        const safeCol = sqlFormatIdentifier(col);
        const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
        item.detail = `Derived (${alias})`;
        const prefixMatch = typedPrefix && col.toLowerCase().startsWith(typedPrefix);
        item.sortText = `${prefixMatch ? '0a' : '0b'}-dv-${alias}-${String(idx).padStart(4, '0')}`;
        item.insertText = `${safeAlias}.${safeCol}`;
        item.filterText = `${col} ${alias}.${col}`;
        items.push(item);
      });
    }
    return items;
  }

  private _filteredWhereOperators(dataType: string | null): vscode.CompletionItem[] {
    if (!dataType) {
      return this._whereOperatorItems();
    }
    const dt = dataType.toLowerCase();
    const excludedForBool = new Set(['LIKE', 'ILIKE', 'NOT LIKE', '~', '~*', 'BETWEEN']);
    const excludedForNumeric = new Set(['LIKE', 'ILIKE', 'NOT LIKE', '~', '~*']);
    let ops = WHERE_OPERATORS;
    if (PG_TYPE_GROUPS.boolean.test(dt)) {
      ops = WHERE_OPERATORS.filter(o => !excludedForBool.has(o.label));
    } else if (PG_TYPE_GROUPS.numeric.test(dt) || PG_TYPE_GROUPS.dateTime.test(dt)) {
      ops = WHERE_OPERATORS.filter(o => !excludedForNumeric.has(o.label));
    } else if (PG_TYPE_GROUPS.json.test(dt)) {
      ops = WHERE_OPERATORS.filter(o => !['LIKE', 'ILIKE', 'NOT LIKE', '~', '~*'].includes(o.label));
    }
    return ops.map(op => {
      const item = new vscode.CompletionItem(op.label, vscode.CompletionItemKind.Operator);
      item.detail = op.detail;
      item.insertText = new vscode.SnippetString(op.snippet);
      item.sortText = `5-${op.label}`;
      return item;
    });
  }

  private _qualifiedPrefixCompletions(parsed: ParsedQuery, cache: SchemaCache): vscode.CompletionItem[] {
    const q = parsed.dotQualifier!;
    const partial = parsed.dotPartial;

    const cteCols = parsed.cteColumns.get(q);
    if (cteCols && cteCols.length > 0) {
      return cteCols
        .filter(col => !partial || col.toLowerCase().startsWith(partial))
        .map(col => {
          const safe = sqlFormatIdentifier(col);
          const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
          item.detail = `CTE column (${q})`;
          item.sortText = `0-${col}`;
          item.insertText = safe;
          item.filterText = col;
          return item;
        });
    }

    const derivedCols = parsed.derivedColumns.get(q);
    if (derivedCols && derivedCols.length > 0) {
      return derivedCols
        .filter(col => !partial || col.toLowerCase().startsWith(partial))
        .map(col => {
          const safe = sqlFormatIdentifier(col);
          const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
          item.detail = `Derived (${q})`;
          item.sortText = `0-${col}`;
          item.insertText = safe;
          item.filterText = col;
          return item;
        });
    }

    const qLower = q.toLowerCase();
    const qIsCatalogSchema = cache.objects.some(o => o.schema.toLowerCase() === qLower);
    const searchPathSet = new Set(cache.searchPath.map(s => s.toLowerCase()));

    const rel = parsed.aliasMap.get(q);
    if (rel) {
      const bareSelfAlias = rel.alias === rel.objectName && rel.schema === null;
      if (bareSelfAlias && qIsCatalogSchema) {
        const tableNamedQOnPath = cache.objects.some(
          o =>
            o.objectName.toLowerCase() === qLower &&
            RELATION_OBJECT_TYPES.has(o.objectType) &&
            searchPathSet.has(o.schema.toLowerCase())
        );
        if (!tableNamedQOnPath) {
          return this._objectItemsInSchema(
            cache.objects.filter(o => o.schema.toLowerCase() === qLower),
            true
          );
        }
      }
      return this._columnItemsForRelationBare(cache.columns, rel, partial);
    }

    const compositeFields = this._compositeAttrsForColumnNamedQualifier(q, parsed, cache, partial);
    if (compositeFields.length > 0) {
      return compositeFields;
    }

    const schemaHits = cache.objects.filter(o => o.schema.toLowerCase() === qLower);
    if (schemaHits.length > 0) {
      return this._objectItemsInSchema(schemaHits, true);
    }

    return [];
  }

  /** When `q` names a column on a referenced table and its udt is composite, suggest attributes. */
  private _compositeAttrsForColumnNamedQualifier(
    q: string,
    parsed: ParsedQuery,
    cache: SchemaCache,
    partial: string | null
  ): vscode.CompletionItem[] {
    const qn = q.toLowerCase();
    for (const rel of parsed.relations) {
      const match = cache.columns.find(
        c =>
          c.tableName.toLowerCase() === rel.objectName.toLowerCase() &&
          (!rel.schema || c.schema.toLowerCase() === rel.schema.toLowerCase()) &&
          c.columnName.toLowerCase() === qn
      );
      if (!match?.udtSchema || !match.udtName) {
        continue;
      }
      const key = `${match.udtSchema}.${match.udtName}`.toLowerCase();
      const attrs = cache.compositeAttrs.get(key);
      if (!attrs?.length) {
        continue;
      }
      return attrs
        .filter(a => !partial || a.toLowerCase().startsWith(partial))
        .map((a, idx) => {
          const item = new vscode.CompletionItem(a, vscode.CompletionItemKind.Field);
          item.detail = `Composite ${match.udtName}`;
          item.sortText = `0c-${String(idx).padStart(4, '0')}`;
          item.insertText = sqlFormatIdentifier(a);
          item.filterText = a;
          return item;
        });
    }
    return [];
  }

  private _columnItemsForRelationBare(columns: ColumnInfo[], rel: RelationContext, dotPartial: string | null): vscode.CompletionItem[] {
    const cols = columns.filter(
      c =>
        c.tableName.toLowerCase() === rel.objectName &&
        (!rel.schema || c.schema.toLowerCase() === rel.schema) &&
        (!dotPartial || c.columnName.toLowerCase().startsWith(dotPartial))
    );
    return cols.map((col, idx) => {
      const safeName = sqlFormatIdentifier(col.columnName);
      const item = new vscode.CompletionItem(col.columnName, vscode.CompletionItemKind.Field);
      item.detail = `${col.dataType} · ${col.schema}.${col.tableName}`;
      const prefixMatch = dotPartial && col.columnName.toLowerCase().startsWith(dotPartial);
      item.sortText = `${prefixMatch ? '0a' : '0b'}-${String(idx).padStart(4, '0')}`;
      item.insertText = safeName;
      item.filterText = col.columnName;
      return item;
    });
  }

  private _columnItemsOrdinal(
    columns: ColumnInfo[],
    rel: RelationContext,
    bare: boolean,
    typedPrefix: string
  ): vscode.CompletionItem[] {
    const cols = columns.filter(
      c =>
        c.tableName.toLowerCase() === rel.objectName &&
        (!rel.schema || c.schema.toLowerCase() === rel.schema)
    );
    return cols.map((col, idx) => {
      const safeCol = sqlFormatIdentifier(col.columnName);
      const safeAlias = sqlFormatIdentifier(rel.alias);
      const item = new vscode.CompletionItem(col.columnName, vscode.CompletionItemKind.Field);
      item.detail = `${col.dataType} · ${col.schema}.${col.tableName}`;
      const prefixMatch = typedPrefix && col.columnName.toLowerCase().startsWith(typedPrefix);
      item.sortText = `${prefixMatch ? '0a' : '0b'}-${String(idx).padStart(4, '0')}`;
      item.insertText = bare ? safeCol : `${safeAlias}.${safeCol}`;
      item.filterText = `${col.columnName} ${rel.alias}.${col.columnName}`;
      return item;
    });
  }

  private _contextualColumnItems(
    parsed: ParsedQuery,
    allColumns: ColumnInfo[],
    sortPrefix: string,
    typedPrefix: string
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    parsed.relations.forEach((rel, relIdx) => {
      const cols = allColumns.filter(
        c =>
          c.tableName.toLowerCase() === rel.objectName &&
          (!rel.schema || c.schema.toLowerCase() === rel.schema)
      );

      cols.forEach((col, colIdx) => {
        const key = `${rel.objectName}.${col.columnName}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);

        const safeCol = sqlFormatIdentifier(col.columnName);
        const safeAlias = sqlFormatIdentifier(rel.alias);
        const item = new vscode.CompletionItem(col.columnName, vscode.CompletionItemKind.Field);
        item.detail = `${col.dataType} · ${rel.alias} (${rel.objectName})`;
        const prefixMatch = typedPrefix && col.columnName.toLowerCase().startsWith(typedPrefix);
        item.sortText = `${sortPrefix}-${prefixMatch ? 'a' : 'b'}-${String(relIdx).padStart(2, '0')}-${String(colIdx).padStart(4, '0')}`;
        item.insertText = `${safeAlias}.${safeCol}`;
        item.filterText = `${col.columnName} ${rel.alias}.${col.columnName}`;
        items.push(item);
      });
    });

    return items;
  }

  private _cteColumnItems(parsed: ParsedQuery, typedPrefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const [, cols] of parsed.cteColumns) {
      cols.forEach((col, idx) => {
        const safe = sqlFormatIdentifier(col);
        const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
        item.detail = 'CTE column';
        const prefixMatch = typedPrefix && col.toLowerCase().startsWith(typedPrefix);
        item.sortText = `1-cte-${prefixMatch ? 'a' : 'b'}-${String(idx).padStart(4, '0')}`;
        item.insertText = safe;
        item.filterText = col;
        items.push(item);
      });
    }
    return items;
  }

  private _onClauseCompletions(parsed: ParsedQuery, cache: SchemaCache, typedPrefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    if (parsed.relations.length < 2) {
      items.push(...this._derivedColumnItems(parsed, typedPrefix));
      items.push(...this._contextualColumnItems(parsed, cache.columns, '2', typedPrefix));
      return items;
    }

    const right = parsed.relations[parsed.relations.length - 1];
    const priors = parsed.relations.slice(0, -1);

    const fkSeen = new Set<string>();
    const fkItems: vscode.CompletionItem[] = [];
    for (const left of priors) {
      for (const fk of this._fkJoinSuggestions(left, right, cache.foreignKeys)) {
        if (!fkSeen.has(fk.label as string)) {
          fkSeen.add(fk.label as string);
          fkItems.push(fk);
        }
      }
    }
    items.push(...fkItems);

    if (fkItems.length === 0) {
      for (const left of priors) {
        items.push(...this._nameMatchJoinSuggestions(left, right, cache.columns));
      }
    }

    items.push(...this._derivedColumnItems(parsed, typedPrefix));
    items.push(...this._contextualColumnItems(parsed, cache.columns, '2', typedPrefix));
    return items;
  }

  private _fkJoinSuggestions(left: RelationContext, right: RelationContext, fks: ForeignKeyInfo[]): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    const schemaOk = (tblSchema: string | null, fkSch: string) =>
      !tblSchema || fkSch.toLowerCase() === tblSchema.toLowerCase();

    for (const fk of fks) {
      const fkTable = fk.tableName.toLowerCase();
      const fkRef = fk.referencedTable.toLowerCase();

      let fkRel: RelationContext | undefined;
      let pkRel: RelationContext | undefined;

      if (
        fkTable === right.objectName &&
        fkRef === left.objectName &&
        schemaOk(right.schema, fk.schema) &&
        schemaOk(left.schema, fk.referencedSchema)
      ) {
        fkRel = right;
        pkRel = left;
      } else if (
        fkTable === left.objectName &&
        fkRef === right.objectName &&
        schemaOk(left.schema, fk.schema) &&
        schemaOk(right.schema, fk.referencedSchema)
      ) {
        fkRel = left;
        pkRel = right;
      }

      if (!fkRel || !pkRel) {
        continue;
      }

      const conditions = fk.columns
        .map((col, i) => `${pkRel!.alias}.${fk.referencedColumns[i]} = ${fkRel!.alias}.${col}`)
        .join(' AND ');

      const item = new vscode.CompletionItem(conditions, vscode.CompletionItemKind.Value);
      item.detail = `Foreign key: ${fk.schema}.${fk.tableName} → ${fk.referencedSchema}.${fk.referencedTable}`;
      item.insertText = new vscode.SnippetString(conditions);
      item.sortText = `0-fk-${fk.tableName}-${fk.columns.join('-')}`;
      items.push(item);
    }

    return items;
  }

  private _nameMatchJoinSuggestions(left: RelationContext, right: RelationContext, allColumns: ColumnInfo[]): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const leftCols = allColumns.filter(
      c => c.tableName.toLowerCase() === left.objectName && (!left.schema || c.schema.toLowerCase() === left.schema)
    );
    const rightCols = allColumns.filter(
      c => c.tableName.toLowerCase() === right.objectName && (!right.schema || c.schema.toLowerCase() === right.schema)
    );
    const rightByName = new Map(rightCols.map(c => [c.columnName.toLowerCase(), c] as const));

    for (const lc of leftCols) {
      const ln = lc.columnName.toLowerCase();
      const match =
        rightByName.get(ln) ||
        (ln === `id` ? undefined : rightByName.get(`${right.objectName}_id`)) ||
        (ln.endsWith('_id') ? rightByName.get(ln.replace(/_id$/, '')) : undefined) ||
        (ln.endsWith('_id') ? rightByName.get('id') : undefined);

      if (!match) {
        continue;
      }
      const snippet = `${left.alias}.${lc.columnName} = ${right.alias}.${match.columnName}`;
      const item = new vscode.CompletionItem(snippet, vscode.CompletionItemKind.Value);
      item.detail = 'Suggested join condition';
      item.sortText = `1-match-${lc.columnName}`;
      item.insertText = new vscode.SnippetString(snippet);
      items.push(item);
    }
    return items;
  }

  /** FROM / JOIN: tables, views, matviews, functions, procedures (PostgreSQL allows routines in FROM). */
  private _relationObjectItems(objects: TableInfo[], searchPath: string[]): vscode.CompletionItem[] {
    const sp = new Set(searchPath.map(s => s.toLowerCase()));
    return objects.map(obj => this._makeObjectItem(obj, sp, false));
  }

  private _objectItemsAll(objects: TableInfo[], searchPath: string[]): vscode.CompletionItem[] {
    const sp = new Set(searchPath.map(s => s.toLowerCase()));
    return objects.map(obj => this._makeObjectItem(obj, sp, false));
  }

  private _objectItemsInSchema(objects: TableInfo[], schemaAlreadyInEditor: boolean): vscode.CompletionItem[] {
    return objects.map(obj => {
      const item = new vscode.CompletionItem(obj.objectName, kindForObject(obj.objectType));
      const tl = titleCaseType(obj.objectType);
      item.detail = `${tl} · ${obj.schema}`;
      if (obj.objectType === 'materialized view' && obj.isPopulated === false) {
        item.detail += ' · not populated';
      }
      if (obj.arguments) {
        item.detail += ` · (${obj.arguments})`;
      }
      item.documentation = new vscode.MarkdownString(`**${tl}:** \`${obj.schema}.${obj.objectName}\``);
      if (obj.arguments) {
        item.documentation.appendMarkdown(`\n\n**Signature:** \`${obj.objectName}(${obj.arguments})\``);
      }
      item.sortText = `0-${obj.objectName}`;
      if (obj.objectType === 'function' || obj.objectType === 'procedure') {
        item.insertText = this._functionSnippet(obj);
      } else {
        const safeObj = sqlFormatIdentifier(obj.objectName);
        const safeSch = sqlFormatIdentifier(obj.schema);
        item.insertText = schemaAlreadyInEditor ? safeObj : `${safeSch}.${safeObj}`;
      }
      item.filterText = `${obj.schema}.${obj.objectName} ${obj.objectName} ${obj.objectType}`;
      return item;
    });
  }

  private _makeObjectItem(obj: TableInfo, searchPath: Set<string>, schemaQualifiedPrefix: boolean): vscode.CompletionItem {
    const inPath = searchPath.has(obj.schema.toLowerCase());
    const item = new vscode.CompletionItem(obj.objectName, kindForObject(obj.objectType));
    const tl = titleCaseType(obj.objectType);
    item.detail = `${tl} · ${obj.schema}`;
    if (obj.objectType === 'materialized view' && obj.isPopulated === false) {
      item.detail += ' · not populated';
    }
    if (obj.arguments) {
      item.detail += ` · (${obj.arguments})`;
    }
    item.documentation = new vscode.MarkdownString(`**${tl}:** \`${obj.schema}.${obj.objectName}\``);
    if (obj.arguments) {
      item.documentation.appendMarkdown(`\n\n**Signature:** \`${obj.objectName}(${obj.arguments})\``);
    }

    item.sortText = inPath ? `0-${obj.objectName}` : `1-${obj.schema}-${obj.objectName}`;

    if (obj.objectType === 'function' || obj.objectType === 'procedure') {
      item.insertText = this._functionSnippet(obj);
    } else if (schemaQualifiedPrefix || inPath) {
      item.insertText = sqlFormatIdentifier(obj.objectName);
    } else {
      item.insertText = `${sqlFormatIdentifier(obj.schema)}.${sqlFormatIdentifier(obj.objectName)}`;
    }

    item.filterText = `${obj.schema}.${obj.objectName} ${obj.objectName} ${obj.objectType}`;
    return item;
  }

  private _functionSnippet(obj: TableInfo): vscode.SnippetString {
    const names = this._extractArgumentNames(obj.callArguments || '');
    const fn = sqlFormatIdentifier(obj.objectName);
    return new vscode.SnippetString(
      names.length > 0 ? `${fn}(${names.map((a, i) => `\${${i + 1}:${a}}`).join(', ')})` : `${fn}()`
    );
  }

  private _keywordItems(keywords: string[]): vscode.CompletionItem[] {
    return keywords.map(kw => {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.sortText = `9-${kw}`;
      return item;
    });
  }

  private _aggregateFunctionItems(): vscode.CompletionItem[] {
    return AGGREGATE_FUNCTIONS.map(fn => {
      const item = new vscode.CompletionItem(fn.label, vscode.CompletionItemKind.Function);
      item.detail = fn.detail;
      item.insertText = new vscode.SnippetString(fn.snippet);
      item.sortText = `2-agg-${fn.label}`;
      return item;
    });
  }

  private _windowFunctionItems(): vscode.CompletionItem[] {
    return WINDOW_FUNCTIONS.map(fn => {
      const item = new vscode.CompletionItem(fn.label, vscode.CompletionItemKind.Function);
      item.detail = fn.detail;
      item.insertText = new vscode.SnippetString(fn.snippet);
      item.sortText = `3-win-${fn.label}`;
      return item;
    });
  }

  private _scalarFunctionItems(): vscode.CompletionItem[] {
    return SCALAR_FUNCTIONS.map(fn => {
      const item = new vscode.CompletionItem(fn.label, vscode.CompletionItemKind.Function);
      item.detail = fn.detail;
      item.insertText = new vscode.SnippetString(fn.snippet);
      item.sortText = `4-fn-${fn.label}`;
      return item;
    });
  }

  private _whereOperatorItems(): vscode.CompletionItem[] {
    return WHERE_OPERATORS.map(op => {
      const item = new vscode.CompletionItem(op.label, vscode.CompletionItemKind.Operator);
      item.detail = op.detail;
      item.insertText = new vscode.SnippetString(op.snippet);
      item.sortText = `5-${op.label}`;
      return item;
    });
  }

  // ===========================================================================
  // Connection / document helpers
  // ===========================================================================

  private async _getNotebookConnection(document: vscode.TextDocument): Promise<{ connectionId: string; database: string } | null> {
    if (document.uri.scheme !== 'vscode-notebook-cell') {
      return null;
    }
    const notebook = vscode.workspace.notebookDocuments.find(nb =>
      nb.getCells().some(cell => cell.document.uri.toString() === document.uri.toString())
    );
    if (!notebook?.metadata?.connectionId) {
      return null;
    }
    const metadata = notebook.metadata as { connectionId: string; databaseName?: string };
    return {
      connectionId: metadata.connectionId,
      database: metadata.databaseName || 'postgres'
    };
  }

  private async _resolveConnectionConfig(connectionId: string): Promise<{
    id: string;
    host: string;
    port: number;
    username: string;
    name: string;
  } | null> {
    const connections =
      (vscode.workspace.getConfiguration().get<Array<{ id: string; host: string; port: number; username: string; name: string }>>(
        'postgresExplorer.connections'
      )) || [];
    return connections.find(c => c.id === connectionId) ?? null;
  }

  private _getTextBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    return SqlCompletionProvider.sqlTextBeforeCursor(document, position);
  }

  private _extractArgumentNames(argumentsText: string): string[] {
    if (!argumentsText.trim()) {
      return [];
    }
    const modes = new Set(['in', 'out', 'inout', 'variadic', 'table']);
    return argumentsText.split(',').map((part, idx) => {
      const withoutDefault = part.replace(/\s+default\s+.+$/i, '').trim();
      const tokens = withoutDefault.split(/\s+/).filter(Boolean);
      const first = tokens[0]?.toLowerCase();
      const candidate = modes.has(first || '') ? tokens[1] : tokens[0];
      return candidate || `arg${idx + 1}`;
    });
  }

  private _dedupeTables(tables: TableInfo[]): TableInfo[] {
    const seen = new Set<string>();
    return tables.filter(table => {
      const key = `${table.schema}.${table.objectName}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private _dedupeColumns(columns: ColumnInfo[]): ColumnInfo[] {
    const seen = new Set<string>();
    return columns.filter(column => {
      const key = `${column.schema}.${column.tableName}.${column.columnName}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

function kindForObject(objectType: string): vscode.CompletionItemKind {
  return objectType === 'function' || objectType === 'procedure'
    ? vscode.CompletionItemKind.Function
    : vscode.CompletionItemKind.Class;
}

function titleCaseType(objectType: string): string {
  return objectType === 'materialized view'
    ? 'Materialized View'
    : objectType.replace(/\b\w/g, ch => ch.toUpperCase());
}
