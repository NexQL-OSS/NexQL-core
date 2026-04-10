/**
 * TransposeView.ts
 * Flips rows and columns for wide-row inspection.
 * Limited to MAX_ROWS_TO_TRANSPOSE rows to avoid UI overflow.
 */

export const MAX_ROWS_TO_TRANSPOSE = 100;

export interface TransposeResult {
  columns: string[];   // ['Column', 'Row 0', 'Row 1', ...]
  rows: any[];         // One row per original column
}

export function transposeResult(
  originalColumns: string[],
  originalRows: any[]
): TransposeResult | { error: string } {
  if (originalRows.length > MAX_ROWS_TO_TRANSPOSE) {
    return {
      error: `Transpose is limited to ${MAX_ROWS_TO_TRANSPOSE} rows. Current result has ${originalRows.length} rows.`
    };
  }

  const headerRow: string[] = ['Column', ...originalRows.map((_, i) => `Row ${i + 1}`)];

  const transposedRows = originalColumns.map(col => {
    const rowObj: Record<string, any> = { Column: col };
    originalRows.forEach((row, i) => {
      rowObj[`Row ${i + 1}`] = row[col];
    });
    return rowObj;
  });

  return {
    columns: headerRow,
    rows: transposedRows,
  };
}

/**
 * Creates a transposed table element directly (lightweight, no full TableRenderer)
 */
export function renderTransposeTable(
  columns: string[],
  rows: any[],
  formatValue: (v: any) => string
): HTMLElement {
  const result = transposeResult(columns, rows);

  if ('error' in result) {
    const err = document.createElement('div');
    err.style.cssText = 'padding:12px;color:var(--vscode-errorForeground);font-size:12px;';
    err.textContent = result.error;
    return err;
  }

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'overflow:auto;max-height:60vh;';

  const table = document.createElement('table');
  table.style.cssText = `
    border-collapse:collapse;
    font-size:12px;
    width:100%;
    font-variant-numeric:tabular-nums;
  `;

  // Header row
  const thead = document.createElement('thead');
  const headerTr = document.createElement('tr');
  result.columns.forEach((col, i) => {
    const th = document.createElement('th');
    th.textContent = col;
    th.style.cssText = `
      padding:4px 8px;
      text-align:left;
      background:var(--vscode-editor-background);
      border-bottom:2px solid var(--vscode-widget-border);
      font-size:11px;font-weight:600;
      color:var(--vscode-descriptionForeground);
      position:sticky;top:0;
      ${i === 0 ? 'position:sticky;left:0;z-index:2;background:var(--vscode-editor-background);border-right:1px solid var(--vscode-widget-border);' : ''}
    `;
    headerTr.appendChild(th);
  });
  thead.appendChild(headerTr);
  table.appendChild(thead);

  // Data rows
  const tbody = document.createElement('tbody');
  result.rows.forEach((row, rowIdx) => {
    const tr = document.createElement('tr');
    tr.style.background = rowIdx % 2 === 0 ? '' : 'rgba(128,128,128,0.04)';

    result.columns.forEach((col, colIdx) => {
      const td = document.createElement('td');
      const v = row[col];

      if (colIdx === 0) {
        // Column name cell
        td.style.cssText = `
          padding:4px 8px;
          font-weight:600;
          font-size:11px;
          color:var(--vscode-descriptionForeground);
          border-right:1px solid var(--vscode-widget-border);
          border-bottom:1px solid rgba(128,128,128,0.1);
          position:sticky;left:0;
          background:var(--vscode-editor-background);
          white-space:nowrap;
        `;
        td.textContent = v;
      } else {
        td.style.cssText = `
          padding:4px 8px;
          border-bottom:1px solid rgba(128,128,128,0.1);
          max-width:200px;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          color:${v === null || v === undefined ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-editor-foreground)'};
        `;
        td.textContent = v === null || v === undefined ? 'NULL' : formatValue(v);
        if (v !== null && v !== undefined) {
          td.title = String(v);
        }
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}
