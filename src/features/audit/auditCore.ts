// ---------------------------------------------------------------------------
// Pure audit-log logic: statement classification and JSONL entry shaping.
// No VS Code / fs deps, so it is fully unit-testable. AuditLogService wraps
// this with license gating and file persistence.
// ---------------------------------------------------------------------------

export type AuditKind = 'ddl' | 'destructive-dml' | 'other';

export interface AuditEntry {
  at: string; // ISO timestamp
  connection: string;
  host: string;
  database: string;
  environment: string;
  kind: Exclude<AuditKind, 'other'>;
  verb: string;
  statement: string;
}

const DDL_VERBS = /^\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|REINDEX|VACUUM|CLUSTER)\b/i;
const DESTRUCTIVE_DML_VERBS = /^\s*(DELETE|UPDATE|MERGE)\b/i;
const MAX_STATEMENT_CHARS = 2000;

/** Strip leading SQL comments so the classifying verb is the first real token. */
function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      if (nl === -1) { return ''; }
      s = trimmed.slice(nl + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      if (end === -1) { return ''; }
      s = trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
}

/** Classify a statement for audit purposes. TRUNCATE counts as DDL (it takes ACCESS EXCLUSIVE). */
export function classifyStatement(sql: string): { kind: AuditKind; verb: string } {
  const body = stripLeadingComments(sql);
  const ddl = DDL_VERBS.exec(body);
  if (ddl) {
    return { kind: 'ddl', verb: ddl[1].toUpperCase() };
  }
  const dml = DESTRUCTIVE_DML_VERBS.exec(body);
  if (dml) {
    return { kind: 'destructive-dml', verb: dml[1].toUpperCase() };
  }
  return { kind: 'other', verb: '' };
}

/** Only production-tagged connections are audited, and only schema/data-changing verbs. */
export function shouldAudit(environment: string | undefined, kind: AuditKind): boolean {
  return environment === 'production' && kind !== 'other';
}

export interface AuditContext {
  connectionName: string;
  host: string;
  database: string;
  environment: string;
}

/** Build entries for the auditable statements in an executed batch. */
export function buildAuditEntries(
  ctx: AuditContext,
  statements: string[],
  now: Date = new Date(),
): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const stmt of statements) {
    const { kind, verb } = classifyStatement(stmt);
    if (!shouldAudit(ctx.environment, kind)) { continue; }
    entries.push({
      at: now.toISOString(),
      connection: ctx.connectionName,
      host: ctx.host,
      database: ctx.database,
      environment: ctx.environment,
      kind: kind as Exclude<AuditKind, 'other'>,
      verb,
      statement: stmt.trim().slice(0, MAX_STATEMENT_CHARS),
    });
  }
  return entries;
}

/** One JSONL line per entry, newline-terminated, ready to append. */
export function serializeEntries(entries: AuditEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}
