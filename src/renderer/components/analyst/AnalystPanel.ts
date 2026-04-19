/**
 * In-result analyst tools: column summaries, histogram, pivot (client-side).
 */

import { ChartRenderOptions } from '../../../common/types';
import { buildHistogram } from '../../../features/analyst/histogram';
import { computeColumnStats } from '../../../features/analyst/columnAggregates';
import { DISTINCT_COUNT_CAP } from '../../../features/analyst/constants';
import { computePivot, type PivotAgg } from '../../../features/analyst/pivot';
import { ChartRenderer } from '../chart/ChartRenderer';
import { detectNumericColumns } from '../chart/ChartControls';

const HIST_COL_BUCKET = '__pg_hist_bucket';
const HIST_COL_COUNT = '__pg_hist_count';

export interface AnalystPanelProps {
  columns: string[];
  rows: Record<string, unknown>[];
  columnTypes?: Record<string, string>;
}

function makeSectionTitle(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  h.style.cssText =
    'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin:12px 0 8px 0;color:var(--vscode-descriptionForeground);';
  return h;
}

function makeTable(): HTMLTableElement {
  const table = document.createElement('table');
  table.style.cssText = `
    border-collapse:collapse;
    font-size:12px;
    width:100%;
    font-variant-numeric:tabular-nums;
  `;
  return table;
}

function makeSelect(
  label: string,
  options: { value: string; text: string }[],
  value: string,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  lbl.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', label);
  sel.style.cssText =
    'padding:4px 6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;font-size:12px;max-width:100%;';
  options.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.text;
    if (o.value === value) {
      opt.selected = true;
    }
    sel.appendChild(opt);
  });
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

function formatStatCell(v: number | undefined): string {
  if (v === undefined) {
    return '—';
  }
  if (Number.isInteger(v) && Math.abs(v) < 1e15) {
    return v.toLocaleString();
  }
  return v.toPrecision(6);
}

