/**
 * FilterBar.ts
 * Client-side filter bar for the data grid.
 * Filters visible rows without re-querying the database.
 */

import { FilterState } from '../../../common/types';

export interface FilterBarOptions {
  columns: string[];
  filterState: FilterState;
  onFilterChange: (state: FilterState) => void;
}

export class FilterBar {
  private container: HTMLElement;
  private filterState: FilterState;
  private onFilterChange: (state: FilterState) => void;
  private inputs: Map<string, HTMLInputElement> = new Map();
  private globalInput: HTMLInputElement | null = null;
  private mode: 'global' | 'column' = 'global';

  constructor(options: FilterBarOptions) {
    this.container = document.createElement('div');
    this.filterState = new Map(options.filterState);
    this.onFilterChange = options.onFilterChange;
    this.render(options.columns);
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private render(columns: string[]) {
    this.container.innerHTML = '';
    this.container.style.cssText = `
      display:flex;align-items:center;gap:6px;
      padding:4px 8px;
      background:var(--vscode-editor-background);
      border-bottom:1px solid var(--vscode-widget-border);
      flex-wrap:wrap;
    `;

    // Mode toggle button
    const modeBtn = document.createElement('button');
    modeBtn.textContent = '⚡ Filter';
    modeBtn.title = 'Toggle between global and per-column filter';
    modeBtn.style.cssText = `
      background:none;border:1px solid var(--vscode-widget-border);
      color:var(--vscode-foreground);border-radius:2px;
      padding:2px 8px;cursor:pointer;font-size:11px;white-space:nowrap;
    `;

    const inputArea = document.createElement('div');
    inputArea.style.cssText = 'display:flex;gap:6px;align-items:center;flex:1;flex-wrap:wrap;';

    const renderGlobal = () => {
      inputArea.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Filter all columns...';
      input.value = this.filterState.get('__global__') || '';
      input.style.cssText = `
        flex:1;min-width:120px;max-width:300px;
        background:var(--vscode-input-background);
        color:var(--vscode-input-foreground);
        border:1px solid var(--vscode-widget-border);
        border-radius:2px;padding:2px 6px;font-size:11px;outline:none;
      `;
      input.addEventListener('input', () => {
        if (input.value) {
          this.filterState.set('__global__', input.value);
        } else {
          this.filterState.delete('__global__');
        }
        this.onFilterChange(new Map(this.filterState));
      });
      this.globalInput = input;
      inputArea.appendChild(input);
      setTimeout(() => input.focus(), 0);
    };

    const renderColumns = () => {
      inputArea.innerHTML = '';
      this.inputs.clear();
      columns.slice(0, 8).forEach(col => { // Limit to 8 columns for UI reasons
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;gap:1px;';

        const label = document.createElement('span');
        label.textContent = col;
        label.style.cssText = 'font-size:9px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.5px;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '...';
        input.value = this.filterState.get(col) || '';
        input.style.cssText = `
          width:90px;
          background:var(--vscode-input-background);
          color:var(--vscode-input-foreground);
          border:1px solid var(--vscode-widget-border);
          border-radius:2px;padding:2px 4px;font-size:11px;outline:none;
        `;
        input.addEventListener('input', () => {
          if (input.value) {
            this.filterState.set(col, input.value);
          } else {
            this.filterState.delete(col);
          }
          this.onFilterChange(new Map(this.filterState));
        });
        this.inputs.set(col, input);
        wrapper.appendChild(label);
        wrapper.appendChild(input);
        inputArea.appendChild(wrapper);
      });
    };

    modeBtn.addEventListener('click', () => {
      this.mode = this.mode === 'global' ? 'column' : 'global';
      modeBtn.textContent = this.mode === 'global' ? '⚡ Filter' : '⚡ Columns';
      this.filterState.clear();
      this.onFilterChange(new Map(this.filterState));
      if (this.mode === 'global') { renderGlobal(); } else { renderColumns(); }
    });

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear all filters';
    clearBtn.style.cssText = `
      background:none;border:none;color:var(--vscode-descriptionForeground);
      cursor:pointer;font-size:13px;padding:0 4px;line-height:1;
    `;
    clearBtn.addEventListener('click', () => {
      this.filterState.clear();
      this.onFilterChange(new Map(this.filterState));
      if (this.mode === 'global') { renderGlobal(); } else { renderColumns(); }
    });

    // Active filter count badge
    const badge = document.createElement('span');
    const updateBadge = () => {
      const count = this.filterState.size;
      badge.textContent = count > 0 ? `${count} active` : '';
      badge.style.cssText = count > 0
        ? 'font-size:10px;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);padding:1px 5px;border-radius:8px;'
        : '';
    };
    updateBadge();

    this.container.appendChild(modeBtn);
    this.container.appendChild(inputArea);
    this.container.appendChild(badge);
    this.container.appendChild(clearBtn);

    renderGlobal(); // Start in global mode
  }

  /**
   * Apply filter to rows — returns filtered rows
   */
  static applyFilter(rows: any[], filterState: FilterState, columns: string[]): any[] {
    if (filterState.size === 0) { return rows; }

    const globalFilter = filterState.get('__global__')?.toLowerCase();

    return rows.filter(row => {
      if (globalFilter) {
        // Global: row matches if ANY column contains the filter text
        return columns.some(col => {
          const v = row[col];
          if (v === null || v === undefined) { return false; }
          return String(v).toLowerCase().includes(globalFilter);
        });
      }

      // Per-column: ALL specified column filters must match
      for (const [col, filterText] of filterState.entries()) {
        if (col === '__global__') { continue; }
        const v = row[col];
        if (v === null || v === undefined) { return false; }
        if (!String(v).toLowerCase().includes(filterText.toLowerCase())) { return false; }
      }
      return true;
    });
  }
}
