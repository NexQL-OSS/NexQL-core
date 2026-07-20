/**
 * Purpose-built prompt framing per (intent × ContextItem kind).
 *
 * Replaces the hard-coded strings that used to live at renderQueryResult.ts,
 * explainTab.ts, analystTab.ts, and every `handle*` method on ChatViewProvider.
 * `buildDraft` never sends anything — it only produces the editable draft text
 * and the (invisible, in-memory) attachments a caller wants prefilled. Nothing
 * here touches disk.
 */
import type { FileAttachment } from '../../common/chatTypes';
import { AssistantInvocation, ContextItem, CONTEXT_SAMPLE_ROW_CAP } from './contextItems';

export interface DraftResult {
  draftText: string;
  attachments: FileAttachment[];
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map((c) => csvEscape(c)).join(',');
  const body = rows.map((row) => columns.map((c) => csvEscape(row?.[c])).join(',')).join('\n');
  return body ? `${header}\n${body}` : header;
}

function defaultDraftText(inv: AssistantInvocation, notes: string[]): string {
  const noteSuffix = notes.length ? ` ${notes.join(' ')}` : '';
  switch (inv.intent) {
    case 'analyzeData':
      return `Please analyze this data.${noteSuffix} Look for patterns, outliers, or interesting insights, and summarize what it represents.`;
    case 'optimizeQuery':
      return `Please review the attached query context and suggest concrete fixes (indexes, query rewrites, join strategy, config tuning) with a step-by-step verification plan.${noteSuffix}`;
    case 'explainError':
      return `I got this error running the attached query. Can you explain why it occurred and how to fix it? Provide the corrected SQL.${noteSuffix}`;
    case 'fixQuery':
      return `Fix the attached SQL query which caused an error. Please provide only the corrected SQL and a brief explanation.${noteSuffix}`;
    case 'generateQuery':
      return `Please generate a SQL query for the following request.${noteSuffix}`;
    case 'explainPlan':
      return `Please explain what this query is doing and how efficient it is, focusing on the top-cost plan nodes.${noteSuffix}`;
    case 'reviewMigration':
      return `Please review this migration for correctness and safety.${noteSuffix}`;
    case 'indexAdvice':
      return `Please recommend indexes based on the attached query statistics.${noteSuffix}`;
    case 'backupHelp':
      return `Please help me with this backup/restore issue.${noteSuffix}`;
    case 'ask':
    default:
      // No notes means nothing but a bare dbObject/file attach — leave the draft empty rather
      // than injecting filler text. A generic sentence here would (a) overwrite whatever the
      // user already typed and (b) starve renderTableSchema's relevance-ranking pass, which
      // ranks schema content against this very string — see DbObjectService.getObjectSchema.
      return notes.length ? notes.join(' ') : '';
  }
}

/** Builds the editable draft + invisible attachments for a gateway invocation. Never sends. */
export function buildDraft(inv: AssistantInvocation): DraftResult {
  const attachments: FileAttachment[] = [];
  const notes: string[] = [];

  for (const item of inv.items) {
    framItem(item, attachments, notes);
  }

  const draftText = inv.draftText ?? defaultDraftText(inv, notes);
  return { draftText, attachments };
}

function framItem(item: ContextItem, attachments: FileAttachment[], notes: string[]): void {
  switch (item.kind) {
    case 'dbObject':
      // Resolved separately by AssistantGateway (async schema fetch → addMentionFromTree).
      break;
    case 'query':
      attachments.push({ name: 'SQL query', content: item.sql, type: 'sql' });
      break;
    case 'resultSample': {
      const capped = item.rows.slice(0, CONTEXT_SAMPLE_ROW_CAP);
      const label = item.truncated
        ? `Results · ${capped.length} of ${item.totalRowCount.toLocaleString()} rows`
        : `Results · ${item.totalRowCount.toLocaleString()} row${item.totalRowCount === 1 ? '' : 's'}`;
      attachments.push({ name: label, content: toCsv(item.columns, capped), type: 'csv' });
      const rowWord = item.totalRowCount === 1 ? 'row' : 'rows';
      notes.push(
        item.totalRowCount === 0
          ? 'The query returned no rows.'
          : `Returned ${item.totalRowCount} ${rowWord}${item.truncated ? ` (showing ${capped.length} sample rows in the attachment)` : ''}.`
      );
      break;
    }
    case 'explainPlan': {
      const planText = item.planText ?? (item.planJson !== undefined ? JSON.stringify(item.planJson, null, 2) : '');
      attachments.push({
        name: item.analyze ? 'EXPLAIN ANALYZE plan' : 'EXPLAIN plan',
        content: planText,
        type: 'json',
      });
      break;
    }
    case 'notices': {
      const text = item.notices
        .map((n, i) => {
          const lines = [`${i + 1}. [${n.severity}] ${n.message}`];
          if (n.detail) lines.push(`   Detail: ${n.detail}`);
          if (n.hint) lines.push(`   Hint: ${n.hint}`);
          return lines.join('\n');
        })
        .join('\n\n');
      attachments.push({ name: `Notices · ${item.notices.length}`, content: text, type: 'txt' });
      notes.push(`I received ${item.notices.length} PostgreSQL notice${item.notices.length === 1 ? '' : 's'} — please help me interpret them.`);
      break;
    }
    case 'error': {
      const e = item.error;
      const lines = [
        e.code ? `Code: ${e.code}` : null,
        `Message: ${e.message}`,
        e.detail ? `Detail: ${e.detail}` : null,
        e.hint ? `Hint: ${e.hint}` : null,
        typeof e.position === 'number' ? `Position: ${e.position}` : null,
      ].filter((l): l is string => !!l);
      attachments.push({ name: e.code ? `Error · ${e.code}` : 'Error', content: lines.join('\n'), type: 'txt' });
      break;
    }
    case 'migration':
      attachments.push({ name: `Migration (${item.direction})`, content: item.sql, type: 'sql' });
      if (item.description) notes.push(item.description);
      break;
    case 'backupTool':
      notes.push(`Tool: ${item.tool}`);
      break;
    case 'file':
      attachments.push(item.attachment);
      break;
  }
}
