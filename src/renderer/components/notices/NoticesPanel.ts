/**
 * PostgreSQL NOTICE and server messages from query execution, with search.
 */

import type { NoticeLogEntry } from '../../../common/types';
import { createButton } from '../ui';

export interface NoticeEntry {
  /** 1-based order as received from the server */
  order: number;
  text: string;
  /** ISO 8601; empty when loading legacy notebook output (string-only notices) */
  receivedAt: string;
}

/** Coerce notebook JSON (legacy `string[]` or structured entries) to `NoticeLogEntry`. */
export function normalizeNoticesPayload(raw: unknown): NoticeLogEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: NoticeLogEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ message: item, receivedAt: '' });
    } else if (item && typeof item === 'object' && 'message' in item) {
      const m = String((item as { message: unknown }).message);
      const at = (item as { receivedAt?: unknown }).receivedAt;
      out.push({
        message: m,
        receivedAt: typeof at === 'string' ? at : '',
      });
    }
  }
  return out;
}

const NOTICE_LOG_TIME = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatNoticeLogTime(iso: string): string {
  if (!iso.trim()) {
    return '—';
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return '—';
  }
  return NOTICE_LOG_TIME.format(new Date(t));
}

/** Newest notice first (same labels as execution order #). */
function newestFirstNoticeEntries(entries: readonly NoticeEntry[]): NoticeEntry[] {
  return [...entries].reverse();
}

/** Newest first for live payload (array is oldest → newest). */
function newestFirstLiveRows(
  entries: readonly NoticeLogEntry[],
): { order: number; entry: NoticeLogEntry }[] {
  const tagged = entries.map((e, i) => ({ order: i + 1, entry: e }));
  return tagged.reverse();
}

/** Filter notices by case-insensitive substring on message; preserves original order. */
export function filterNoticeEntries(
  messages: readonly NoticeLogEntry[],
  searchQuery: string,
): NoticeEntry[] {
  const q = searchQuery.trim().toLowerCase();
  const indexed: NoticeEntry[] = messages.map((n, i) => ({
    order: i + 1,
    text: n.message,
    receivedAt: n.receivedAt,
  }));
  if (!q) {
    return indexed;
  }
  return indexed.filter((e) => e.text.toLowerCase().includes(q));
}

const COPY_FEEDBACK_MS = 2000;
const LIVE_FEED_MAX_HEIGHT_PX = 240;

/** Shown while a single-statement query runs; updated as each NOTICE arrives. */
export function renderNoticesLiveStream(entries: readonly NoticeLogEntry[]): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-pg-notices-live', '1');
  root.style.cssText = `
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    padding: 8px 12px;
    margin-bottom: 4px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-textBlockQuote-background));
    border-top: 2px solid var(--vscode-textLink-foreground);
  `;
  const title = document.createElement('div');
  title.textContent = 'Notices (live)';
  title.style.cssText =
    'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--vscode-descriptionForeground);margin-bottom:8px;';
  root.appendChild(title);

  const scroll = document.createElement('div');
  scroll.style.cssText = `max-height:${LIVE_FEED_MAX_HEIGHT_PX}px;overflow:auto;`;

  const rows = newestFirstLiveRows(entries);
  rows.forEach(({ order, entry: e }) => {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;gap:10px;padding:6px 0;border-bottom:1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);align-items:flex-start;';
    const idx = document.createElement('span');
    idx.textContent = String(order);
    idx.style.cssText =
      'flex-shrink:0;min-width:2em;font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground);';
    const timeEl = document.createElement('span');
    timeEl.textContent = formatNoticeLogTime(e.receivedAt);
    timeEl.style.cssText =
      'flex-shrink:0;min-width:11.5em;font-variant-numeric:tabular-nums;color:color-mix(in srgb, var(--vscode-descriptionForeground) 88%, var(--vscode-editor-foreground));';
    timeEl.title = e.receivedAt || '';
    const body = document.createElement('div');
    body.textContent = e.message;
    body.style.cssText = 'white-space:pre-wrap;word-break:break-word;flex:1;min-width:0;';
    row.appendChild(idx);
    row.appendChild(timeEl);
    row.appendChild(body);
    scroll.appendChild(row);
  });
  root.appendChild(scroll);
  scroll.scrollTop = 0;
  return root;
}

export interface NoticesPanelOptions {
  /** Attach query + notices to SQL Assistant (notebook result → extension host) */
  onAskAssistant?: () => void;
}

