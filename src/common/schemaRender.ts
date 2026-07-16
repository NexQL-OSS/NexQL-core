/**
 * Pure (DB-free) relevance ranking + markdown rendering for table schemas (P1.2).
 *
 * `DbObjectService` fetches a structured {@link TableSchema} once (and caches it), then this
 * module ranks columns/indexes/FKs against the live user message and renders a size-capped
 * markdown block per request. Keeping this logic pure makes ranking + truncation testable
 * without a database.
 */

/** Top-N columns kept in full before the rest collapse to a summary line. */
export const AI_SCHEMA_MAX_COLUMNS = 25;
/** Hard byte cap per rendered object; FK/index detail is dropped first when exceeded. */
export const AI_SCHEMA_MAX_BYTES_PER_OBJECT = 2560;
/** How many overflow column names to list in the "ask to expand" hint. */
const OVERFLOW_NAME_SAMPLE = 8;

/** Relevance scoring weights (named to avoid magic numbers). */
const SCORE_EXACT = 100;
const SCORE_PREFIX = 40;
const SCORE_SUBSTRING = 20;
const SCORE_TYPE = 5;
const MIN_SUBSTRING_LEN = 3;

export interface ColumnInfo {
  name: string;
  /** Pre-formatted type, e.g. `varchar(255)` or `numeric(10,2)`. */
  dataType: string;
  /** `'YES'` | `'NO'` (kept as-is from information_schema for output parity). */
  isNullable: string;
  default: string | null;
}

export interface ForeignKeyInfo {
  constraintName: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
}

export interface TableSchema {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  pk: string[];
  fks: ForeignKeyInfo[];
  indexes: IndexInfo[];
  rowEstimate: number | null;
}

export interface RenderTableSchemaOptions {
  /** User message + any SQL identifiers used to rank columns. */
  userMessage?: string;
  maxColumns?: number;
  maxBytes?: number;
}

/** Lightweight identifier tokenizer — no deps, lowercase, de-duplicated. */
export function tokenizeForRanking(text: string | undefined | null): string[] {
  if (!text) {
    return [];
  }
  const matches = text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
  return Array.from(new Set(matches));
}

function scoreColumn(col: ColumnInfo, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const name = col.name.toLowerCase();
  const type = col.dataType.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token === name) {
      score += SCORE_EXACT;
    } else if (name.startsWith(token) || token.startsWith(name)) {
      score += SCORE_PREFIX;
    } else if (token.length >= MIN_SUBSTRING_LEN && name.includes(token)) {
      score += SCORE_SUBSTRING;
    }
    if (token.length >= MIN_SUBSTRING_LEN && type.includes(token)) {
      score += SCORE_TYPE;
    }
  }
  return score;
}

/**
 * Decide which column indices to keep in full. PK/FK columns are ALWAYS kept (key columns are
 * essential for joins); the remaining slots go to the highest-scoring columns. Kept columns are
 * returned in original ordinal order for readability.
 */
