/**
 * Typed context payload for every SQL Assistant invocation.
 *
 * This is the ONE place that defines what can be attached to a chat turn and
 * the ONE row cap used across every surface (tree view, result grid, EXPLAIN
 * tab, analyst tab, migrations, index advisor, backup tools). Before this,
 * each call site hard-coded its own cap (10 / 5 / 5-3 / 50) and its own
 * prompt string — see promptFraming.ts for the framing side of this.
 */
import type { DbObject, FileAttachment } from '../../common/chatTypes';

/** Sample rows shown to the model for any tabular result — the ONE cap. */
export const CONTEXT_SAMPLE_ROW_CAP = 10;

export interface NoticeItem {
  severity: string;
  message: string;
  detail?: string;
  hint?: string;
}

export interface ErrorItem {
  code?: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: number;
}

export type ContextItem =
  | { kind: 'dbObject'; object: DbObject }
  | { kind: 'query'; sql: string; source?: 'notebook' | 'editor' | 'history' | 'saved' }
  | {
      kind: 'resultSample';
      sql: string;
      columns: string[];
      /** Row records keyed by column name — matches the result-grid row shape, not tuples. */
      rows: Array<Record<string, unknown>>;
      totalRowCount: number;
      truncated: boolean;
      executionMs?: number;
    }
  | { kind: 'explainPlan'; sql: string; planText?: string; planJson?: unknown; analyze: boolean }
  | { kind: 'notices'; sql?: string; notices: NoticeItem[] }
  | { kind: 'error'; sql?: string; error: ErrorItem }
  | { kind: 'migration'; direction: 'up' | 'down'; sql: string; description?: string }
  | { kind: 'backupTool'; tool: string; params: Record<string, unknown> }
  | { kind: 'file'; attachment: FileAttachment };

export type AssistantIntent =
  | 'ask'
  | 'explainError'
  | 'fixQuery'
  | 'analyzeData'
  | 'optimizeQuery'
  | 'generateQuery'
  | 'explainPlan'
  | 'reviewMigration'
  | 'indexAdvice'
  | 'backupHelp';

export interface AssistantInvocation {
  intent: AssistantIntent;
  items: ContextItem[];
  /** Explicit draft text override. When omitted, promptFraming derives a default from `intent` + `items`. */
  draftText?: string;
  connection?: { connectionId?: string; database?: string };
  /** Default 'draft': prefill + wait for the user to press Send. 'auto' is an explicit escape hatch. */
  send?: 'draft' | 'auto';
}
