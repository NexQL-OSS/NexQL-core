import type { PivotAiHelpContext } from '../../../renderer/components/analyst/AnalystPanel';
import { SPINNER_FRAMES } from '../rendererConstants';
import { prefersReducedMotion } from '../../theme/motion';

export const PIVOT_HELP_SQL_INLINE_MAX_CHARS = 12000;

/** Rows attached as CSV when using Send to Chat from results (full grids are rarely useful). */
export const CHAT_SEND_SAMPLE_ROW_CAP = 10;

export function buildChatResultsSampleJson(
  columns: string[],
  rows: unknown[],
  maxRows: number,
): string | undefined {
  if (maxRows <= 0 || rows.length === 0) {
    return undefined;
  }
  return JSON.stringify({
    columns,
    rows: rows.slice(0, maxRows),
  });
}

/** User message for SQL Assistant when pivot cardinality exceeds the client cap. */
export function buildPivotOptimizeUserMessage(ctx: PivotAiHelpContext, sourceSql: string): string {
  const trimmed = sourceSql.trim();
  let sqlInline = trimmed;
  let truncationNote = '';
  if (trimmed.length > PIVOT_HELP_SQL_INLINE_MAX_CHARS) {
    sqlInline = trimmed.slice(0, PIVOT_HELP_SQL_INLINE_MAX_CHARS);
    truncationNote = `\n-- … truncated for chat prompt (${trimmed.length.toLocaleString()} chars total); full SQL is attached as a file.`;
  }

  const valueLine =
    ctx.aggregation === 'count' && !ctx.valueColumn
      ? 'Count rows (no separate value column)'
      : ctx.valueColumn ?? '—';

  return [
    'NexQL Analyst tab: the in-browser pivot failed because there are too many distinct row or column labels.',
    '',
    'Help me rewrite my PostgreSQL query using server-side pre-aggregation (GROUP BY, rollups, bucketing, date_trunc, FILTER, CASE expressions, etc.) so pivot dimensions stay within a manageable cardinality.',
    '',
    `Pivot error: ${ctx.errorMessage}`,
    '',
    'Pivot configuration:',
    `- Row dimension: ${ctx.rowDimension}`,
    `- Column dimension: ${ctx.columnDimension}`,
    `- Value column / measure: ${valueLine}`,
    `- Aggregation: ${ctx.aggregation}`,
    '',
    'Context:',
    `- UI cap (distinct values per axis): ${ctx.maxDistinctPerAxis}`,
    `- Rows currently in this result grid: ${ctx.inMemoryRowCount.toLocaleString()}`,
    `- Streaming sliding window: ${ctx.isStreamingWindow ? 'yes (only a subset of server rows may be loaded)' : 'no'}`,
    '',
    'No result grid CSV is attached (usually redundant here; use the attached SQL file and pivot fields above).',
    '',
    'Source SQL (also attached as a .sql file):',
    '```sql',
    sqlInline + truncationNote,
    '```',
    '',
    'Please propose efficient PostgreSQL that returns an aggregation-friendly result set I can pivot in the notebook, plus any index notes if relevant.',
  ].join('\n');
}

/**
 * Puts a button into a loading state with an animated braille spinner.
 * When `prefers-reduced-motion` is set, uses a static label instead of animation.
 * Returns a cleanup function that restores the original label and re-enables the button.
 */
export function startButtonLoading(btn: HTMLElement, loadingLabel: string): () => void {
  const originalText = btn.innerText;
  const originalDisabled = (btn as HTMLButtonElement).disabled;
  (btn as HTMLButtonElement).disabled = true;
  btn.style.opacity = '0.7';
  btn.style.cursor = 'not-allowed';

  const restore = () => {
    btn.innerText = originalText;
    (btn as HTMLButtonElement).disabled = originalDisabled;
    btn.style.opacity = '';
    btn.style.cursor = '';
  };

  if (prefersReducedMotion()) {
    btn.innerText = `… ${loadingLabel}`;
    return restore;
  }

  let frame = 0;
  btn.innerText = `${SPINNER_FRAMES[frame]} ${loadingLabel}`;
  const interval = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    btn.innerText = `${SPINNER_FRAMES[frame]} ${loadingLabel}`;
  }, 100);

  return () => {
    clearInterval(interval);
    restore();
  };
}

/** Inject amber-gutter CSS once */
export function ensureAmberGutterStyle(): void {
  const STYLE_ID = 'amber-gutter-style';
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .amber-gutter {
      border-left: 4px solid #ffb000 !important;
    }
  `;
  document.head.appendChild(style);
}

/** Remove all transaction banners and amber gutters from the document */
export function clearTransactionUI(): void {
  document.querySelectorAll('[data-transaction-banner="true"]').forEach((el) => el.remove());
  document.querySelectorAll('.amber-gutter').forEach((el) => el.classList.remove('amber-gutter'));
}
