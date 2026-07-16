import { createButton } from '../ui';
import { columnTypeSupportsPrettyPreview, formatValue } from '../../utils/formatting';
import { RESULT_TOOLBAR_ICON_CLASS, resultToolbarSvg } from '../ResultToolbarUi';
import {
  TableInfo,
  TableRenderOptions,
  FkColumnInfo,
  FilterState,
  BYTEA_DISPLAY_DEFAULT,
  ByteaDisplayFormat,
} from '../../../common/types';
import { createCellEditor } from './CellEditors';
import { FilterBar } from './FilterBar';
import { ColumnStatsTooltip, attachColumnStatsTooltip } from '../ColumnStats';

export interface TableEvents {
  onSelectionChange?: (selectedIndices: Set<number>) => void;
  onDataChange?: (rowIndex: number, col: string, newValue: any, originalValue: any) => void;
  onExplainError?: (error: string, query: string) => void;
  onFixQuery?: (error: string, query: string) => void;
  onInsertRow?: (values: Record<string, any>, tempId: string) => void;
  onFkLookup?: (
    requestId: string,
    fkSchema: string,
    fkTable: string,
    fkColumn: string,
    searchText: string,
    callback: (rows: any[], cols: string[]) => void,
  ) => void;
  onSortChange?: (column: string | null, direction: 'asc' | 'desc' | 'none') => void;
  onFilterChange?: (filterState: FilterState) => void;
}

interface PendingInsertRow {
  tempId: string;
  values: Record<string, any>;
  status: 'pending' | 'saving' | 'error';
  errorMsg?: string;
}

interface RowEntry {
  row: any;
  sourceIndex: number;
}

export class TableRenderer {
  private mainContainer: HTMLElement;
  private tableContainer: HTMLElement;
  private tableBody: HTMLElement | null = null;
  private loadMoreObserver: IntersectionObserver | null = null;
  private loadMoreSentinel: HTMLElement | null = null;

  // Core state
  private columns: string[] = [];
  private rows: any[] = [];
  private displayRows: any[] = []; // rows after sort+filter applied
  private displayRowSourceIndices: number[] = [];
  private originalRows: any[] = [];
  private columnTypes: Record<string, string> = {};
  private tableInfo?: TableInfo;
  private foreignKeys: FkColumnInfo[] = [];
  private selectedIndices: Set<number> = new Set();
  private modifiedCells: Map<string, { originalValue: any; newValue: any }> = new Map();
  private rowsMarkedForDeletion: Set<number> = new Set();
  private pendingInserts: PendingInsertRow[] = [];

  // Sort & filter state
  private sortColumn: string | null = null;
  private sortDirection: 'asc' | 'desc' | 'none' = 'none';
  private filterState: FilterState = { globalQuery: '', clauses: [] };

  // UI sub-components
  private filterBar: FilterBar | null = null;
  private statsTooltip: ColumnStatsTooltip | null = null;

  private byteaDisplayFormat: ByteaDisplayFormat = BYTEA_DISPLAY_DEFAULT;

  /** First visible row label (1-based); used with sliding-window results for absolute # column. */
  private rowNumberBaseline = 1;

  /** Columns using locale / indented “pretty” cell display (header eye toggle). */
  private columnPrettyPreview = new Set<string>();

  /** Set `true` to show the header eye toggle again (logic below stays wired). */
  private static readonly SHOW_COLUMN_PREVIEW_HEADER_TOGGLE = false;

  private renderedCount = 0;
  private readonly CHUNK_SIZE = 50;
  private currentlyEditingCell: HTMLElement | null = null;

  /** Below this many combined data + pending rows, use chunk + IntersectionObserver (legacy). */
  private static readonly VIRTUAL_ROW_THRESHOLD = 100;
  /** Minimum rows to keep in the virtual window (avoids tiny first paint when clientHeight is still small). */
  private static readonly VIRTUAL_MIN_VIEWPORT_ROWS = 50;
  /** Extra rows above/below viewport as a multiple of measured viewport rows (2× viewport buffer). */
  private static readonly VIRTUAL_VIEWPORT_BUFFER_MULTIPLIER = 2;
  private static readonly DEFAULT_DATA_ROW_HEIGHT_PX = 30;
  private static readonly DEFAULT_PENDING_ROW_HEIGHT_PX = 40;

  private virtualScrollEnabled = false;
  private scrollListenerAttached = false;
  private virtualScrollRaf: number | null = null;
  private dataRowHeightEstimate = TableRenderer.DEFAULT_DATA_ROW_HEIGHT_PX;
  private lastVirtualRange: { start: number; end: number } | null = null;

  // Events
  private events: TableEvents = {};

  constructor(container: HTMLElement, events: TableEvents = {}) {
    this.mainContainer = container;
    this.events = events;

    this.tableContainer = document.createElement('div');
    this.tableContainer.style.overflow = 'auto';
    this.tableContainer.style.flex = '1';
    this.tableContainer.style.width = '100%';
    this.tableContainer.style.position = 'relative';
    this.tableContainer.style.minHeight = '0';

    this.mainContainer.appendChild(this.tableContainer);
  }

  public render(options: TableRenderOptions) {
    if (!this.mainContainer.contains(this.tableContainer)) {
      this.mainContainer.appendChild(this.tableContainer);
    }

    // Remove any leftover inline editor panels from previous edits
    this.cleanupInlineEditors();

    this.columns = options.columns;
    this.rows = options.rows;
    this.originalRows = options.originalRows;
    this.columnTypes = options.columnTypes || {};
    this.tableInfo = options.tableInfo;
    this.foreignKeys = options.foreignKeys || [];
    this.byteaDisplayFormat = options.byteaDisplayFormat ?? BYTEA_DISPLAY_DEFAULT;
    this.rowNumberBaseline =
      typeof options.rowNumberBaseline === 'number' && Number.isFinite(options.rowNumberBaseline)
        ? Math.max(1, Math.floor(options.rowNumberBaseline))
        : 1;
    this.selectedIndices = options.initialSelectedIndices
      ? new Set(options.initialSelectedIndices)
      : new Set();
    this.modifiedCells = options.modifiedCells || new Map();
    this.rowsMarkedForDeletion = options.rowsMarkedForDeletion || new Set();

    // Preserve sort/filter from options if provided
    if (options.sortState) {
      this.sortColumn = options.sortState.column;
      this.sortDirection = options.sortState.direction;
    }
    if (options.filterState) {
      this.filterState = this.cloneFilterState(options.filterState);
    }

    // Apply sort + filter to produce displayRows
    this.applyTransforms();

    this.teardownVirtualScroll();
    this.dataRowHeightEstimate = TableRenderer.DEFAULT_DATA_ROW_HEIGHT_PX;

    // Reset DOM
    this.tableContainer.innerHTML = '';
    this.renderedCount = 0;
    this.tableBody = null;
    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect();
      this.loadMoreObserver = null;
    }
    this.loadMoreSentinel = null;

