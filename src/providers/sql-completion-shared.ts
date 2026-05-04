/**
 * Shared SQL completion utilities (quoting, reserved words) used by completion and signature providers.
 */

import { SqlParser } from './kernel/SqlParser';

/** Minimal PostgreSQL reserved-word set for safe unquoted inserts (expand as needed). */
export const PG_RESERVED_WORDS = new Set<string>(
  [
    'all',
    'analyse',
    'analyze',
    'and',
    'any',
    'array',
    'as',
    'asc',
    'asymmetric',
    'authorization',
    'binary',
    'both',
    'case',
    'cast',
    'check',
    'collate',
    'column',
    'concurrently',
    'constraint',
    'create',
    'cross',
    'current_catalog',
    'current_date',
    'current_role',
    'current_schema',
    'current_time',
    'current_timestamp',
    'current_user',
    'default',
    'deferrable',
    'desc',
    'distinct',
    'do',
    'else',
    'end',
    'except',
    'false',
    'fetch',
    'for',
    'foreign',
    'freeze',
    'from',
    'full',
    'grant',
    'group',
    'having',
    'ilike',
    'in',
    'initially',
    'inner',
    'intersect',
    'into',
    'is',
    'isnull',
    'join',
    'lateral',
    'leading',
    'left',
    'like',
    'limit',
    'localtime',
    'localtimestamp',
    'natural',
    'not',
    'notnull',
    'null',
    'offset',
    'on',
    'only',
    'or',
    'order',
    'outer',
    'overlaps',
    'placing',
    'primary',
    'references',
    'returning',
    'right',
    'select',
    'session_user',
    'similar',
    'some',
    'symmetric',
    'table',
    'then',
    'to',
    'trailing',
    'true',
    'union',
    'unique',
    'user',
    'using',
    'variadic',
    'verbose',
    'when',
    'where',
    'window',
    'with'
  ]
);

export function sqlNeedsQuoting(identifier: string): boolean {
  const n = SqlParser.normalizeIdentifier(identifier);
  if (!n) {
    return true;
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(n)) {
    return true;
  }
  return PG_RESERVED_WORDS.has(n.toLowerCase());
}

/** Escape for double-quoted PostgreSQL identifier (preserves case inside quotes). */
export function sqlQuoteIdentifier(identifier: string): string {
  let raw = identifier.trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1).replace(/""/g, '"');
  } else {
    raw = SqlParser.normalizeIdentifier(raw);
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

export function sqlFormatIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }
  if (sqlNeedsQuoting(trimmed)) {
    return sqlQuoteIdentifier(trimmed);
  }
  return SqlParser.normalizeIdentifier(trimmed);
}
