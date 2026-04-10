/**
 * ResultTabStrip.ts
 * Maintains a history of result sets per notebook cell output element.
 * Allows users to switch between previous results within the same cell.
 */

import { ResultHistoryEntry } from '../../common/types';

const MAX_HISTORY = 5;

// WeakMap keyed by the output container element — cleared by GC when element is removed
const historyStore = new WeakMap<Element, ResultHistoryEntry[]>();

export function getResultHistory(element: Element): ResultHistoryEntry[] {
  return historyStore.get(element) || [];
}

export function addResultToHistory(element: Element, entry: ResultHistoryEntry): ResultHistoryEntry[] {
  const existing = historyStore.get(element) || [];
  const updated = [entry, ...existing].slice(0, MAX_HISTORY);
  historyStore.set(element, updated);
  return updated;
}

/**
 * Renders the tab strip and returns the selected history entry.
 * Returns null if only one result (no tabs needed).
 */
export function renderTabStrip(
  container: HTMLElement,
  history: ResultHistoryEntry[],
  activeIndex: number,
  onSelect: (index: number) => void
): HTMLElement | null {
  if (history.length <= 1) { return null; }

  const strip = document.createElement('div');
  strip.style.cssText = `
    display:flex;
    align-items:center;
    gap:0;
    background:var(--vscode-tab-inactiveBackground, #2d2d2d);
    border-bottom:1px solid var(--vscode-widget-border);
    overflow-x:auto;
    scrollbar-width:thin;
    flex-shrink:0;
  `;

  history.forEach((entry, i) => {
    const tab = document.createElement('div');
    const isActive = i === activeIndex;
    const elapsed = Date.now() - entry.timestamp;
    const timeAgo = formatTimeAgo(elapsed);
    const rowCount = entry.rowCount ?? (entry.rows?.length ?? 0);
    const label = entry.command
      ? `${entry.command} · ${rowCount.toLocaleString()} rows`
      : `${rowCount.toLocaleString()} rows`;

    tab.style.cssText = `
      padding:5px 12px;
      font-size:11px;
      cursor:pointer;
      white-space:nowrap;
      border-right:1px solid var(--vscode-widget-border);
      color:${isActive ? 'var(--vscode-tab-activeForeground)' : 'var(--vscode-tab-inactiveForeground)'};
      background:${isActive ? 'var(--vscode-tab-activeBackground)' : 'transparent'};
      border-bottom:${isActive ? '2px solid var(--vscode-focusBorder)' : '2px solid transparent'};
      user-select:none;
      display:flex;flex-direction:column;gap:1px;
    `;

    const labelDiv = document.createElement('div');
    labelDiv.textContent = i === 0 ? `▶ ${label}` : label;
    labelDiv.style.fontWeight = isActive ? '500' : '400';

    const metaDiv = document.createElement('div');
    metaDiv.textContent = `${timeAgo}${entry.executionTime ? ` · ${entry.executionTime}ms` : ''}`;
    metaDiv.style.cssText = 'font-size:9px;color:var(--vscode-descriptionForeground);';

    tab.appendChild(labelDiv);
    tab.appendChild(metaDiv);

    tab.addEventListener('click', () => onSelect(i));
    tab.addEventListener('mouseenter', () => {
      if (!isActive) { tab.style.background = 'var(--vscode-list-hoverBackground)'; }
    });
    tab.addEventListener('mouseleave', () => {
      if (!isActive) { tab.style.background = 'transparent'; }
    });

    strip.appendChild(tab);
  });

  // "Clear history" button at end
  const clearBtn = document.createElement('div');
  clearBtn.textContent = '⊗';
  clearBtn.title = 'Clear result history';
  clearBtn.style.cssText = `
    padding:5px 10px;cursor:pointer;
    color:var(--vscode-descriptionForeground);
    font-size:14px;line-height:1;
    margin-left:auto;
  `;
  clearBtn.addEventListener('click', () => {
    historyStore.delete(container);
    onSelect(0); // Re-render with cleared history
  });
  strip.appendChild(clearBtn);

  return strip;
}

function formatTimeAgo(ms: number): string {
  if (ms < 60000) { return 'just now'; }
  if (ms < 3600000) { return `${Math.floor(ms / 60000)}m ago`; }
  return `${Math.floor(ms / 3600000)}h ago`;
}