export function renderNoticesPanel(
  messages: readonly NoticeLogEntry[],
  options?: NoticesPanelOptions,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--vscode-editor-background);';

  let lastFiltered: NoticeEntry[] = [];

  const searchRow = document.createElement('div');
  searchRow.style.cssText =
    'flex-shrink:0;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Filter notices…';
  searchInput.setAttribute('aria-label', 'Filter notices');
  searchInput.autocomplete = 'off';
  searchInput.style.cssText = `
    flex:1;
    min-width:0;
    padding:6px 10px;
    font-size:12px;
    font-family:var(--vscode-font-family);
    border:1px solid var(--vscode-input-border);
    background:var(--vscode-input-background);
    color:var(--vscode-input-foreground);
    border-radius:4px;
  `;

  const countBadge = document.createElement('span');
  countBadge.style.cssText =
    'font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;';

  const copyBtn = createButton('⎘ Copy', true, 'neutral');
  copyBtn.title = 'Copy filtered notices as text';
  const copyDefaultLabel = '⎘ Copy';

  const aiBtn = createButton('✦ Ask AI', true, 'ai');
  aiBtn.title = 'Attach query and notices to SQL Assistant';
  if (!options?.onAskAssistant) {
    aiBtn.style.display = 'none';
  }
  aiBtn.addEventListener('click', () => {
    options?.onAskAssistant?.();
  });

  copyBtn.addEventListener('click', () => {
    if (lastFiltered.length === 0) {
      return;
    }
    const text = lastFiltered
      .map((e) => {
        const ts = formatNoticeLogTime(e.receivedAt);
        const timePart = ts === '—' ? '' : `[${ts}] `;
        return `${e.order}. ${timePart}${e.text}`;
      })
      .join('\n\n');
    void navigator.clipboard.writeText(text).then(
      () => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = copyDefaultLabel;
        }, COPY_FEEDBACK_MS);
      },
      (err: unknown) => {
        console.error('[NoticesPanel] Copy to clipboard failed', err);
      },
    );
  });

  searchRow.appendChild(searchInput);
  searchRow.appendChild(countBadge);
  searchRow.appendChild(copyBtn);
  searchRow.appendChild(aiBtn);
  wrapper.appendChild(searchRow);

  const listRegion = document.createElement('div');
  listRegion.style.cssText =
    'flex:1;overflow:auto;padding:0;min-height:0;font-family:var(--vscode-editor-font-family);font-size:12px;';
  listRegion.setAttribute('role', 'region');
  listRegion.setAttribute('aria-label', 'Notices');

  const renderList = (query: string) => {
    listRegion.innerHTML = '';
    const filtered = filterNoticeEntries(messages, query);
    const displayRows = newestFirstNoticeEntries(filtered);
    lastFiltered = displayRows;

    const canCopy = filtered.length > 0;
    (copyBtn as HTMLButtonElement).disabled = !canCopy;
    copyBtn.title = canCopy ? 'Copy filtered notices as text' : 'Nothing to copy';

    const canAskAi = Boolean(options?.onAskAssistant && messages.length > 0);
    (aiBtn as HTMLButtonElement).disabled = !canAskAi;
    aiBtn.title = canAskAi
      ? 'Attach query and notices to SQL Assistant'
      : 'No notices to send';

    countBadge.textContent =
      messages.length === 0
        ? ''
        : filtered.length === messages.length
          ? `${messages.length} notice${messages.length === 1 ? '' : 's'}`
          : `${filtered.length} of ${messages.length}`;

    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:16px 12px;color:var(--vscode-descriptionForeground);';
      empty.textContent =
        'No notices for this execution. Use PL/pgSQL RAISE NOTICE to emit notices.';
      listRegion.appendChild(empty);
      return;
    }

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:16px 12px;color:var(--vscode-descriptionForeground);';
      empty.textContent = 'No notices match your search.';
      listRegion.appendChild(empty);
      return;
    }

    const ol = document.createElement('ol');
    ol.style.cssText = 'margin:0;padding:0;list-style:none;';

    displayRows.forEach((entry) => {
      const li = document.createElement('li');
      li.style.cssText = `
        display:flex;
        gap:10px;
        padding:8px 12px;
        border-bottom:1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
        align-items:flex-start;
      `;
      const idx = document.createElement('span');
      idx.textContent = String(entry.order);
      idx.style.cssText = `
        flex-shrink:0;
        min-width:2.5em;
        font-variant-numeric:tabular-nums;
        color:var(--vscode-descriptionForeground);
        opacity:0.85;
      `;
      const timeEl = document.createElement('span');
      timeEl.textContent = formatNoticeLogTime(entry.receivedAt);
      timeEl.style.cssText = `
        flex-shrink:0;
        min-width:11.5em;
        font-variant-numeric:tabular-nums;
        color:color-mix(in srgb, var(--vscode-descriptionForeground) 88%, var(--vscode-editor-foreground));
        opacity:0.92;
      `;
      timeEl.title = entry.receivedAt || '';
      const body = document.createElement('div');
      body.textContent = entry.text;
      body.style.cssText = 'white-space:pre-wrap;word-break:break-word;flex:1;min-width:0;';
      li.appendChild(idx);
      li.appendChild(timeEl);
      li.appendChild(body);
      ol.appendChild(li);
    });

    listRegion.appendChild(ol);
  };

  searchInput.addEventListener('input', () => {
    renderList(searchInput.value);
  });

  renderList('');
  wrapper.appendChild(listRegion);

  return wrapper;
}