export function renderAnalystPanel(props: AnalystPanelProps): HTMLElement {
  const { columns, rows, columnTypes } = props;
  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'flex:1;overflow:auto;display:flex;flex-direction:column;padding:8px 12px;gap:4px;max-height:70vh;';

  if (columns.length === 0 || rows.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:12px;color:var(--vscode-descriptionForeground);font-size:12px;';
    empty.textContent = 'No rows to analyze.';
    wrapper.appendChild(empty);
    return wrapper;
  }

  // ── Summary ─────────────────────────────────────────────────────
  wrapper.appendChild(makeSectionTitle('Column summary'));
  const stats = computeColumnStats(rows, columns, columnTypes);
  const summaryTable = makeTable();
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const headers = ['Column', 'Non-null', 'Nulls', 'Distinct', 'Min', 'Max', 'Sum', 'Avg'];
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.cssText =
      'padding:4px 8px;text-align:left;border-bottom:1px solid var(--vscode-widget-border);font-size:11px;color:var(--vscode-descriptionForeground);';
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  summaryTable.appendChild(thead);
  const tb = document.createElement('tbody');
  for (const s of stats) {
    const tr = document.createElement('tr');
    const distinctStr = s.distinctCapped ? `${DISTINCT_COUNT_CAP - 1}+` : String(s.distinctCount);
    const cells = [
      s.column,
      String(s.nonNullCount),
      String(s.nullCount),
      distinctStr,
      s.numeric ? formatStatCell(s.numeric.min) : '—',
      s.numeric ? formatStatCell(s.numeric.max) : '—',
      s.numeric ? formatStatCell(s.numeric.sum) : '—',
      s.numeric ? formatStatCell(s.numeric.avg) : '—',
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      td.style.cssText = `padding:4px 8px;border-bottom:1px solid var(--vscode-widget-border);font-size:12px;${i === 0 ? 'font-weight:500;' : ''}`;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  summaryTable.appendChild(tb);
  wrapper.appendChild(summaryTable);

  // ── Histogram ────────────────────────────────────────────────────
  wrapper.appendChild(makeSectionTitle('Histogram'));
  const numericCols = detectNumericColumns(columns, rows, columnTypes);
  const histSection = document.createElement('div');
  histSection.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  if (numericCols.length === 0) {
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);';
    msg.textContent = 'No numeric columns detected for histogram.';
    histSection.appendChild(msg);
  } else {
    const initialCol = numericCols[0];
    const histSelectWrap = makeSelect(
      'Value column',
      numericCols.map((c) => ({ value: c, text: c })),
      initialCol,
    );
    const sel = histSelectWrap.querySelector('select') as HTMLSelectElement;

    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'position:relative;height:220px;min-height:180px;';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', 'Histogram chart');
    canvasWrap.appendChild(canvas);
    const chartRenderer = new ChartRenderer(canvas);

    const renderHist = () => {
      const col = sel.value;
      const h = buildHistogram(rows, col, {});
      chartRenderer.destroy();
      if (h.error) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);padding:8px 0;';
        note.textContent = h.error;
        canvasWrap.replaceChildren(note);
        return;
      }
      if (h.bucketLabels.length === 0) {
        canvasWrap.replaceChildren(canvas);
        return;
      }
      canvasWrap.replaceChildren(canvas);
      const fakeRows = h.bucketLabels.map((label, i) => ({
        [HIST_COL_BUCKET]: label,
        [HIST_COL_COUNT]: h.counts[i],
      }));
      const config: ChartRenderOptions = {
        type: 'bar',
        xAxisCol: HIST_COL_BUCKET,
        yAxisCols: [HIST_COL_COUNT],
        numericCols: [HIST_COL_COUNT],
        chartTitle: `Histogram · ${col} (${h.validCount} values)`,
        sortBy: 'none',
        showGridX: true,
        showGridY: true,
        showLabels: true,
        legendPosition: 'hidden',
        textColor: '#ccc',
      };
      chartRenderer.render(fakeRows, config);
    };

    sel.addEventListener('change', renderHist);
    histSection.appendChild(histSelectWrap);
    histSection.appendChild(canvasWrap);
    renderHist();
  }
  wrapper.appendChild(histSection);

  // ── Pivot ────────────────────────────────────────────────────────
  wrapper.appendChild(makeSectionTitle('Pivot'));
  const pivotWrap = document.createElement('div');
  pivotWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  if (columns.length < 2) {
    const needCols = document.createElement('div');
    needCols.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);';
    needCols.textContent = 'Pivot needs at least two columns in the result.';
    pivotWrap.appendChild(needCols);
    wrapper.appendChild(pivotWrap);
    return wrapper;
  }

  const colOpts = columns.map((c) => ({ value: c, text: c }));
  const rowSelWrap = makeSelect('Rows', colOpts, columns[0]);
  const colSelWrap = makeSelect('Columns', colOpts, columns[1]);
  const valSelWrap = makeSelect('Value (for sum/avg/min/max)', [{ value: '', text: '—' }, ...numericCols.map((c) => ({ value: c, text: c }))], numericCols[0] ?? '');
  const aggSelWrap = makeSelect('Aggregation', [
    { value: 'count', text: 'Count rows' },
    { value: 'sum', text: 'Sum' },
    { value: 'avg', text: 'Average' },
    { value: 'min', text: 'Min' },
    { value: 'max', text: 'Max' },
  ], 'count');

  const pivotBtn = document.createElement('button');
  pivotBtn.type = 'button';
  pivotBtn.textContent = 'Build pivot';
  pivotBtn.style.cssText =
    'align-self:flex-start;padding:4px 12px;font-size:12px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-contrastBorder, transparent);border-radius:3px;';
  pivotBtn.setAttribute('aria-label', 'Build pivot table');

  const pivotOut = document.createElement('div');
  pivotOut.style.cssText = 'overflow:auto;max-height:280px;';

  const runPivot = () => {
    pivotOut.innerHTML = '';
    const rowDim = (rowSelWrap.querySelector('select') as HTMLSelectElement).value;
    const colDim = (colSelWrap.querySelector('select') as HTMLSelectElement).value;
    const valRaw = (valSelWrap.querySelector('select') as HTMLSelectElement).value;
    const agg = (aggSelWrap.querySelector('select') as HTMLSelectElement).value as PivotAgg;

    const result = computePivot(rows, rowDim, colDim, valRaw || undefined, agg);
    if ('error' in result) {
      const err = document.createElement('div');
      err.style.cssText = 'font-size:12px;color:var(--vscode-errorForeground);';
      err.textContent = result.error;
      pivotOut.appendChild(err);
      return;
    }

    const table = makeTable();
    const ptr = document.createElement('thead');
    const hRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.textContent = `${rowDim} \\ ${colDim}`;
    corner.style.cssText =
      'padding:4px 8px;text-align:left;border-bottom:1px solid var(--vscode-widget-border);position:sticky;left:0;background:var(--vscode-editor-background);z-index:1;';
    hRow.appendChild(corner);
    for (const cl of result.colLabels) {
      const th = document.createElement('th');
      th.textContent = cl;
      th.style.cssText =
        'padding:4px 8px;text-align:right;border-bottom:1px solid var(--vscode-widget-border);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;';
      hRow.appendChild(th);
    }
    ptr.appendChild(hRow);
    table.appendChild(ptr);

    const pbody = document.createElement('tbody');
    for (let i = 0; i < result.rowLabels.length; i++) {
      const tr = document.createElement('tr');
      const rowH = document.createElement('th');
      rowH.textContent = result.rowLabels[i];
      rowH.style.cssText =
        'padding:4px 8px;text-align:left;border-bottom:1px solid var(--vscode-widget-border);font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;';
      tr.appendChild(rowH);
      for (let j = 0; j < result.colLabels.length; j++) {
        const td = document.createElement('td');
        const v = result.cells[i][j];
        td.textContent = v === null || v === undefined ? '' : formatStatCell(v);
        td.style.cssText =
          'padding:4px 8px;text-align:right;border-bottom:1px solid var(--vscode-widget-border);font-size:12px;';
        tr.appendChild(td);
      }
      pbody.appendChild(tr);
    }
    table.appendChild(pbody);
    pivotOut.appendChild(table);
  };

  pivotBtn.addEventListener('click', runPivot);

  pivotWrap.appendChild(rowSelWrap);
  pivotWrap.appendChild(colSelWrap);
  pivotWrap.appendChild(aggSelWrap);
  pivotWrap.appendChild(valSelWrap);
  pivotWrap.appendChild(pivotBtn);
  pivotWrap.appendChild(pivotOut);
  wrapper.appendChild(pivotWrap);

  return wrapper;
}
