/**
 * ColumnStats.ts
 * Computes and displays column statistics as a hover tooltip on column headers.
 * Computed client-side from the current result rows (no additional DB query needed for typical result sizes).
 */

import { ColumnStatsData } from '../../common/types';

export class ColumnStatsTooltip {
  private tooltip: HTMLElement;
  private currentAnchor: HTMLElement | null = null;

  constructor() {
    this.tooltip = document.createElement('div');
    this.tooltip.style.cssText = `
      position:fixed;
      background:var(--vscode-editorHoverWidget-background, #252526);
      border:1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius:4px;
      padding:10px 12px;
      font-size:11px;
      color:var(--vscode-editor-foreground);
      z-index:9999;
      pointer-events:none;
      min-width:180px;
      max-width:280px;
      box-shadow:0 4px 12px rgba(0,0,0,0.4);
      display:none;
      line-height:1.6;
    `;
    document.body.appendChild(this.tooltip);
  }

  /**
   * Compute stats from in-memory rows (fast, client-side)
   */
  static compute(rows: any[], column: string): ColumnStatsData {
    let nullCount = 0;
    const distinctSet = new Set<string>();
    let min: any = undefined;
    let max: any = undefined;
    let totalLength = 0;
    let stringCount = 0;

    for (const row of rows) {
      const v = row[column];
      if (v === null || v === undefined || v === '') {
        nullCount++;
        continue;
      }
      distinctSet.add(String(v));

      // Numeric min/max
      const num = Number(v);
      if (!isNaN(num)) {
        if (min === undefined || num < min) { min = num; }
        if (max === undefined || num > max) { max = num; }
      } else {
        // String min/max (lexicographic)
        const s = String(v);
        if (min === undefined || s < String(min)) { min = s; }
        if (max === undefined || s > String(max)) { max = s; }
        totalLength += s.length;
        stringCount++;
      }
    }

    return {
      column,
      nullCount,
      nullPct: rows.length > 0 ? (nullCount / rows.length) * 100 : 0,
      distinctCount: distinctSet.size,
      min,
      max,
      avgLength: stringCount > 0 ? totalLength / stringCount : undefined,
      totalRows: rows.length,
    };
  }

  private formatValue(v: any): string {
    if (v === undefined) { return 'N/A'; }
    if (typeof v === 'number') {
      return v % 1 === 0 ? v.toString() : v.toFixed(4);
    }
    const s = String(v);
    return s.length > 30 ? s.slice(0, 30) + '...' : s;
  }

  show(anchor: HTMLElement, stats: ColumnStatsData) {
    this.currentAnchor = anchor;
    const rect = anchor.getBoundingClientRect();
    const nullBar = Math.round(stats.nullPct);
    const nonNullBar = 100 - nullBar;

    this.tooltip.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;color:var(--vscode-editor-foreground);">${stats.column}</div>
      <div style="display:grid;grid-template-columns:auto 1fr auto;gap:3px 8px;align-items:center;">
        <span style="color:var(--vscode-descriptionForeground);">Rows</span>
        <div></div>
        <span style="font-variant-numeric:tabular-nums;">${stats.totalRows.toLocaleString()}</span>

        <span style="color:var(--vscode-descriptionForeground);">Nulls</span>
        <div style="height:6px;background:var(--vscode-widget-border);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${nullBar}%;background:var(--vscode-errorForeground);opacity:0.7;transition:width 0.2s;"></div>
        </div>
        <span style="font-variant-numeric:tabular-nums;">${stats.nullCount.toLocaleString()} (${stats.nullPct.toFixed(1)}%)</span>

        <span style="color:var(--vscode-descriptionForeground);">Distinct</span>
        <div style="height:6px;background:var(--vscode-widget-border);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${nonNullBar}%;background:var(--vscode-textLink-foreground);opacity:0.7;transition:width 0.2s;"></div>
        </div>
        <span style="font-variant-numeric:tabular-nums;">${stats.distinctCount.toLocaleString()}</span>

        <span style="color:var(--vscode-descriptionForeground);">Min</span>
        <div></div>
        <span style="font-variant-numeric:tabular-nums;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${stats.min}">${this.formatValue(stats.min)}</span>

        <span style="color:var(--vscode-descriptionForeground);">Max</span>
        <div></div>
        <span style="font-variant-numeric:tabular-nums;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${stats.max}">${this.formatValue(stats.max)}</span>
        ${stats.avgLength !== undefined ? `
        <span style="color:var(--vscode-descriptionForeground);">Avg len</span>
        <div></div>
        <span style="font-variant-numeric:tabular-nums;">${stats.avgLength.toFixed(1)}</span>
        ` : ''}
      </div>
    `;

    // Position below the header cell
    const top = rect.bottom + 4;
    const left = Math.min(rect.left, window.innerWidth - 290);
    this.tooltip.style.top = `${top}px`;
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.display = 'block';
  }

  hide() {
    this.tooltip.style.display = 'none';
    this.currentAnchor = null;
  }

  destroy() {
    document.body.removeChild(this.tooltip);
  }
}

/**
 * Attach stats tooltip to a column header element
 */
export function attachColumnStatsTooltip(
  headerCell: HTMLElement,
  column: string,
  getRows: () => any[],
  tooltip: ColumnStatsTooltip,
  delayMs = 600
) {
  let hoverTimer: any;

  headerCell.style.cursor = 'help';
  headerCell.title = 'Hover for column statistics';

  headerCell.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => {
      const rows = getRows();
      if (rows.length === 0) { return; }
      const stats = ColumnStatsTooltip.compute(rows, column);
      tooltip.show(headerCell, stats);
    }, delayMs);
  });

  headerCell.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    tooltip.hide();
  });
}