    // Destroy old tooltip
    if (this.statsTooltip) {
      this.statsTooltip.destroy();
      this.statsTooltip = null;
    }

    // Create fresh tooltip instance
    this.statsTooltip = new ColumnStatsTooltip();

    // Remove the previous filter bar before rendering a new one.
    // Table rerenders happen on every filter/edit/sort change, so failing to
    // clear the old bar causes duplicate controls to accumulate.
    const existingFilterBar = this.filterBar?.getElement();
    if (existingFilterBar?.parentElement) {
      existingFilterBar.parentElement.removeChild(existingFilterBar);
    }

    // Render filter bar above the scroll area
    this.filterBar = new FilterBar({
      columns: this.columns,
      rows: this.rows,
      filterState: this.filterState,
      onFilterChange: (state) => {
        this.filterState = this.cloneFilterState(state);
        this.events.onFilterChange?.(state);
        this.applyTransforms();
        this.refreshTableContent();
      },
    });
    this.mainContainer.insertBefore(this.filterBar.getElement(), this.tableContainer);

    if (this.displayRows.length === 0 && this.rows.length === 0) {
      if (this.columns.length === 0) {
        this.renderEmptyState('no-columns');
        return;
      }
      this.createTableStructure();
      this.renderEmptyDataHint();
      return;
    }

