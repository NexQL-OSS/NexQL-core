import { createButton } from '../ui';
import { formatValue } from '../../utils/formatting';
import { TableInfo, TableRenderOptions, FkColumnInfo, FilterState } from '../../../common/types';
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
  private dateTimeDisplayMode: Map<string, boolean> = new Map();
  private pendingInserts: PendingInsertRow[] = [];

  // Sort & filter state
  private sortColumn: string | null = null;
  private sortDirection: 'asc' | 'desc' | 'none' = 'none';
  private filterState: FilterState = { globalQuery: '', clauses: [] };

  // UI sub-components
  private filterBar: FilterBar | null = null;
  private statsTooltip: ColumnStatsTooltip | null = null;

  private renderedCount = 0;
  private readonly CHUNK_SIZE = 50;
  private currentlyEditingCell: HTMLElement | null = null;

  /** Below this many combined data + pending rows, use chunk + IntersectionObserver (legacy). */
  private static readonly VIRTUAL_ROW_THRESHOLD = 100;
  /** Extra rows above/below viewport as a multiple of visible rows (2× viewport total buffer). */
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

    this.columns = options.columns;
    this.rows = options.rows;
    this.originalRows = options.originalRows;
    this.columnTypes = options.columnTypes || {};
    this.tableInfo = options.tableInfo;
    this.foreignKeys = options.foreignKeys || [];
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
      onAddRow: () => this.addPendingRow(),
      onFilterChange: (state) => {
        this.filterState = this.cloneFilterState(state);
        this.events.onFilterChange?.(state);
        this.applyTransforms();
        this.refreshTableContent();
      },
    });
    this.mainContainer.insertBefore(this.filterBar.getElement(), this.tableContainer);

    if (this.displayRows.length === 0 && this.rows.length === 0) {
      this.renderEmptyState(this.columns.length === 0 ? 'no-columns' : 'no-rows');
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
    th.style.cssText = `
      text-align:left;padding:8px 12px;
      border-bottom:1px solid var(--vscode-widget-border);
      border-right:1px solid var(--vscode-widget-border);
      font-weight:600;color:var(--vscode-editor-foreground);
      position:sticky;top:0;background:var(--vscode-editor-background);
      z-index:10;user-select:none;max-width:400px;cursor:pointer;
    `;

    const container = document.createElement('div');
    container.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;gap:4px;';

    const leftSide = document.createElement('div');
    leftSide.style.cssText = 'display:flex;align-items:center;gap:4px;overflow:hidden;';

    if (this.tableInfo?.primaryKeys?.includes(col)) {
      const pkIcon = document.createElement('span');
      pkIcon.textContent = '⚿';
      pkIcon.title = 'Primary Key';
      pkIcon.style.cssText =
        'color:var(--vscode-textLink-foreground);font-size:12px;flex-shrink:0;';
      leftSide.appendChild(pkIcon);
    }

    // FK icon
    if (this.foreignKeys.some((fk) => fk.column === col)) {
      const fkIcon = document.createElement('span');
      fkIcon.textContent = '🔗';
      fkIcon.title = 'Foreign Key';
      fkIcon.style.cssText = 'font-size:10px;flex-shrink:0;';
      leftSide.appendChild(fkIcon);
    }

    const colName = document.createElement('span');
    colName.textContent = col;
    colName.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    leftSide.appendChild(colName);
    container.appendChild(leftSide);

    const rightSide = document.createElement('div');
    rightSide.style.cssText = 'display:flex;align-items:center;gap:4px;flex-shrink:0;';

    // Sort indicator
    const sortIcon = document.createElement('span');
    sortIcon.style.cssText = 'font-size:10px;opacity:0.5;';
    if (this.sortColumn === col) {
      sortIcon.textContent = this.sortDirection === 'asc' ? '▲' : '▼';
      sortIcon.style.opacity = '1';
      sortIcon.style.color = 'var(--vscode-textLink-foreground)';
    } else {
      sortIcon.textContent = '⇅';
    }
    rightSide.appendChild(sortIcon);

    if (this.columnTypes[col]) {
      const typeBadge = document.createElement('span');
      typeBadge.textContent = this.columnTypes[col];
      typeBadge.style.cssText = `
        font-size:10px;font-family:var(--vscode-editor-font-family),monospace;
        color:var(--vscode-descriptionForeground);margin-left:4px;
      `;
      rightSide.appendChild(typeBadge);
    }
    container.appendChild(rightSide);
    th.appendChild(container);

    // Sort click handler — cycles none → asc → desc → none
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

    // DateTime toggle row
    if (this.columnTypes[col]) {
      const lowerType = this.columnTypes[col].toLowerCase();
      const isDateTime =
        lowerType.includes('timestamp') ||
        lowerType === 'timestamptz' ||
        lowerType === 'date' ||
        lowerType === 'time' ||
        lowerType === 'timetz';
      if (isDateTime) {
        if (!this.dateTimeDisplayMode.has(col)) {
          this.dateTimeDisplayMode.set(col, false);
        }
        const toggleRow = document.createElement('div');
        toggleRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;';
        const toggle = document.createElement('button');
        const isFormatted = this.dateTimeDisplayMode.get(col);
        toggle.textContent = isFormatted ? '📆' : '#';
        toggle.title = isFormatted
          ? 'Showing formatted — click for raw'
          : 'Showing raw — click for formatted';
        toggle.style.cssText = `
          background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);
          border:none;border-radius:3px;padding:1px 4px;cursor:pointer;font-size:10px;line-height:1;
        `;
        toggle.onclick = (e) => {
          e.stopPropagation();
          this.dateTimeDisplayMode.set(col, !isFormatted);
          this.rerenderTable();
        };
        toggleRow.appendChild(toggle);
        th.appendChild(toggleRow);
      }
    }

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
    selectTd.textContent = String(displayIndex + 1);
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
    let { text, type } = formatValue(val, colType);

    const isDateTime = type === 'date' || type === 'timestamp' || type === 'time';
    if (isDateTime) {
      const isFormatted = this.dateTimeDisplayMode.get(col) ?? false;
      if (!isFormatted) {
        text = val !== null && val !== undefined ? String(val) : 'NULL';
      }
    }

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
        this.handleCellEdit(e, td, sourceIndex, col, type);
      });
    }

    const cellKey = `${sourceIndex}-${col}`;
    if (this.modifiedCells.has(cellKey)) {
      td.style.backgroundColor = 'rgba(245,158,11,0.15)';
      td.style.borderLeft = '3px solid #f59e0b';
    }

    this.applyCellStyle(td, sourceIndex, displayIndex, 'data');

    if (val === null || val === undefined) {
      const nullSpan = document.createElement('span');
      nullSpan.textContent = 'NULL';
      nullSpan.style.cssText =
        'color:var(--vscode-descriptionForeground);font-style:italic;opacity:0.6;';
      td.appendChild(nullSpan);
    } else {
      td.textContent = text;
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
        });
      }
    });
  }

  private handleCellEdit(
    e: MouseEvent,
    td: HTMLElement,
    sourceIndex: number,
    col: string,
    type: string,
  ) {
    if (this.currentlyEditingCell === td) return;

    // Blur any existing editor
    if (this.currentlyEditingCell) {
      const existing = this.currentlyEditingCell.querySelector('input, textarea');
      if (existing) (existing as HTMLElement).blur();
    }

    this.currentlyEditingCell = td;
    const currentValue = this.rows[sourceIndex]?.[col];
    const originalValue = this.originalRows[sourceIndex]?.[col] ?? currentValue;
    const colType = this.columnTypes[col] || type;
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
    const visibleCount = Math.max(1, Math.ceil(clientH / rowH));
    const bufferRows = Math.ceil(
      visibleCount * TableRenderer.VIRTUAL_VIEWPORT_BUFFER_MULTIPLIER,
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