function selectColumns(
  schema: TableSchema,
  tokens: string[],
  limit: number,
): { keptIdx: number[]; overflowIdx: number[] } {
  const pkSet = new Set(schema.pk);
  const fkSet = new Set(schema.fks.map((f) => f.column));

  const mandatory: number[] = [];
  const optional: number[] = [];
  schema.columns.forEach((col, idx) => {
    if (pkSet.has(col.name) || fkSet.has(col.name)) {
      mandatory.push(idx);
    } else {
      optional.push(idx);
    }
  });

  const scored = optional
    .map((idx) => ({ idx, score: scoreColumn(schema.columns[idx], tokens) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const keep = new Set<number>(mandatory);
  for (const entry of scored) {
    if (keep.size >= limit) {
      break;
    }
    keep.add(entry.idx);
  }

  const keptIdx: number[] = [];
  const overflowIdx: number[] = [];
  schema.columns.forEach((_, idx) => {
    if (keep.has(idx)) {
      keptIdx.push(idx);
    } else {
      overflowIdx.push(idx);
    }
  });
  return { keptIdx, overflowIdx };
}

function buildMarkdown(
  schema: TableSchema,
  tokens: string[],
  columnLimit: number,
  includeKeyDetail: boolean,
): string {
  const { keptIdx, overflowIdx } = selectColumns(schema, tokens, columnLimit);

  let info = `## Table: ${schema.schema}.${schema.table}\n\n`;
  info += '### Columns\n| Column | Type | Nullable | Default |\n|--------|------|----------|---------|\n';
  for (const idx of keptIdx) {
    const col = schema.columns[idx];
    info += `| ${col.name} | ${col.dataType} | ${col.isNullable} | ${col.default || '-'} |\n`;
  }

  if (overflowIdx.length > 0) {
    const names = overflowIdx
      .slice(0, OVERFLOW_NAME_SAMPLE)
      .map((idx) => schema.columns[idx].name)
      .join(', ');
    const ellipsis = overflowIdx.length > OVERFLOW_NAME_SAMPLE ? ', …' : '';
    info += `\n+ ${overflowIdx.length} more columns (ask to expand: ${names}${ellipsis})\n`;
  }

  if (schema.pk.length > 0) {
    info += `\n### Primary Key\n${schema.pk.join(', ')}\n`;
  }

  if (schema.fks.length > 0) {
    if (includeKeyDetail) {
      info += '\n### Foreign Keys\n';
      for (const fk of schema.fks) {
        info += `- ${fk.constraintName}: ${fk.column} → ${fk.refSchema}.${fk.refTable}(${fk.refColumn})\n`;
      }
    } else {
      info += `\n### Foreign Keys: ${schema.fks.length} (detail omitted to fit budget)\n`;
    }
  }

  if (schema.indexes.length > 0) {
    if (includeKeyDetail) {
      info += '\n### Indexes\n';
      for (const idx of schema.indexes) {
        const flags: string[] = [];
        if (idx.isPrimary) {
          flags.push('PRIMARY');
        }
        if (idx.isUnique && !idx.isPrimary) {
          flags.push('UNIQUE');
        }
        const cols = idx.columns.join(', ');
        info += `- ${idx.name} (${cols})${flags.length ? ' [' + flags.join(', ') + ']' : ''}\n`;
      }
    } else {
      info += `\n### Indexes: ${schema.indexes.length} (detail omitted to fit budget)\n`;
    }
  }

  if (schema.rowEstimate != null) {
    info += `\n### Estimated Row Count: ~${Number(schema.rowEstimate).toLocaleString()}\n`;
  }

  return info;
}

/**
 * Render a {@link TableSchema} to markdown, ranking columns against the user message and
 * enforcing a per-object byte cap. Default options reproduce the historical markdown shape
 * so downstream display is unchanged for narrow tables / no-query renders.
 */
export function renderTableSchema(schema: TableSchema, opts: RenderTableSchemaOptions = {}): string {
  const maxColumns = opts.maxColumns ?? AI_SCHEMA_MAX_COLUMNS;
  const maxBytes = opts.maxBytes ?? AI_SCHEMA_MAX_BYTES_PER_OBJECT;
  const tokens = tokenizeForRanking(opts.userMessage);

  // 1) Full detail within the column cap.
  let out = buildMarkdown(schema, tokens, maxColumns, true);
  if (Buffer.byteLength(out, 'utf8') <= maxBytes) {
    return out;
  }

  // 2) Over the cap → collapse FK/index detail to summary counts.
  out = buildMarkdown(schema, tokens, maxColumns, false);
  if (Buffer.byteLength(out, 'utf8') <= maxBytes) {
    return out;
  }

  // 3) Still over → progressively reduce the kept-column count (rest collapse to the summary line).
  let limit = maxColumns;
  while (limit > 1 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    limit -= 1;
    out = buildMarkdown(schema, tokens, limit, false);
  }
  return out;
}
