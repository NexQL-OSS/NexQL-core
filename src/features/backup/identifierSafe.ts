/**
 * Reject values that could break argv or inject flags when passed to pg_dump/pg_restore.
 * Allows typical PostgreSQL identifiers and quoted-style names without semicolons or option markers.
 */
export function assertSafeCliIdentifier(value: string, fieldName: string): void {
  if (!value || typeof value !== 'string') {
    throw new Error(`${fieldName} is required`);
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${fieldName} contains invalid characters`);
  }
  if (value.includes('--')) {
    throw new Error(`${fieldName} must not contain "--"`);
  }
  if (value.trim().startsWith('-')) {
    throw new Error(`${fieldName} must not start with "-"`);
  }
}

/** schema.table — both parts checked (unquoted identifiers only). */
export function assertSafeTableQualified(qualified: string): void {
  assertSafeCliIdentifier(qualified, 'table');
  const parts = qualified.split('.');
  if (parts.length !== 2) {
    throw new Error('Table must be schema.table');
  }
  assertSafeCliIdentifier(parts[0]!, 'schema');
  assertSafeCliIdentifier(parts[1]!, 'table name');
}

/**
 * Validates a pg_dump `-t` argument produced by PostgreSQL quote_ident (may contain quoted identifiers).
 */
export function assertSafePgDumpTableArg(value: string): void {
  if (!value || typeof value !== 'string') {
    throw new Error('Table pattern is required');
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('Table pattern contains invalid characters');
  }
  if (value.includes('--')) {
    throw new Error('Table pattern must not contain "--"');
  }
  if (value.trimStart().startsWith('-')) {
    throw new Error('Table pattern must not start with "-"');
  }
}
