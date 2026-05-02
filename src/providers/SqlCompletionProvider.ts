import * as vscode from 'vscode';
import { ConnectionManager } from '../services/ConnectionManager';
import { SqlParser } from './kernel/SqlParser';
import { outputChannel } from '../extension';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TableInfo {
  schema: string;
  objectName: string;
  objectType: string;
  arguments?: string;
  callArguments?: string;
}

interface ColumnInfo {
  schema: string;
  tableName: string;
  columnName: string;
  dataType: string;
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
  insertTarget: RelationContext | null;
  updateTarget: RelationContext | null;
}

interface SchemaCache {
  objects: TableInfo[];
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  searchPath: string[];
  updatedAt: number;
}

const EMPTY_CACHE: SchemaCache = {
  objects: [],
  columns: [],
  foreignKeys: [],
  searchPath: ['public'],
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
  UpdateSet = 'updateSet',
  Returning = 'returning'
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
              SELECT 'table' as object_type, table_schema as schema, table_name as object_name, NULL::text as arguments, NULL::text as call_arguments
                    FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'
                    UNION ALL
              SELECT 'view', table_schema, table_name, NULL::text, NULL::text
                    FROM information_schema.views
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    UNION ALL
              SELECT 'materialized view', schemaname, matviewname, NULL::text, NULL::text
                    FROM pg_matviews
                    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                    UNION ALL
                    SELECT
                        CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END,
                        n.nspname,
                        p.proname,
                pg_get_function_arguments(p.oid) AS arguments,
                pg_get_function_identity_arguments(p.oid) AS call_arguments
                    FROM pg_proc p
                    JOIN pg_namespace n ON p.pronamespace = n.oid
                    WHERE p.prokind IN ('f', 'p')
                      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY schema, object_name
                `;

  private static readonly CATALOG_COLUMNS_SQL = `
                    SELECT
                        table_schema as schema,
                        table_name,
                        column_name,
                        data_type
                    FROM information_schema.columns
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name, ordinal_position
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
        const textBeforeCursor = this._getTextBeforeCursor(document, position);
        const parsed = this._parseQuery(textBeforeCursor);
        const items = this._buildCompletions(parsed, EMPTY_CACHE);
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

      const textBeforeCursor = this._getTextBeforeCursor(document, position);
      const parsed = this._parseQuery(textBeforeCursor);
      return this._buildCompletions(parsed, cache);
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
        objectsResult.rows.map((row: { schema: string; object_name: string; object_type: string; arguments?: string; call_arguments?: string }) => ({
          schema: row.schema,
          objectName: row.object_name,
          objectType: row.object_type,
          arguments: row.arguments,
          callArguments: row.call_arguments
        }))
      );

      const columnsResult = await client.query(SqlCompletionProvider.CATALOG_COLUMNS_SQL);
      const columns = this._dedupeColumns(
        columnsResult.rows.map((row: { schema: string; table_name: string; column_name: string; data_type: string }) => ({
          schema: row.schema,
          tableName: row.table_name,
          columnName: row.column_name,
          dataType: row.data_type
        }))
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

      if ((this.catalogEpoch.get(cacheKey) ?? 0) !== epochAtStart) {
        return;
      }

      this.schemaCache.set(cacheKey, {
        objects,
        columns,
        foreignKeys,
        searchPath,
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

  private _parseQuery(textBeforeCursor: string): ParsedQuery {
    const cleanText = SqlParser.stripCommentsAndStrings(textBeforeCursor);

    const dotMatch = cleanText.match(/(("[^"]+"|[a-z_][a-z0-9_]*))\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*)?$/i);
    const hasQualifiedPrefix = dotMatch !== null;
    const dotQualifier = dotMatch ? SqlParser.normalizeIdentifier(dotMatch[1]) : null;

    const activeStmt = this._activeStatementForClause(cleanText);

    const cteColumns = this._parseCtes(activeStmt);
    const { relations, aliasMap, qualifiedMap, referencedTables } = this._extractAllRelations(activeStmt);

    const clause = this._detectClause(activeStmt);

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
      dotQualifier,
      hasQualifiedPrefix,
      insertTarget,
      updateTarget
    };
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
   * Last clause keyword at paren depth 0; INSERT column list overrides via paren depth.
   */
  private _detectClause(stmt: string): SqlClause {
    const clauseRegex =
      /\(|\)|\b(select|from|delete\s+from|where|join|left\s+join|right\s+join|inner\s+join|cross\s+join|full\s+outer\s+join|group\s+by|order\s+by|having|on|insert\s+into|update|set|returning)\b/gi;

    let depth = 0;
    let clause: SqlClause = SqlClause.Unknown;
    let updateSeen = false;

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
      } else if (low === 'from' || low === 'delete from') {
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
      `${SqlCompletionProvider.RELATION_LEAD_IN}(${identifier}(?:\\s*\\.\\s*${identifier})?)(?:\\s+(?:as\\s+)?(${identifier}))?`,
      'gi'
    );

    let m: RegExpExecArray | null;
    while ((m = relationRegex.exec(cleanText)) !== null) {
      let aliasTok = m[2] || null;
      if (aliasTok && SQL_RESERVED_ALIAS.has(aliasTok.toLowerCase())) {
        aliasTok = null;
      }
      const parsed = this._parseQualifiedIdentifier(m[1]);
      const schema = parsed.schema;
      const objectName = parsed.name;
      if (!objectName) {
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

  private _parseCtes(cleanText: string): Map<string, string[]> {
    const ctes = new Map<string, string[]>();
    const cteRe = /\bwith\b([\s\S]*?)\bselect\b/i;
    const cteMatch = cteRe.exec(cleanText);
    if (!cteMatch) {
      return ctes;
    }

    const cteBlock = cteMatch[1];
    const indivRe = /("[^"]+"|[a-z_][a-z0-9_]*)\s+as\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = indivRe.exec(cteBlock)) !== null) {
      const cteName = SqlParser.normalizeIdentifier(m[1]);
      const startIdx = m.index + m[0].length;
      let depth = 1;
      let i = startIdx;
      while (i < cteBlock.length && depth > 0) {
        if (cteBlock[i] === '(') {
          depth++;
        } else if (cteBlock[i] === ')') {
          depth--;
        }
        i++;
      }
      const body = cteBlock.slice(startIdx, i - 1);
      const cols = this._extractSelectColumnNames(body);
      if (cols.length > 0) {
        ctes.set(cteName, cols);
      }
    }
    return ctes;
  }

  private _extractSelectColumnNames(selectBody: string): string[] {
    const fromIdx = selectBody.search(/\bfrom\b/i);
    const selectList = fromIdx > 0 ? selectBody.slice(0, fromIdx) : selectBody;
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
        const aliasMatch =
          part.match(/\bas\s+("[^"]+"|[a-z_][a-z0-9_]*)$/i) ||
          part.match(/("[^"]+"|[a-z_][a-z0-9_]*)$/i);
        if (aliasMatch) {
          cols.push(SqlParser.normalizeIdentifier(aliasMatch[1]));
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

  private _buildCompletions(parsed: ParsedQuery, cache: SchemaCache): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    if (parsed.hasQualifiedPrefix && parsed.dotQualifier) {
      return this._qualifiedPrefixCompletions(parsed, cache);
    }

    if (parsed.clause === SqlClause.InsertColumns && parsed.insertTarget) {
      return this._columnItemsOrdinal(cache.columns, parsed.insertTarget, true);
    }

    if (parsed.clause === SqlClause.UpdateSet && parsed.updateTarget) {
      items.push(...this._columnItemsOrdinal(cache.columns, parsed.updateTarget, true));
      items.push(...this._scalarFunctionItems());
      return items;
    }

    if (parsed.clause === SqlClause.On) {
      return this._onClauseCompletions(parsed, cache);
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
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0'));
      items.push(...this._cteColumnItems(parsed));
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
      return items;
    }

    if (parsed.clause === SqlClause.Where || parsed.clause === SqlClause.Having) {
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0'));
      items.push(...this._scalarFunctionItems());
      items.push(...this._whereOperatorItems());
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
      return items;
    }

    if (parsed.clause === SqlClause.GroupBy || parsed.clause === SqlClause.OrderBy) {
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0'));
      items.push(...this._scalarFunctionItems());
      if (parsed.clause === SqlClause.OrderBy) {
        items.push(...this._keywordItems(['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']));
      }
      return items;
    }

    if (parsed.clause === SqlClause.Returning) {
      const target = parsed.updateTarget || parsed.insertTarget;
      if (target) {
        items.push(...this._columnItemsOrdinal(cache.columns, target, false));
      }
      items.push(...this._contextualColumnItems(parsed, cache.columns, '0'));
      return items;
    }

    items.push(...this._objectItemsAll(cache.objects, cache.searchPath));
    items.push(...this._contextualColumnItems(parsed, cache.columns, '0'));
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

  private _qualifiedPrefixCompletions(parsed: ParsedQuery, cache: SchemaCache): vscode.CompletionItem[] {
    const q = parsed.dotQualifier!;

    const cteCols = parsed.cteColumns.get(q);
    if (cteCols && cteCols.length > 0) {
      return cteCols.map(col => {
        const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
        item.detail = `CTE column (${q})`;
        item.sortText = `0-${col}`;
        item.insertText = col;
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
      return this._columnItemsForRelationBare(cache.columns, rel);
    }

    const schemaHits = cache.objects.filter(o => o.schema.toLowerCase() === qLower);
    if (schemaHits.length > 0) {
      return this._objectItemsInSchema(schemaHits, true);
    }

    return this._objectItemsAll(cache.objects, cache.searchPath);
  }

  private _columnItemsForRelationBare(columns: ColumnInfo[], rel: RelationContext): vscode.CompletionItem[] {
    const cols = columns.filter(
      c =>
        c.tableName.toLowerCase() === rel.objectName &&
        (!rel.schema || c.schema.toLowerCase() === rel.schema)
    );
    return cols.map((col, idx) => {
      const item = new vscode.CompletionItem(col.columnName, vscode.CompletionItemKind.Field);
      item.detail = `${col.dataType} · ${col.schema}.${col.tableName}`;
      item.sortText = `0-${String(idx).padStart(4, '0')}`;
      item.insertText = col.columnName;
      item.filterText = `${col.columnName} ${col.tableName}.${col.columnName}`;
      return item;
    });
  }

  private _columnItemsOrdinal(columns: ColumnInfo[], rel: RelationContext, bare: boolean): vscode.CompletionItem[] {
    const cols = columns.filter(
      c =>
        c.tableName.toLowerCase() === rel.objectName &&
        (!rel.schema || c.schema.toLowerCase() === rel.schema)
    );
    return cols.map((col, idx) => {
      const item = new vscode.CompletionItem(col.columnName, vscode.CompletionItemKind.Field);
      item.detail = `${col.dataType} · ${col.schema}.${col.tableName}`;
      item.sortText = `0-${String(idx).padStart(4, '0')}`;
      item.insertText = bare ? col.columnName : `${rel.alias}.${col.columnName}`;
      item.filterText = `${col.columnName} ${rel.alias}.${col.columnName}`;
      return item;
    });
  }

  private _contextualColumnItems(parsed: ParsedQuery, allColumns: ColumnInfo[], sortPrefix: string): vscode.CompletionItem[] {
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

        const item = new vscode.CompletionItem(col.columnName, vscode.CompletionItemKind.Field);
        item.detail = `${col.dataType} · ${rel.alias} (${rel.objectName})`;
        item.sortText = `${sortPrefix}-${String(relIdx).padStart(2, '0')}-${String(colIdx).padStart(4, '0')}`;
        item.insertText = `${rel.alias}.${col.columnName}`;
        item.filterText = [col.columnName, `${rel.alias}.${col.columnName}`, `${rel.objectName}.${col.columnName}`].join(' ');
        items.push(item);
      });
    });

    return items;
  }

  private _cteColumnItems(parsed: ParsedQuery): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const [cteName, cols] of parsed.cteColumns) {
      cols.forEach((col, idx) => {
        const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
        item.detail = `CTE column (${cteName})`;
        item.sortText = `1-cte-${String(idx).padStart(4, '0')}`;
        item.insertText = col;
        items.push(item);
      });
    }
    return items;
  }

  private _onClauseCompletions(parsed: ParsedQuery, cache: SchemaCache): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    if (parsed.relations.length < 2) {
      items.push(...this._contextualColumnItems(parsed, cache.columns, '2'));
      return items;
    }

    const right = parsed.relations[parsed.relations.length - 1];
    const left = parsed.relations[parsed.relations.length - 2];

    const fkItems = this._fkJoinSuggestions(left, right, cache.foreignKeys);
    items.push(...fkItems);

    if (fkItems.length === 0) {
      items.push(...this._nameMatchJoinSuggestions(left, right, cache.columns));
    }

    items.push(...this._contextualColumnItems(parsed, cache.columns, '2'));
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
        item.insertText = schemaAlreadyInEditor ? obj.objectName : `${obj.schema}.${obj.objectName}`;
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
      item.insertText = obj.objectName;
    } else {
      item.insertText = `${obj.schema}.${obj.objectName}`;
    }

    item.filterText = `${obj.schema}.${obj.objectName} ${obj.objectName} ${obj.objectType}`;
    return item;
  }

  private _functionSnippet(obj: TableInfo): vscode.SnippetString {
    const names = this._extractArgumentNames(obj.callArguments || '');
    return new vscode.SnippetString(
      names.length > 0
        ? `${obj.objectName}(${names.map((a, i) => `\${${i + 1}:${a}}`).join(', ')})`
        : `${obj.objectName}()`
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
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    if (position.line >= lines.length) {
      return text;
    }
    const beforeLines = lines.slice(0, position.line).join('\n');
    const linePrefix = (lines[position.line] || '').slice(0, position.character);
    return beforeLines ? `${beforeLines}\n${linePrefix}` : linePrefix;
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