    this.createTableStructure();
    if (this.shouldVirtualize()) {
      this.virtualScrollEnabled = true;
      this.renderVirtualInitial();
    } else {
      this.renderNextChunk();
      this.setupInfiniteScroll();
    }
    this.maybeAppendFilterEmptyHint();
  }

  /** Used by the result footer and other host UI to start a new row. */
  public triggerAddRow() {
    this.addPendingRow();
  }

  /** Discard unstaged edits and staged deletions; restore displayed values from originalRows. */
  public revertAllPendingChanges(): void {
    this.cleanupInlineEditors();
    this.modifiedCells.clear();
    this.rowsMarkedForDeletion.clear();
    this.currentlyEditingCell = null;
    const n = Math.min(this.rows.length, this.originalRows.length);
    for (let i = 0; i < n; i++) {
      const row = this.rows[i];
      const orig = this.originalRows[i];
      if (!row || !orig) {
        continue;
      }
      for (const col of this.columns) {
        row[col] = orig[col];
      }
    }
    this.rerenderTable();
  }

  private addPendingRow() {
    const tempId = `insert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const emptyValues: Record<string, any> = {};
    this.columns.forEach((col) => {
      emptyValues[col] = '';
    });
    this.pendingInserts.unshift({ tempId, values: emptyValues, status: 'pending' });
    this.refreshTableContent();
    this.focusPendingInsertRow(tempId);
  }

  private focusPendingInsertRow(tempId: string) {
    requestAnimationFrame(() => {
      const row = this.tableBody?.querySelector(`tr[data-temp-id="${tempId}"]`) as HTMLElement | null;
      if (!row) {
        return;
      }

      this.tableContainer.scrollTop = 0;

      requestAnimationFrame(() => {
        this.tableContainer.scrollTop = 0;

        const firstInput = row.querySelector('input') as HTMLInputElement | null;
        if (firstInput) {
          firstInput.focus({ preventScroll: true });
          firstInput.select();
        }
      });
    });
  }

  private refreshTableContent() {
    this.teardownVirtualScroll();
    this.dataRowHeightEstimate = TableRenderer.DEFAULT_DATA_ROW_HEIGHT_PX;
    this.tableContainer.innerHTML = '';
    this.renderedCount = 0;
    this.tableBody = null;
    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect();
      this.loadMoreObserver = null;
    }
    this.loadMoreSentinel = null;

    if (this.statsTooltip) {
      this.statsTooltip.destroy();
      this.statsTooltip = null;
    }

    this.statsTooltip = new ColumnStatsTooltip();
    this.createTableStructure();
    if (this.shouldVirtualize()) {
      this.virtualScrollEnabled = true;
      this.renderVirtualInitial();
    } else {
      this.renderNextChunk();
      this.setupInfiniteScroll();
    }
    this.maybeAppendFilterEmptyHint();
  }

  /** Apply current sort + filter, storing result in displayRows */
  private applyTransforms() {
    const filteredRows = FilterBar.applyFilter(this.rows, this.filterState, this.columns);
    const filteredRowSet = new Set(filteredRows);
    let result: RowEntry[] = this.rows
      .map((row, sourceIndex) => ({ row, sourceIndex }))
      .filter((entry) => filteredRowSet.has(entry.row));

    // 2. Sort
    if (this.sortColumn && this.sortDirection !== 'none') {
      const col = this.sortColumn;
      const dir = this.sortDirection;
      result = [...result].sort((a, b) => {
        const av = a.row[col];
        const bv = b.row[col];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv));
        return dir === 'asc' ? cmp : -cmp;
      });
    }

    this.displayRows = result.map((entry) => entry.row);
    this.displayRowSourceIndices = result.map((entry) => entry.sourceIndex);
  }

  public updateSelection(indices: Set<number>) {
    this.selectedIndices = indices;
    this.updateRowSelectionStyles();
  }

  /** Called from renderer_v2 when an insertSuccess comes back */
  public replaceInsertRow(tempId: string, actualRow: Record<string, any>) {
    const idx = this.pendingInserts.findIndex((p) => p.tempId === tempId);
    if (idx !== -1) {
      this.pendingInserts.splice(idx, 1);
    }
    // Add the real row to rows array and rerender
    this.rows.push(actualRow);
    this.originalRows.push(JSON.parse(JSON.stringify(actualRow)));
    this.rerenderTable();
  }

  /** Mark a pending insert as failed */
  public markInsertFailed(tempId: string, errorMsg: string) {
    const insert = this.pendingInserts.find((p) => p.tempId === tempId);
    if (insert) {
      insert.status = 'error';
      insert.errorMsg = errorMsg;
      this.rerenderTable();
    }
  }

  private renderEmptyState(kind: 'no-rows' | 'no-columns') {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    wrap.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 24px;text-align:center;max-width:440px;margin:0 auto;';

    const title = document.createElement('div');
    title.style.cssText =
      'font-weight:600;font-size:14px;color:var(--vscode-editor-foreground);letter-spacing:0.02em;';
    title.textContent = kind === 'no-rows' ? 'No rows returned' : 'No columns in result';

    const sub = document.createElement('div');
    sub.style.cssText =
      'font-size:12px;line-height:1.5;color:var(--vscode-descriptionForeground);';
    sub.textContent =
      kind === 'no-rows'
        ? 'Empty result set. Adjust the query or filters if unexpected.'
        : 'No column metadata. Check Messages for errors.';

    wrap.appendChild(title);
    wrap.appendChild(sub);
    this.tableContainer.appendChild(wrap);
  }

  /** When table has columns but zero rows, show "No data" hint row so headers stay visible. */
  private renderEmptyDataHint() {
    if (!this.tableBody) return;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = Math.max(1, this.columns.length + 1);
    td.style.cssText =
      'padding:28px 16px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px;';
    td.textContent = 'No data';
    tr.appendChild(td);
    this.tableBody.appendChild(tr);
  }

  /** When filters hide every row but data exists, show a single hint row (headers stay visible). */
  private maybeAppendFilterEmptyHint() {
    if (!this.tableBody) {
      return;
    }
    if (this.pendingInserts.length > 0) {
      return;
    }
    if (this.displayRows.length !== 0 || this.rows.length === 0) {
      return;
    }
    const tr = document.createElement('tr');
    tr.setAttribute('data-filter-empty', '1');
    const td = document.createElement('td');
    td.colSpan = Math.max(1, this.columns.length + 1);
    td.style.cssText =
      'padding:28px 16px;text-align:center;color:var(--vscode-descriptionForeground);font-size:13px;border-top:1px solid var(--vscode-widget-border);';
    td.setAttribute('role', 'status');
    td.setAttribute('aria-live', 'polite');
    const strong = document.createElement('div');
    strong.style.cssText = 'font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:6px;';
    strong.textContent = 'No rows match the current filter';
    const hint = document.createElement('div');
    hint.style.fontSize = '12px';
    hint.textContent = 'Clear the search box or column filters to see data again.';
    td.appendChild(strong);
    td.appendChild(hint);
    tr.appendChild(td);
    this.tableBody.appendChild(tr);
  }

  private createTableStructure() {
    const table = document.createElement('table');
    table.style.cssText =
      'width:100%;border-collapse:separate;border-spacing:0;font-size:13px;white-space:nowrap;line-height:1.5;';

    const thead = document.createElement('thead');
    this.tableBody = document.createElement('tbody');

    const headerRow = document.createElement('tr');

    // Row number header
    const selectTh = document.createElement('th');
    selectTh.textContent = '#';
    selectTh.setAttribute('scope', 'col');
    selectTh.setAttribute('aria-label', 'Row number');
    selectTh.style.cssText = `
      width:32px;min-width:32px;position:sticky;top:0;left:0;
      background:var(--vscode-editor-background);
      border-bottom:1px solid var(--vscode-widget-border);
      border-right:1px solid var(--vscode-widget-border);
      z-index:20;font-family:monospace;color:var(--vscode-descriptionForeground);
      text-align:right;padding:8px 6px;font-weight:400;user-select:none;
    `;
    headerRow.appendChild(selectTh);

    this.columns.forEach((col) => {
      headerRow.appendChild(this.createHeaderCell(col));
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);
    table.appendChild(this.tableBody);
    this.tableContainer.appendChild(table);
  }

  private createHeaderCell(col: string): HTMLElement {
    const th = document.createElement('th');
    th.setAttribute('data-sortable', 'true');
    th.setAttribute('scope', 'col');

    const colType = this.columnTypes[col] ?? '';
    const isNumeric = this.isNumericColumn(col);

    th.style.cssText = `
      text-align:left;padding:0;
      border-bottom:1px solid var(--vscode-widget-border);
      border-right:1px solid var(--vscode-widget-border);
      position:sticky;top:0;background:var(--vscode-editor-background);
      z-index:10;user-select:none;max-width:400px;cursor:pointer;
      ${isNumeric ? 'text-align:right;' : ''}
    `;

    // Name row
    const nameRow = document.createElement('div');
    nameRow.style.cssText = `
      display:flex;align-items:center;gap:4px;overflow:hidden;
      padding:5px 10px 2px;
      ${isNumeric ? 'flex-direction:row-reverse;' : ''}
    `;

    if (this.tableInfo?.primaryKeys?.includes(col)) {
      const pkIcon = document.createElement('span');
      pkIcon.textContent = '⚿';
      pkIcon.title = 'Primary Key';
      pkIcon.setAttribute('aria-label', 'Primary Key');
      pkIcon.style.cssText = 'color:var(--vscode-textLink-foreground);font-size:11px;flex-shrink:0;';
      nameRow.appendChild(pkIcon);
    }

    if (this.foreignKeys.some((fk) => fk.column === col)) {
      const fkIcon = document.createElement('span');
      fkIcon.textContent = '↗';
      fkIcon.title = 'Foreign Key';
      fkIcon.setAttribute('aria-label', 'Foreign Key');
      fkIcon.style.cssText = 'font-size:10px;opacity:0.6;flex-shrink:0;';
      nameRow.appendChild(fkIcon);
    }

    const colName = document.createElement('span');
    colName.textContent = col;
    colName.style.cssText = 'overflow:hidden;text-overflow:ellipsis;font-weight:600;font-size:12px;color:var(--vscode-editor-foreground);';
    nameRow.appendChild(colName);

    // Sort indicator (pushed to end)
    const sortIcon = document.createElement('span');
    sortIcon.setAttribute('aria-hidden', 'true');
    sortIcon.style.cssText = 'font-size:9px;opacity:0.5;margin-left:auto;flex-shrink:0;';
    if (this.sortColumn === col) {
      sortIcon.textContent = this.sortDirection === 'asc' ? '▲' : '▼';
      sortIcon.style.opacity = '1';
      sortIcon.style.color = 'var(--vscode-textLink-foreground)';
    } else {
      sortIcon.textContent = '⇅';
    }
    nameRow.appendChild(sortIcon);

    // Type row: type label + optional preview toggle (eye), aligned with sort edge
    const typeRow = document.createElement('div');
    typeRow.style.cssText = `
      display:flex;
      align-items:center;
      gap:4px;
      padding:0 10px 4px;
      font-size:10px;
      font-family:var(--vscode-editor-font-family),monospace;
      color:var(--vscode-descriptionForeground);
      opacity:0.75;
      min-height:20px;
    `;

    const typeLabel = document.createElement('span');
    typeLabel.style.cssText = `
      flex:1;
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      ${isNumeric ? 'text-align:right;' : ''}
    `;
    typeLabel.textContent = colType;

    const showPreviewToggle =
      TableRenderer.SHOW_COLUMN_PREVIEW_HEADER_TOGGLE &&
      Boolean(colType) &&
      columnTypeSupportsPrettyPreview(colType);

    let previewBtn: HTMLButtonElement | undefined;
    if (TableRenderer.SHOW_COLUMN_PREVIEW_HEADER_TOGGLE) {
      previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.title = 'Toggle prettified preview for this column';
      previewBtn.setAttribute('aria-label', 'Toggle prettified preview');
      previewBtn.style.cssText = `
      flex-shrink:0;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      width:22px;
      height:22px;
      padding:0;
      border:none;
      border-radius:4px;
      background:transparent;
      color:var(--vscode-descriptionForeground);
      cursor:pointer;
      opacity:0.55;
    `;
      const previewIc = document.createElement('span');
      previewIc.className = RESULT_TOOLBAR_ICON_CLASS;
      previewIc.innerHTML = resultToolbarSvg('previewEye');
      previewBtn.appendChild(previewIc);

      const syncPreviewBtn = () => {
        const on = this.columnPrettyPreview.has(col);
        previewBtn!.setAttribute('aria-pressed', on ? 'true' : 'false');
        previewBtn!.style.opacity = on ? '1' : '0.55';
        previewBtn!.style.color = on ? 'var(--vscode-textLink-foreground)' : 'var(--vscode-descriptionForeground)';
      };
      syncPreviewBtn();

      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.columnPrettyPreview.has(col)) {
          this.columnPrettyPreview.delete(col);
        } else {
          this.columnPrettyPreview.add(col);
        }
        syncPreviewBtn();
        this.rerenderTable();
      });

      previewBtn.addEventListener('mouseenter', () => {
        previewBtn!.style.background =
          'color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 55%, transparent)';
      });
      previewBtn.addEventListener('mouseleave', () => {
        previewBtn!.style.background = 'transparent';
      });
    }

    if (!colType) {
      typeRow.style.display = 'none';
    } else if (showPreviewToggle && previewBtn) {
      if (isNumeric) {
        typeRow.appendChild(previewBtn);
        typeRow.appendChild(typeLabel);
      } else {
        typeRow.appendChild(typeLabel);
        typeRow.appendChild(previewBtn);
      }
    } else {
      typeRow.appendChild(typeLabel);
    }

    th.appendChild(nameRow);
    th.appendChild(typeRow);

    // Sort click handler
    th.addEventListener('click', () => {
      if (this.sortColumn === col) {
        if (this.sortDirection === 'none') {
          this.sortDirection = 'asc';
        } else if (this.sortDirection === 'asc') {
          this.sortDirection = 'desc';
        } else {
          this.sortColumn = null;
          this.sortDirection = 'none';
        }
      } else {
        this.sortColumn = col;
        this.sortDirection = 'asc';
      }
      this.events.onSortChange?.(this.sortColumn, this.sortDirection);
      this.applyTransforms();
      this.rerenderTable();
    });

    // Attach column stats tooltip (hover with delay)
    if (this.statsTooltip) {
      attachColumnStatsTooltip(th, col, () => this.displayRows, this.statsTooltip, 600);
    }

    if (this.sortColumn === col && this.sortDirection !== 'none') {
      th.setAttribute('aria-sort', this.sortDirection === 'asc' ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }

    this.addResizeHandle(th);
    return th;
  }

  /** Returns true if the column's pg type is numeric. */
  private isNumericColumn(col: string): boolean {
    // Strip leading '_' — PG array types are prefixed (e.g. _int4 for integer[])
    const t = (this.columnTypes[col] ?? '').toLowerCase().replace(/^_/, '');
    return /^(int|int2|int4|int8|float|float4|float8|numeric|decimal|double|real|bigint|smallint|serial|bigserial|money)/.test(t);
  }

  private addResizeHandle(th: HTMLElement) {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position:absolute;right:0;top:0;height:100%;width:6px;
      cursor:col-resize;user-select:none;z-index:11;
    `;
    handle.onmouseenter = () => (handle.style.borderRight = '2px solid var(--vscode-focusBorder)');
    handle.onmouseleave = () => (handle.style.borderRight = '');
    th.appendChild(handle);
  }

  private renderNextChunk = () => {
    if (!this.tableBody) return;

    const pendingCount = this.pendingInserts.length;
    const allRows = [...this.pendingInserts.map((p) => p.values), ...this.displayRows];
    const start = this.renderedCount;
    const end = Math.min(start + this.CHUNK_SIZE, allRows.length);
    if (start >= end) {
      if (this.loadMoreSentinel) {
        this.loadMoreSentinel.remove();
        this.loadMoreSentinel = null;
        this.loadMoreObserver?.disconnect();
        this.loadMoreObserver = null;
      }
      return;
    }

    for (let i = start; i < end; i++) {
      if (i < pendingCount) {
        const pending = this.pendingInserts[i];
        if (pending) {
          const tr = this.createPendingInsertRow(pending);
          this.tableBody!.appendChild(tr);
        }
      } else {
        const displayIndex = i - pendingCount;
        const sourceIndex = this.displayRowSourceIndices[displayIndex] ?? displayIndex;
        const tr = this.createRow(this.displayRows[displayIndex], displayIndex, sourceIndex);
        this.tableBody!.appendChild(tr);
      }
    }

    this.renderedCount = end;

    if (this.loadMoreSentinel) {
      this.tableContainer.appendChild(this.loadMoreSentinel);
    }
  };

  /** Row gutter: 4px left border indicating change status */
  private getRowGutterStyle(sourceIndex: number): string {
    if (this.rowsMarkedForDeletion.has(sourceIndex))
      return 'border-left:4px solid var(--vscode-testing-iconFailed,#f44336)';
    const hasEdit = Array.from(this.modifiedCells.keys()).some((k) =>
      k.startsWith(`${sourceIndex}-`),
    );
    if (hasEdit) return 'border-left:4px solid #f59e0b';
    return 'border-left:4px solid transparent';
  }

  private getRowCellStyle(sourceIndex: number, displayIndex: number, cellKind: 'row-number' | 'data'): string {
    if (this.rowsMarkedForDeletion.has(sourceIndex)) {
      return cellKind === 'row-number'
        ? 'background:rgba(244,67,54,0.08);color:var(--vscode-errorForeground);'
        : 'background:rgba(244,67,54,0.08);color:var(--vscode-errorForeground);';
    }

    if (this.selectedIndices.has(sourceIndex)) {
      return cellKind === 'row-number'
        ? 'background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);'
        : 'background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);';
    }

    if (cellKind === 'row-number') {
      return 'background:var(--vscode-editor-background);color:var(--vscode-descriptionForeground);';
    }

    const base = displayIndex % 2 === 0 ? 'transparent' : 'var(--vscode-keybindingTable-rowsBackground)';
    return `background:${base};color:var(--vscode-editor-foreground);`;
  }

  private applyCellStyle(cell: HTMLElement, sourceIndex: number, displayIndex: number, cellKind: 'row-number' | 'data'): void {
    const style = this.getRowCellStyle(sourceIndex, displayIndex, cellKind);
    cell.style.background = '';
    cell.style.backgroundColor = '';
    cell.style.color = '';
    cell.style.textDecoration = '';
    cell.style.opacity = '';
    cell.style.borderLeft = '';
    cell.style.cssText = `${cell.style.cssText};${style}`;
  }

  private applyModifiedCellDecoration(cell: HTMLElement, sourceIndex: number, col: string): void {
    const cellKey = `${sourceIndex}-${col}`;
    if (!this.modifiedCells.has(cellKey)) {
      return;
    }

    cell.style.backgroundColor = 'rgba(245,158,11,0.15)';
    cell.style.borderLeft = '3px solid #f59e0b';
    cell.title = 'Unsaved edit — double-click to edit';
  }

  private createRow(row: any, displayIndex: number, sourceIndex: number): HTMLElement {
    const tr = document.createElement('tr');
    tr.dataset.index = String(displayIndex);
    tr.dataset.sourceIndex = String(sourceIndex);
    tr.style.cursor = 'pointer';

    this.applyRowStyle(tr, sourceIndex, displayIndex);

    tr.onclick = (e) => {
      this.handleRowSelection(sourceIndex, e.ctrlKey || e.metaKey);
    };

    tr.onmouseenter = () => {
      if (!this.selectedIndices.has(sourceIndex))
        tr.style.background = 'var(--vscode-list-hoverBackground)';
    };
    tr.onmouseleave = () => {
      if (!this.selectedIndices.has(sourceIndex)) this.applyRowStyle(tr, sourceIndex, displayIndex);
    };

    // Row number cell
    const selectTd = document.createElement('td');
    selectTd.textContent = String(this.rowNumberBaseline + displayIndex);
    selectTd.style.cssText = `
      border-bottom:1px solid var(--vscode-widget-border);
      border-right:1px solid var(--vscode-widget-border);
      text-align:right;font-family:monospace;font-size:10px;
      user-select:none;
      min-width:32px;padding:6px 6px;position:sticky;left:0;z-index:5;
      cursor:pointer;
    `;
    selectTd.title = 'Click to select row';
    selectTd.onclick = (e) => {
      e.stopPropagation();
      this.handleRowSelection(sourceIndex, e.ctrlKey || e.metaKey);
    };
    this.applyCellStyle(selectTd, sourceIndex, displayIndex, 'row-number');
    tr.appendChild(selectTd);

    this.columns.forEach((col) => {
      tr.appendChild(this.createCell(row, col, sourceIndex, displayIndex));
    });

    return tr;
  }

  /** Render a pending insert row with all cells as inputs */
  private createPendingInsertRow(pending: PendingInsertRow): HTMLElement {
    const tr = document.createElement('tr');
    tr.dataset.tempId = pending.tempId;
    tr.style.cssText = `
      border-left:4px solid var(--vscode-testing-iconPassed,#4caf50);
      background:color-mix(in srgb, var(--vscode-testing-iconPassed,#4caf50) 8%, transparent);
    `;

    const numTd = document.createElement('td');
    numTd.textContent = '★';
    numTd.style.cssText = `
      border-bottom:1px solid var(--vscode-widget-border);
      border-right:1px solid var(--vscode-widget-border);
      text-align:center;font-size:11px;color:var(--vscode-testing-iconPassed,#4caf50);
      padding:6px 4px;position:sticky;left:0;z-index:5;
      background:var(--vscode-editor-background);
    `;
    numTd.title = pending.status === 'error' ? `Error: ${pending.errorMsg}` : 'New row — unsaved';
    tr.appendChild(numTd);

    this.columns.forEach((col) => {
      const td = document.createElement('td');
      td.style.cssText =
        'padding:3px 6px;border-bottom:1px solid var(--vscode-widget-border);border-right:1px solid var(--vscode-widget-border);';

      if (pending.status === 'error') {
        td.style.background = 'color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent)';
      }

      const isPk = this.tableInfo?.primaryKeys?.includes(col);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = pending.values[col] !== undefined ? String(pending.values[col]) : '';
      input.placeholder = isPk ? '(auto)' : 'NULL';
      input.style.cssText = `
        width:100%;border:1px solid var(--vscode-widget-border);border-radius:2px;
        background:var(--vscode-input-background);color:var(--vscode-input-foreground);
        padding:2px 4px;font-size:12px;outline:none;box-sizing:border-box;
      `;
      input.addEventListener('input', () => {
        pending.values[col] = input.value;
      });
      td.appendChild(input);
      tr.appendChild(td);
    });

    // Save button cell
    const actionTd = document.createElement('td');
    actionTd.style.cssText =
      'padding:3px 8px;border-bottom:1px solid var(--vscode-widget-border);white-space:nowrap;';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = pending.status === 'saving' ? '...' : '✓';
    saveBtn.title = 'Save new row';
    saveBtn.style.cssText = `
      background:var(--vscode-button-background);color:var(--vscode-button-foreground);
      border:none;border-radius:2px;padding:2px 8px;cursor:pointer;font-size:11px;margin-right:4px;
    `;
    saveBtn.disabled = pending.status === 'saving';
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pending.status = 'saving';
      saveBtn.disabled = true;
      saveBtn.textContent = '...';
      this.events.onInsertRow?.(pending.values, pending.tempId);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Discard new row';
    cancelBtn.style.cssText = `
      background:none;border:1px solid var(--vscode-widget-border);
      color:var(--vscode-descriptionForeground);border-radius:2px;
      padding:2px 6px;cursor:pointer;font-size:11px;
    `;
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = this.pendingInserts.findIndex((p) => p.tempId === pending.tempId);
      if (idx !== -1) this.pendingInserts.splice(idx, 1);
      this.rerenderTable();
    });

    actionTd.appendChild(saveBtn);
    actionTd.appendChild(cancelBtn);

    if (pending.status === 'error') {
      const errSpan = document.createElement('span');
      errSpan.textContent = pending.errorMsg || 'Error';
      errSpan.style.cssText =
        'color:var(--vscode-errorForeground);font-size:10px;display:block;margin-top:2px;';
      actionTd.appendChild(errSpan);
    }

    tr.appendChild(actionTd);
    return tr;
  }

  private createCell(row: any, col: string, sourceIndex: number, displayIndex: number): HTMLElement {
    const td = document.createElement('td');
    const val = row[col];
    const colType = this.columnTypes[col];

    td.style.cssText = `
      padding:6px 12px;
      border-bottom:1px solid var(--vscode-widget-border);
      border-right:1px solid var(--vscode-widget-border);
      text-align:left;max-width:400px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      background-color:var(--vscode-editor-background);
    `;

    td.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleRowSelection(sourceIndex, e.ctrlKey || e.metaKey);
    });

    const isPk = this.tableInfo?.primaryKeys?.includes(col);
    if (isPk) {
      td.style.backgroundColor = 'rgba(128,128,128,0.1)';
      td.title = 'Primary Key';
    } else {
      td.style.cursor = 'text';
      td.title = 'Double-click to edit';
      // DOUBLE-CLICK to edit (not single-click)
      td.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        // Pass PostgreSQL type for editors — not formatValue()'s semantic type (e.g. "object").
        this.handleCellEdit(e, td, sourceIndex, col);
      });
    }

    this.applyCellStyle(td, sourceIndex, displayIndex, 'data');

    this.applyModifiedCellDecoration(td, sourceIndex, col);

    // Right-align numeric columns
    if (this.isNumericColumn(col)) {
      td.style.textAlign = 'right';
    }

    if (val === null || val === undefined) {
      const pill = document.createElement('span');
      pill.textContent = '[null]';
      pill.setAttribute('aria-label', 'NULL');
      pill.style.cssText = `
        display:inline-block;
        font-family:var(--vscode-editor-font-family),monospace;
        font-size:11px;
        font-weight:500;
        color:var(--vscode-descriptionForeground);
        opacity:0.45;
        vertical-align:middle;
      `;
      td.appendChild(pill);
      td.style.verticalAlign = 'middle';
    } else {
      const prettyPreview = this.columnPrettyPreview.has(col);
      const { kind, text: formattedText } = formatValue(val, colType, {
        byteaDisplayFormat: this.byteaDisplayFormat,
        prettyPreview,
      });

      const multilinePretty =
        prettyPreview &&
        Boolean(colType) &&
        columnTypeSupportsPrettyPreview(colType) &&
        (kind === 'json' ||
          kind === 'object' ||
          (colType!.toLowerCase() === 'xml' && typeof val === 'string'));

      if (kind === 'boolean-true' || kind === 'boolean-false') {
        td.textContent = formattedText;
      } else if (kind === 'json' || kind === 'object') {
        const mono = document.createElement('span');
        mono.textContent = formattedText;
        mono.style.cssText = `
          font-family:var(--vscode-editor-font-family),monospace;
          font-size:11px;
          display:block;
          max-width:100%;
          ${
            multilinePretty
              ? 'white-space:pre-wrap;word-break:break-word;'
              : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
          }
        `;
        mono.title = formattedText;
        if (multilinePretty) {
          td.style.whiteSpace = 'normal';
          td.style.verticalAlign = 'top';
        }
        td.appendChild(mono);
      } else if (kind === 'bytea') {
        const mono = document.createElement('span');
        mono.textContent = formattedText;
        mono.style.cssText =
          'font-family:var(--vscode-editor-font-family),monospace;font-size:11px;';
        td.appendChild(mono);
      } else if (multilinePretty) {
        const wrap = document.createElement('span');
        wrap.textContent = formattedText;
        wrap.style.cssText =
          'font-family:var(--vscode-editor-font-family),monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;display:block;';
        wrap.title = formattedText;
        td.appendChild(wrap);
        td.style.whiteSpace = 'normal';
        td.style.verticalAlign = 'top';
      } else {
        td.textContent = formattedText;
      }
    }

    return td;
  }

  private handleRowSelection(sourceIndex: number, isMultiSelect: boolean): void {
    if (isMultiSelect) {
      if (this.selectedIndices.has(sourceIndex)) {
        this.selectedIndices.delete(sourceIndex);
      } else {
        this.selectedIndices.add(sourceIndex);
      }
    } else {
      this.selectedIndices.clear();
      this.selectedIndices.add(sourceIndex);
    }

    this.updateRowSelectionStyles();
    this.events.onSelectionChange?.(this.selectedIndices);
  }

  private applyRowStyle(tr: HTMLElement, sourceIndex: number, displayIndex: number = sourceIndex) {
    const gutterStyle = this.getRowGutterStyle(sourceIndex);
    if (this.rowsMarkedForDeletion.has(sourceIndex)) {
      tr.style.cssText = `text-decoration:line-through;opacity:0.7;${gutterStyle};cursor:pointer;`;
    } else if (this.selectedIndices.has(sourceIndex)) {
      tr.style.cssText = `color:var(--vscode-list-activeSelectionForeground);${gutterStyle};cursor:pointer;`;
    } else {
      const base =
        displayIndex % 2 === 0 ? 'transparent' : 'var(--vscode-keybindingTable-rowsBackground)';
      tr.style.cssText = `background:${base};color:var(--vscode-editor-foreground);${gutterStyle};cursor:pointer;`;
    }
  }

  private updateRowSelectionStyles() {
    if (!this.tableBody) return;
    Array.from(this.tableBody.children).forEach((child: any) => {
      const sourceIndex = parseInt(child.dataset.sourceIndex);
      const displayIndex = parseInt(child.dataset.index);
      if (!isNaN(sourceIndex)) {
        this.applyRowStyle(child, sourceIndex, isNaN(displayIndex) ? sourceIndex : displayIndex);
        const rowCells = Array.from(child.children) as HTMLElement[];
        rowCells.forEach((cell, cellIndex) => {
          const cellKind: 'row-number' | 'data' = cellIndex === 0 ? 'row-number' : 'data';
          this.applyCellStyle(cell, sourceIndex, isNaN(displayIndex) ? sourceIndex : displayIndex, cellKind);
          if (cellKind === 'data') {
            const col = this.columns[cellIndex - 1];
            if (col) {
              this.applyModifiedCellDecoration(cell, sourceIndex, col);
            }
          }
        });
      }
    });
  }

  private handleCellEdit(e: MouseEvent, td: HTMLElement, sourceIndex: number, col: string) {
    if (this.currentlyEditingCell === td) return;

    // Blur any existing editor
    if (this.currentlyEditingCell) {
      const existing = this.currentlyEditingCell.querySelector('input, textarea, select');
      if (existing) (existing as HTMLElement).blur();
    }

    this.currentlyEditingCell = td;
    const editingRow = td.closest('tr');
    td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const currentValue = this.rows[sourceIndex]?.[col];
    const originalValue = this.originalRows[sourceIndex]?.[col] ?? currentValue;
    const colType = this.columnTypes[col] ?? '';
    const cellKey = `${sourceIndex}-${col}`;

    // Find FK info for this column
    const fkInfo = this.foreignKeys.find((fk) => fk.column === col);

    td.innerHTML = '';
    td.style.overflow = 'visible';
    td.style.padding = '2px';

    const onSave = (newValue: any) => {
      const orig = this.originalRows[sourceIndex]?.[col] ?? null;
      if (JSON.stringify(newValue) !== JSON.stringify(orig)) {
        this.modifiedCells.set(cellKey, { originalValue: orig, newValue });
      } else {
        this.modifiedCells.delete(cellKey);
      }
      if (this.rows[sourceIndex]) this.rows[sourceIndex][col] = newValue;
      this.currentlyEditingCell = null;
      this.events.onDataChange?.(sourceIndex, col, newValue, orig);
      this.rerenderTable();
    };

    const onCancel = () => {
      this.currentlyEditingCell = null;
      this.rerenderTable();
    };

    // FK lookup bridge
    const onFkLookup = fkInfo
      ? (searchText: string, callback: (rows: any[], cols: string[]) => void) => {
          const requestId = `fk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          this.events.onFkLookup?.(
            requestId,
            fkInfo.refSchema,
            fkInfo.refTable,
            fkInfo.refColumn,
            searchText,
            callback,
          );
        }
      : undefined;

    const editorEl = createCellEditor({
      columnName: col,
      columnType: colType,
      currentValue,
      isFkColumn: !!fkInfo,
      onFkLookup,
      onSave,
      onCancel,
      anchorEl: td,
      dockParent: this.mainContainer,
      dockAfter: this.tableContainer,
      editingRowEl: editingRow instanceof HTMLTableRowElement ? editingRow : null,
    });

    td.appendChild(editorEl);
  }

  private setupInfiniteScroll() {
    if (this.loadMoreObserver) return;

    this.loadMoreSentinel = document.createElement('div');
    this.loadMoreSentinel.style.height = '20px';
    this.tableContainer.appendChild(this.loadMoreSentinel);

    this.loadMoreObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) this.renderNextChunk();
      },
      { root: this.tableContainer, rootMargin: '100px' },
    );

    this.loadMoreObserver.observe(this.loadMoreSentinel);
  }

  private shouldVirtualize(): boolean {
    return (
      this.displayRows.length + this.pendingInserts.length >
      TableRenderer.VIRTUAL_ROW_THRESHOLD
    );
  }

  private createSpacerRow(heightPx: number): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.setAttribute('data-virtual-spacer', '1');
    tr.setAttribute('aria-hidden', 'true');
    const td = document.createElement('td');
    td.colSpan = Math.max(1, this.columns.length + 1);
    td.style.padding = '0';
    td.style.border = 'none';
    td.style.height = `${heightPx}px`;
    td.style.lineHeight = '0';
    td.style.fontSize = '0';
    tr.appendChild(td);
    return tr;
  }

  private getPendingBlockHeight(): number {
    if (!this.tableBody) return 0;
    const pendingCount = this.pendingInserts.length;
    let h = 0;
    for (let i = 0; i < pendingCount; i++) {
      const row = this.tableBody.children[i] as HTMLElement | undefined;
      if (row) {
        const oh = row.offsetHeight;
        h += oh > 0 ? oh : TableRenderer.DEFAULT_PENDING_ROW_HEIGHT_PX;
      } else {
        h += TableRenderer.DEFAULT_PENDING_ROW_HEIGHT_PX;
      }
    }
    return h;
  }

  private renderVirtualInitial() {
    if (!this.tableBody) return;
    const pendingCount = this.pendingInserts.length;
    for (let i = 0; i < pendingCount; i++) {
      const pending = this.pendingInserts[i];
      if (pending) {
        this.tableBody.appendChild(this.createPendingInsertRow(pending));
      }
    }
    this.lastVirtualRange = null;
    this.syncVirtualWindow();
    this.attachVirtualScrollListener();
  }

  private onVirtualScroll = () => {
    if (!this.virtualScrollEnabled) return;
    if (this.virtualScrollRaf !== null) {
      cancelAnimationFrame(this.virtualScrollRaf);
    }
    this.virtualScrollRaf = requestAnimationFrame(() => {
      this.virtualScrollRaf = null;
      this.syncVirtualWindow();
    });
  };

  private attachVirtualScrollListener() {
    if (this.scrollListenerAttached) return;
    this.tableContainer.addEventListener('scroll', this.onVirtualScroll, { passive: true });
    this.scrollListenerAttached = true;
  }

  private teardownVirtualScroll() {
    if (this.scrollListenerAttached) {
      this.tableContainer.removeEventListener('scroll', this.onVirtualScroll);
      this.scrollListenerAttached = false;
    }
    if (this.virtualScrollRaf !== null) {
      cancelAnimationFrame(this.virtualScrollRaf);
      this.virtualScrollRaf = null;
    }
    this.virtualScrollEnabled = false;
    this.lastVirtualRange = null;
  }

  private syncVirtualWindow() {
    if (!this.tableBody || !this.virtualScrollEnabled) return;

    const totalDisplay = this.displayRows.length;
    if (totalDisplay === 0) {
      this.lastVirtualRange = null;
      return;
    }

    const pendingCount = this.pendingInserts.length;
    const pendingHeight = this.getPendingBlockHeight();

    const scrollTop = this.tableContainer.scrollTop;
    const clientH = this.tableContainer.clientHeight;
    const rowH = Math.max(12, this.dataRowHeightEstimate);

    const scrollPastPending = Math.max(0, scrollTop - pendingHeight);
    const firstIdx = Math.min(
      totalDisplay - 1,
      Math.max(0, Math.floor(scrollPastPending / rowH)),
    );
    const viewportRows = Math.max(1, Math.ceil(clientH / rowH));
    const visibleCount = Math.max(
      TableRenderer.VIRTUAL_MIN_VIEWPORT_ROWS,
      viewportRows,
    );
    const bufferRows = Math.ceil(
      viewportRows * TableRenderer.VIRTUAL_VIEWPORT_BUFFER_MULTIPLIER,
    );
    const start = Math.max(0, firstIdx - bufferRows);
    const end = Math.min(totalDisplay, firstIdx + visibleCount + bufferRows);

    if (
      this.lastVirtualRange &&
      this.lastVirtualRange.start === start &&
      this.lastVirtualRange.end === end
    ) {
      return;
    }
    this.lastVirtualRange = { start, end };

    while (this.tableBody.children.length > pendingCount) {
      this.tableBody.removeChild(this.tableBody.lastChild!);
    }

    const topSpacerHeight = start * rowH;
    const bottomSpacerHeight = (totalDisplay - end) * rowH;

    if (topSpacerHeight > 0) {
      this.tableBody.appendChild(this.createSpacerRow(topSpacerHeight));
    }
    for (let i = start; i < end; i++) {
      const displayIndex = i;
      const sourceIndex = this.displayRowSourceIndices[displayIndex] ?? displayIndex;
      const tr = this.createRow(this.displayRows[displayIndex], displayIndex, sourceIndex);
      this.tableBody.appendChild(tr);
    }
    if (bottomSpacerHeight > 0) {
      this.tableBody.appendChild(this.createSpacerRow(bottomSpacerHeight));
    }

    const firstDataTr = this.tableBody.querySelector(
      'tr[data-source-index]:not([data-virtual-spacer])',
    ) as HTMLElement | null;
    if (firstDataTr && firstDataTr.offsetHeight > 0) {
      this.dataRowHeightEstimate = firstDataTr.offsetHeight;
    }
  }

  /** Remove inline editor panels injected by the cell editor into ancestor containers. */
  private cleanupInlineEditors() {
    let el: HTMLElement | null = this.mainContainer;
    while (el && el !== document.body) {
      el.querySelectorAll('[data-inline-editor]').forEach((e) => e.remove());
      el = el.parentElement;
    }
  }

  private rerenderTable() {
    this.render({
      columns: this.columns,
      rows: this.rows,
      originalRows: this.originalRows,
      columnTypes: this.columnTypes,
      tableInfo: this.tableInfo,
      foreignKeys: this.foreignKeys,
      initialSelectedIndices: this.selectedIndices,
      modifiedCells: this.modifiedCells,
      rowsMarkedForDeletion: this.rowsMarkedForDeletion,
      sortState: { column: this.sortColumn, direction: this.sortDirection },
      filterState: this.filterState,
    });
  }

  private cloneFilterState(state: FilterState): FilterState {
    return {
      globalQuery: state.globalQuery || '',
      clauses: state.clauses.map((clause) => ({ ...clause })),
    };
  }

  private handlePaste(e: ClipboardEvent, startIndex: number, startCol: string) {
    const clipboardData = e.clipboardData?.getData('text');
    if (!clipboardData) return;
    if (
      !clipboardData.includes('\t') &&
      !clipboardData.includes('\n') &&
      !clipboardData.includes('\r')
    )
      return;

    e.preventDefault();
    e.stopPropagation();

    const rows = clipboardData
      .trim()
      .split(/\r?\n/)
      .map((r) => r.split('\t'));
    const colNames = this.columns;
    const startColIdx = colNames.indexOf(startCol);
    if (startColIdx === -1) return;

    rows.forEach((rowValues, rOffset) => {
      const targetRowIdx = startIndex + rOffset;
      if (targetRowIdx >= this.rows.length) {
        this.rows.push({});
        this.originalRows.push({});
      }

      rowValues.forEach((val, cOffset) => {
        const targetColIdx = startColIdx + cOffset;
        if (targetColIdx < colNames.length) {
          const colName = colNames[targetColIdx];
          let newValue: any = val;
          if (newValue.startsWith('"') && newValue.endsWith('"')) {
            newValue = newValue.slice(1, -1).replace(/""/g, '"');
          }
          if (newValue === '') newValue = null;

          const originalValue = this.originalRows[targetRowIdx][colName];
          const cellKey = `${targetRowIdx}-${colName}`;
          if (newValue != originalValue) {
            this.modifiedCells.set(cellKey, { originalValue, newValue });
            this.events.onDataChange?.(targetRowIdx, colName, newValue, originalValue);
          }
          this.rows[targetRowIdx][colName] = newValue;
        }
      });
    });

    this.currentlyEditingCell = null;
    this.rerenderTable();
  }

  /** Scrollable region for attaching listeners (streaming result pager). */
  public getScrollContainer(): HTMLElement {
    return this.tableContainer;
  }

  public dispose() {
    this.teardownVirtualScroll();
    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect();
      this.loadMoreObserver = null;
    }
    if (this.statsTooltip) {
      this.statsTooltip.destroy();
      this.statsTooltip = null;
    }
    this.loadMoreSentinel = null;
    this.tableBody = null;
    this.currentlyEditingCell = null;
  }
}
