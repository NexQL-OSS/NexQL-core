/**
 * CellEditors.ts
 * Type-aware inline cell editor factory for NexQL's data grid.
 * All editors run in the notebook webview (no VS Code API access).
 */

export interface CellEditorOptions {
  columnName: string;
  columnType: string;          // PostgreSQL type name e.g. 'int4', 'timestamptz', '_text'
  currentValue: any;
  isNullable?: boolean;
  onSave: (newValue: any) => void;
  onCancel: () => void;
  onFkLookup?: (searchText: string, callback: (rows: any[], columns: string[]) => void) => void;
  isFkColumn?: boolean;
  /** Ignored — kept for interface compat; inline editor finds its own mount point. */
  modalMount?: HTMLElement;
  /** The table cell element — used to locate the output container for inline editor injection. */
  anchorEl?: HTMLElement;
  /** Mount bottom-docked panels after this node (e.g. table scroll area). */
  dockParent?: HTMLElement;
  dockAfter?: HTMLElement;
  /** Highlight this row while a bottom-docked editor is open. */
  editingRowEl?: HTMLTableRowElement | null;
}

export type EditorType =
  | 'number'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'json'
  | 'array'
  | 'fk'
  | 'longtext';

/** First token of a pg typname, before `(…)`, for matching `numeric(12,4)` etc. */
function pgTypeHead(columnType: string): string {
  const t = columnType.trim().toLowerCase();
  if (t.startsWith('double precision')) {
    return 'double precision';
  }
  const paren = t.indexOf('(');
  const base = (paren >= 0 ? t.slice(0, paren) : t).trim();
  return base.split(/\s+/)[0] ?? base;
}

function isPgNumericFamily(columnType: string): boolean {
  const t = columnType.trim().toLowerCase();
  if (t.startsWith('double precision')) {
    return true;
  }
  const head = pgTypeHead(columnType);
  return [
    'int2',
    'int4',
    'int8',
    'float4',
    'float8',
    'numeric',
    'decimal',
    'smallint',
    'integer',
    'bigint',
    'real',
    'serial',
    'bigserial',
    'smallserial',
  ].includes(head);
}

/** String for inline inputs — never use String(object) (yields "[object Object]"). */
function cellValueToEditString(val: any): string {
  if (val === null || val === undefined) return '';
  // node-pg bytea → Buffer; JSON round-trip uses { type: "Buffer", data: [...] }
  if (typeof val === 'object' && val !== null && (val as { type?: string }).type === 'Buffer' && Array.isArray((val as { data?: number[] }).data)) {
    const bytes = new Uint8Array((val as { data: number[] }).data);
    return '\\x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) {
    return '\\x' + (val as Buffer).toString('hex');
  }
  if (typeof val === 'object' && !(val instanceof Date)) {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

/**
 * node-pg parses json/jsonb to JS objects; if OID mapping is missing or legacy "string" slipped through,
 * still open the JSON editor when the cell value is structured data.
 */
function coercedColumnTypeForEditor(columnType: string, currentValue: any): string {
  const t = (columnType || '').trim().toLowerCase();
  if (t === '' || t === 'string') {
    if (currentValue !== null && typeof currentValue === 'object' && !(currentValue instanceof Date)) {
      return 'jsonb';
    }
  }
  return columnType;
}

/**
 * Determine editor type from PostgreSQL type string
 */
export function getEditorType(columnType: string, currentValue: any): EditorType {
  columnType = coercedColumnTypeForEditor(columnType, currentValue);
  const type = (columnType || '').toLowerCase();

  // Array types start with underscore in pg OID naming
  if (type.startsWith('_') || type === 'array') { return 'array'; }

  // Boolean
  if (type === 'bool' || type === 'boolean') {
    return 'boolean';
  }

  // Numeric scalars — single-line editor, row height unchanged
  if (isPgNumericFamily(columnType)) {
    return 'number';
  }

  // Date/time — native inputs, compact row
  if (type === 'date') {
    return 'date';
  }
  if (
    type === 'time' ||
    type === 'timetz' ||
    type === 'time without time zone' ||
    type === 'time with time zone'
  ) {
    return 'time';
  }
  if (
    type === 'timestamp' ||
    type === 'timestamptz' ||
    type === 'timestamp without time zone' ||
    type === 'timestamp with time zone'
  ) {
    return 'datetime';
  }

  // JSON
  if (type === 'json' || type === 'jsonb') {
    return 'json';
  }

  // varchar, text, bytea, uuid, strings, enums, OID labels, ranges, geometry, …
  // → bottom-docked editor so notebook iframe rows are not stretched
  return 'longtext';
}

/**
 * Main factory function: creates the appropriate editor element
 * and returns it ready to be injected into the cell.
 */
export function createCellEditor(options: CellEditorOptions): HTMLElement {
  const { columnType, currentValue, isFkColumn, onFkLookup } = options;

  if (isFkColumn && onFkLookup) {
    return createFkEditor(options);
  }

  const editorType = getEditorType(columnType, currentValue);

  switch (editorType) {
    case 'boolean':  return createBooleanEditor(options);
    case 'number':   return createNumberEditor(options);
    case 'date':     return createDateEditor(options);
    case 'time':     return createTimeEditor(options);
    case 'datetime': return createDateTimeEditor(options);
    case 'json':     return createJsonEditor(options);
    case 'array':    return createArrayEditor(options);
    case 'longtext': return createLongTextEditor(options);
    default:         return createLongTextEditor(options);
  }
}

// ─── Shared utilities ───────────────────────────────────────────────

function applyEditorBaseStyle(el: HTMLElement) {
  el.style.cssText = `
    background: var(--vscode-input-background, #1e1e1e);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-focusBorder, #007acc);
    border-radius: 2px;
    padding: 2px 4px;
    font-family: inherit;
    font-size: inherit;
    outline: none;
    box-sizing: border-box;
    width: 100%;
  `;
}

function handleKeydown(e: KeyboardEvent, onSave: () => void, onCancel: () => void) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(); }
  if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
}

// ─── Boolean ────────────────────────────────────────────────────────

function createBooleanEditor(opts: CellEditorOptions): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 4px;';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(opts.currentValue);
  checkbox.style.cursor = 'pointer';

  const label = document.createElement('label');
  label.textContent = checkbox.checked ? 'true' : 'false';
  label.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);';

  checkbox.addEventListener('change', () => {
    label.textContent = checkbox.checked ? 'true' : 'false';
  });

  checkbox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { opts.onSave(checkbox.checked); }
    if (e.key === 'Escape') { opts.onCancel(); }
  });

  checkbox.addEventListener('blur', () => opts.onSave(checkbox.checked));

  wrapper.appendChild(checkbox);
  wrapper.appendChild(label);
  setTimeout(() => checkbox.focus(), 0);
  return wrapper;
}

// ─── Number ─────────────────────────────────────────────────────────

function createNumberEditor(opts: CellEditorOptions): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = opts.currentValue !== null && opts.currentValue !== undefined
    ? String(opts.currentValue) : '';
  applyEditorBaseStyle(input);
  input.style.minWidth = '80px';

  const save = () => {
    const v = input.value.trim();
    opts.onSave(v === '' ? null : Number(v));
  };

  input.addEventListener('keydown', (e) => handleKeydown(e, save, opts.onCancel));
  input.addEventListener('blur', save);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return input;
}

// ─── Long Text (bottom-docked panel) ─────────────────────────────────

function modalPlainEditorTitle(opts: CellEditorOptions): string {
  const t = (opts.columnType || '').trim();
  if (!t) {
    return opts.columnName;
  }
  return `${opts.columnName} (${t})`;
}

function createLongTextEditor(opts: CellEditorOptions): HTMLElement {
  return createModalEditor({
    title: modalPlainEditorTitle(opts),
    initialContent: opts.currentValue != null ? cellValueToEditString(opts.currentValue) : '',
    isCode: false,
    validate: () => null,
    onSave: opts.onSave,
    onCancel: opts.onCancel,
    modalMount: opts.modalMount,
    anchorEl: opts.anchorEl,
    dockParent: opts.dockParent,
    dockAfter: opts.dockAfter,
    editingRowEl: opts.editingRowEl,
    columnName: opts.columnName,
    columnType: opts.columnType,
  });
}

// ─── Date ────────────────────────────────────────────────────────────

function createDateEditor(opts: CellEditorOptions): HTMLElement {
  const input = document.createElement('input');
  input.type = 'date';

  // Normalize current value to YYYY-MM-DD
  if (opts.currentValue) {
    try {
      const d = new Date(opts.currentValue);
      if (!isNaN(d.getTime())) {
        input.value = d.toISOString().split('T')[0];
      } else {
        input.value = String(opts.currentValue).split('T')[0];
      }
    } catch { input.value = ''; }
  }

  applyEditorBaseStyle(input);
  const save = () => opts.onSave(input.value || null);
  input.addEventListener('keydown', (e) => handleKeydown(e, save, opts.onCancel));
  input.addEventListener('blur', save);
  setTimeout(() => input.focus(), 0);
  return input;
}

// ─── Time ────────────────────────────────────────────────────────────

function createTimeEditor(opts: CellEditorOptions): HTMLElement {
  const input = document.createElement('input');
  input.type = 'time';
  input.step = '1'; // Show seconds

  if (opts.currentValue) {
    // Extract HH:MM:SS from time string
    const timeStr = String(opts.currentValue);
    const match = timeStr.match(/(\d{2}:\d{2}(:\d{2})?)/);
    if (match) { input.value = match[1]; }
  }

  applyEditorBaseStyle(input);
  const save = () => opts.onSave(input.value || null);
  input.addEventListener('keydown', (e) => handleKeydown(e, save, opts.onCancel));
  input.addEventListener('blur', save);
  setTimeout(() => input.focus(), 0);
  return input;
}

// ─── DateTime ────────────────────────────────────────────────────────

function createDateTimeEditor(opts: CellEditorOptions): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:220px;';

  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.step = '1';

  if (opts.currentValue) {
    try {
      const d = new Date(opts.currentValue);
      if (!isNaN(d.getTime())) {
        // datetime-local format: YYYY-MM-DDTHH:MM:SS
        const iso = d.toISOString().replace('Z', '').slice(0, 19);
        input.value = iso;
      }
    } catch { /* leave empty */ }
  }

  applyEditorBaseStyle(input);

  const hint = document.createElement('span');
  hint.textContent = 'Local time (UTC stored if timestamptz)';
  hint.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);';

  const save = () => {
    if (!input.value) { opts.onSave(null); return; }
    // Return ISO string - PostgreSQL handles it
    opts.onSave(input.value.replace('T', ' '));
  };

  input.addEventListener('keydown', (e) => handleKeydown(e, save, opts.onCancel));
  input.addEventListener('blur', save);

  wrapper.appendChild(input);
  wrapper.appendChild(hint);
  setTimeout(() => input.focus(), 0);
  return wrapper;
}

// ─── JSON Modal ───────────────────────────────────────────────────────

function createJsonEditor(opts: CellEditorOptions): HTMLElement {
  let formatted = '';
  try {
    const parsed = typeof opts.currentValue === 'string'
      ? JSON.parse(opts.currentValue)
      : opts.currentValue;
    formatted = JSON.stringify(parsed, null, 2);
  } catch {
    formatted = opts.currentValue != null ? cellValueToEditString(opts.currentValue) : '';
  }

  return createModalEditor({
    title: `${opts.columnName} (JSON)`,
    initialContent: formatted,
    isCode: true,
    validate: (content) => {
      try { JSON.parse(content); return null; }
      catch (e) { return `Invalid JSON: ${(e as Error).message}`; }
    },
    onSave: (content) => {
      try { opts.onSave(JSON.parse(content)); }
      catch { opts.onSave(content); } // fallback: save as string
    },
    onCancel: opts.onCancel,
    modalMount: opts.modalMount,
    anchorEl: opts.anchorEl,
    dockParent: opts.dockParent,
    dockAfter: opts.dockAfter,
    editingRowEl: opts.editingRowEl,
    columnName: opts.columnName,
    columnType: opts.columnType,
  });
}

// ─── Array Editor ─────────────────────────────────────────────────────

function createArrayEditor(opts: CellEditorOptions): HTMLElement {
  // Parse PostgreSQL array literal: {val1,val2,"val3"}
  const parseArrayLiteral = (v: any): string[] => {
    if (Array.isArray(v)) { return v.map(String); }
    if (typeof v !== 'string') { return []; }
    const s = v.trim();
    if (!s.startsWith('{') || !s.endsWith('}')) { return [s]; }
    // Simple split — handles basic cases (not nested arrays)
    return s.slice(1, -1).split(',').map(item => {
      item = item.trim();
      if (item.startsWith('"') && item.endsWith('"')) {
        return item.slice(1, -1).replace(/\\"/g, '"');
      }
      return item === 'NULL' ? '' : item;
    });
  };

  const toArrayLiteral = (items: string[]): string => {
    return '{' + items.map(item => {
      if (item === '' || item === 'NULL') { return 'NULL'; }
      if (item.includes(',') || item.includes('"') || item.includes('{')) {
        return '"' + item.replace(/"/g, '\\"') + '"';
      }
      return item;
    }).join(',') + '}';
  };

  const wrapper = document.createElement('div');
  wrapper.style.cssText = `
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    padding: 8px;
    width: 100%;
    box-sizing: border-box;
  `;

  const items = parseArrayLiteral(opts.currentValue);

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:6px;';
  header.innerHTML = `<span style="font-size:11px;color:var(--vscode-descriptionForeground);">Array items (${opts.columnType})</span>`;

  const itemsContainer = document.createElement('div');
  itemsContainer.style.cssText =
    'display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto;';

  const renderItems = () => {
    itemsContainer.innerHTML = '';
    items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;align-items:center;';

      const index = document.createElement('span');
      index.textContent = `[${idx}]`;
      index.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);min-width:28px;';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = item;
      applyEditorBaseStyle(input);
      input.style.flex = '1';
      input.addEventListener('input', () => { items[idx] = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { items.splice(idx + 1, 0, ''); renderItems(); }
        if (e.key === 'Escape') {
          e.preventDefault();
          applyDockedAnchorCellStyle(opts.anchorEl, false);
          applyEditingRowHighlight(opts.editingRowEl ?? null, false);
          opts.onCancel();
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = `
        background:none;border:none;color:var(--vscode-errorForeground);
        cursor:pointer;font-size:14px;padding:0 4px;line-height:1;
      `;
      removeBtn.addEventListener('click', () => { items.splice(idx, 1); renderItems(); });

      row.appendChild(index);
      row.appendChild(input);
      row.appendChild(removeBtn);
      itemsContainer.appendChild(row);
    });
  };

  renderItems();

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:6px;margin-top:8px;justify-content:space-between;';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add item';
  addBtn.style.cssText = `
    background:none;border:1px solid var(--vscode-button-border,#555);
    color:var(--vscode-button-foreground);border-radius:2px;
    padding:2px 8px;cursor:pointer;font-size:11px;
  `;
  addBtn.addEventListener('click', () => { items.push(''); renderItems(); });

  const btnGroup = document.createElement('div');
  btnGroup.style.cssText = 'display:flex;gap:4px;';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = `
    background:var(--vscode-button-background);color:var(--vscode-button-foreground);
    border:none;border-radius:2px;padding:2px 10px;cursor:pointer;font-size:11px;
  `;
  saveBtn.addEventListener('click', () => {
    applyDockedAnchorCellStyle(opts.anchorEl, false);
    applyEditingRowHighlight(opts.editingRowEl ?? null, false);
    opts.onSave(toArrayLiteral(items));
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    background:none;border:1px solid var(--vscode-button-border,#555);
    color:var(--vscode-descriptionForeground);border-radius:2px;
    padding:2px 8px;cursor:pointer;font-size:11px;
  `;
  cancelBtn.addEventListener('click', () => {
    applyDockedAnchorCellStyle(opts.anchorEl, false);
    applyEditingRowHighlight(opts.editingRowEl ?? null, false);
    opts.onCancel();
  });

  btnGroup.appendChild(saveBtn);
  btnGroup.appendChild(cancelBtn);
  footer.appendChild(addBtn);
  footer.appendChild(btnGroup);

  wrapper.appendChild(header);
  wrapper.appendChild(itemsContainer);
  wrapper.appendChild(footer);

  const outer = document.createElement('div');
  outer.setAttribute('data-inline-editor', 'true');
  outer.style.cssText = `
    position:relative;
    width:100%;
    flex-shrink:0;
    box-sizing:border-box;
    padding:12px;
    margin:6px 0 0;
    background:var(--vscode-editor-background);
    border:2px solid var(--vscode-focusBorder);
    border-radius:4px;
    box-shadow:0 2px 12px rgba(0,0,0,0.28);
    display:flex;
    flex-direction:column;
    gap:8px;
  `;

  const titleBar = document.createElement('div');
  titleBar.style.cssText =
    'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);flex-shrink:0;';
  titleBar.textContent = `${opts.columnName} (${opts.columnType})`;

  outer.appendChild(titleBar);
  outer.appendChild(wrapper);

  applyEditingRowHighlight(opts.editingRowEl ?? null, true);
  applyDockedAnchorCellStyle(opts.anchorEl, true);
  insertDockedPanel(
    {
      title: `${opts.columnName} array`,
      initialContent: '',
      isCode: false,
      validate: () => null,
      onSave: () => {},
      onCancel: () => {},
      anchorEl: opts.anchorEl,
      dockParent: opts.dockParent,
      dockAfter: opts.dockAfter,
      editingRowEl: opts.editingRowEl ?? null,
    },
    outer,
  );
  outer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  return createDockedCellIndicator(opts.columnName, `${opts.columnName} (${opts.columnType})`);
}

// ─── FK Dropdown ──────────────────────────────────────────────────────

function createFkEditor(opts: CellEditorOptions): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;min-width:180px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = opts.currentValue != null ? String(opts.currentValue) : '';
  input.placeholder = 'Search...';
  applyEditorBaseStyle(input);

  const dropdown = document.createElement('div');
  dropdown.style.cssText = `
    position:absolute;top:100%;left:0;right:0;
    background:var(--vscode-dropdown-background,#252526);
    border:1px solid var(--vscode-focusBorder);
    border-top:none;border-radius:0 0 3px 3px;
    max-height:200px;overflow-y:auto;z-index:9999;
    box-shadow:0 4px 8px rgba(0,0,0,0.3);
    display:none;
  `;

  let debounceTimer: any;
  const pendingCallbacks = new Map<string, (rows: any[], cols: string[]) => void>();

  const showLoading = () => {
    dropdown.style.display = 'block';
    dropdown.innerHTML = '<div style="padding:8px;color:var(--vscode-descriptionForeground);font-size:11px;">Loading...</div>';
  };

  const populateDropdown = (rows: any[], columns: string[]) => {
    dropdown.innerHTML = '';
    if (rows.length === 0) {
      dropdown.innerHTML = '<div style="padding:8px;color:var(--vscode-descriptionForeground);font-size:11px;">No matches</div>';
      return;
    }

    rows.forEach(row => {
      const item = document.createElement('div');
      const displayValue = row[columns[0]];
      const secondaryValue = columns[1] ? ` — ${row[columns[1]]}` : '';
      item.style.cssText = `
        padding:5px 8px;cursor:pointer;font-size:12px;
        border-bottom:1px solid var(--vscode-widget-border);
      `;
      item.innerHTML = `<strong>${displayValue}</strong><span style="color:var(--vscode-descriptionForeground);font-size:11px;">${secondaryValue}</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        opts.onSave(displayValue);
        dropdown.style.display = 'none';
      });
      item.addEventListener('mouseover', () => { item.style.background = 'var(--vscode-list-hoverBackground)'; });
      item.addEventListener('mouseout', () => { item.style.background = ''; });
      dropdown.appendChild(item);
    });
  };

  const search = (text: string) => {
    if (!opts.onFkLookup) { return; }
    showLoading();
    const requestId = Math.random().toString(36).slice(2);
    pendingCallbacks.set(requestId, populateDropdown);
    opts.onFkLookup(text, (rows, cols) => {
      const cb = pendingCallbacks.get(requestId);
      if (cb) { cb(rows, cols); pendingCallbacks.delete(requestId); }
    });
  };

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => search(input.value), 300);
  });

  input.addEventListener('focus', () => {
    dropdown.style.display = 'block';
    if (dropdown.children.length === 0) { search(input.value); }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 150);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { opts.onSave(input.value); dropdown.style.display = 'none'; }
    if (e.key === 'Escape') { opts.onCancel(); dropdown.style.display = 'none'; }
  });

  wrapper.appendChild(input);
  wrapper.appendChild(dropdown);
  setTimeout(() => { input.focus(); input.select(); search(''); }, 0);
  return wrapper;
}

// ─── Bottom-docked multi-line editors (notebook output = sandboxed iframe) ──
//
// `position:fixed` and high z-index cannot overlap adjacent notebook cells.
// Editors are injected in-flow below the table scroll area (sandboxed iframe).

/** Matches footer Commit accent — marks the grid cell tied to the bottom docked editor */
const PG_EDIT_AMBER = '#f59e0b';

function applyDockedAnchorCellStyle(anchorEl: HTMLElement | undefined, active: boolean) {
  const td = anchorEl;
  if (!td || td.tagName.toLowerCase() !== 'td') {
    return;
  }
  if (active) {
    td.style.boxSizing = 'border-box';
    td.style.border = `1.5px solid ${PG_EDIT_AMBER}`;
    td.style.background = `color-mix(in srgb, ${PG_EDIT_AMBER} 14%, transparent)`;
    td.style.color = PG_EDIT_AMBER;
    td.style.verticalAlign = 'middle';
  } else {
    td.style.border = '';
    td.style.background = '';
    td.style.color = '';
    td.style.verticalAlign = '';
    td.style.boxSizing = '';
  }
}

function createDockedCellIndicator(columnLabel: string, title: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = `
    padding:6px 8px;
    font-size:11px;
    font-weight:600;
    color:${PG_EDIT_AMBER};
    border:1.5px solid ${PG_EDIT_AMBER};
    border-radius:4px;
    background:color-mix(in srgb, ${PG_EDIT_AMBER} 14%, transparent);
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    max-width:100%;
    box-sizing:border-box;
  `;
  el.textContent = `✎ ${columnLabel}`;
  el.title = title;
  el.setAttribute('aria-label', `Editing ${columnLabel}`);
  return el;
}

function applyEditingRowHighlight(row: HTMLElement | null | undefined, active: boolean) {
  if (!row) {
    return;
  }
  if (active) {
    row.classList.add('pg-row-editing');
    row.style.background =
      'color-mix(in srgb, var(--vscode-list-inactiveSelectionBackground) 38%, transparent)';
    row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  } else {
    row.classList.remove('pg-row-editing');
    row.style.background = '';
  }
}

function insertDockedPanel(opts: ModalEditorOptions, panel: HTMLElement): HTMLElement {
  if (opts.dockParent) {
    if (opts.dockAfter?.parentNode === opts.dockParent) {
      opts.dockParent.insertBefore(panel, opts.dockAfter.nextSibling);
    } else {
      opts.dockParent.appendChild(panel);
    }
    return opts.dockParent;
  }
  const container = opts.anchorEl ? findOutputContainer(opts.anchorEl) : document.body;
  container.appendChild(panel);
  return container;
}

interface ModalEditorOptions {
  title: string;
  initialContent: string;
  isCode: boolean;
  validate: (content: string) => string | null;
  onSave: (content: string) => void;
  onCancel: () => void;
  /** Ignored (kept for interface compat). */
  modalMount?: HTMLElement;
  /** The cell <td> — used to find the output container and scroll into view. */
  anchorEl?: HTMLElement;
  dockParent?: HTMLElement;
  dockAfter?: HTMLElement;
  editingRowEl?: HTMLTableRowElement | null;
  /** Shown in the table cell while the docked panel is open. */
  columnName?: string;
  columnType?: string;
}

/**
 * Walk up from `start` looking for the output-level container that the
 * TableRenderer lives in (the `viewContainer` created in renderer_v2).
 * Falls back to the closest scrollable ancestor or document.body.
 */
function findOutputContainer(start: HTMLElement): HTMLElement {
  let el: HTMLElement | null = start;
  while (el) {
    if (el.style.position === 'relative' && el.style.overflow === 'hidden') {
      return el.parentElement ?? el;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    el = el.parentElement;
  }
  return document.body;
}

// ─── Format detection & Tree View utilities ────────────────────────

function getFormatType(columnType?: string, content?: string): 'json' | 'xml' | 'html' | null {
  const type = (columnType || '').toLowerCase().trim();
  if (type === 'json' || type === 'jsonb') return 'json';
  if (type === 'xml') return 'xml';
  if (type === 'html') return 'html';

  if (content) {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(trimmed); return 'json'; } catch {}
    }
    if (trimmed.startsWith('<')) {
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('<!doctype html') || lower.includes('<html') || lower.includes('<body')) {
        return 'html';
      }
      try {
        const doc = new DOMParser().parseFromString(trimmed, 'application/xml');
        if (!doc.querySelector('parsererror')) return 'xml';
      } catch {}
    }
  }
  return null;
}

function prettyFormatXmlOrHtml(xmlStr: string, isHtml: boolean = false): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, isHtml ? 'text/html' : 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    return xmlStr;
  }

  const root = isHtml ? (doc.body.children.length > 0 ? doc.body : doc.documentElement) : doc.documentElement;
  if (!root) return xmlStr;

  function serialize(node: Node, depth: number): string {
    const indent = '  '.repeat(depth);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName.toLowerCase();

      let attrs = '';
      Array.from(element.attributes).forEach(attr => {
        attrs += ` ${attr.name}="${attr.value}"`;
      });

      const childNodes = Array.from(element.childNodes);
      if (childNodes.length === 0) {
        return `${indent}<${tagName}${attrs} />`;
      }

      if (childNodes.length === 1 && childNodes[0].nodeType === Node.TEXT_NODE) {
        const text = childNodes[0].textContent?.trim() || '';
        return `${indent}<${tagName}${attrs}>${text}</${tagName}>`;
      }

      let childrenSerialized = '';
      childNodes.forEach(child => {
        const str = serialize(child, depth + 1);
        if (str.trim()) {
          childrenSerialized += str + '\n';
        }
      });

      return `${indent}<${tagName}${attrs}>\n${childrenSerialized}${indent}</${tagName}>`;
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      return text ? `${indent}${text}` : '';
    } else if (node.nodeType === Node.COMMENT_NODE) {
      return `${indent}<!-- ${node.textContent?.trim()} -->`;
    }
    return '';
  }

  if (root === doc.body && isHtml && doc.body.children.length > 0) {
    return Array.from(doc.body.childNodes)
      .map(child => serialize(child, 0))
      .filter(Boolean)
      .join('\n');
  }

  return serialize(root, 0);
}

function renderJsonTree(data: any): HTMLElement {
  const container = document.createElement('div');
  container.className = 'json-tree-container';
  container.style.cssText = `
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-editor-foreground, #cccccc);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 10px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 4px;
    max-height: 320px;
    overflow-y: auto;
    user-select: text;
  `;

  function createNode(key: string | null, value: any, isLast: boolean): HTMLElement {
    const node = document.createElement('div');
    node.style.marginLeft = '16px';
    node.style.position = 'relative';

    if (key !== null) {
      const keySpan = document.createElement('span');
      keySpan.textContent = `"${key}": `;
      keySpan.style.color = 'var(--vscode-symbolIcon-propertyForeground, #9cdcfe)';
      node.appendChild(keySpan);
    }

    if (value === null) {
      const valSpan = document.createElement('span');
      valSpan.textContent = 'null';
      valSpan.style.color = 'var(--vscode-debugConsole-red, #f48771)';
      valSpan.style.fontWeight = 'bold';
      node.appendChild(valSpan);
    } else if (typeof value === 'boolean') {
      const valSpan = document.createElement('span');
      valSpan.textContent = String(value);
      valSpan.style.color = 'var(--vscode-debugConsole-blue, #4fc1ff)';
      node.appendChild(valSpan);
    } else if (typeof value === 'number') {
      const valSpan = document.createElement('span');
      valSpan.textContent = String(value);
      valSpan.style.color = 'var(--vscode-debugConsole-green, #b5cea8)';
      node.appendChild(valSpan);
    } else if (typeof value === 'string') {
      const valSpan = document.createElement('span');
      valSpan.textContent = `"${value}"`;
      valSpan.style.color = 'var(--vscode-debugConsole-orange, #ce9178)';
      valSpan.style.wordBreak = 'break-all';
      node.appendChild(valSpan);
    } else if (typeof value === 'object') {
      const isArray = Array.isArray(value);
      const openBracket = isArray ? '[' : '{';
      const closeBracket = isArray ? ']' : '}';
      const keys = Object.keys(value);
      const size = keys.length;

      const collapsable = document.createElement('span');
      collapsable.style.cursor = 'pointer';

      const arrow = document.createElement('span');
      arrow.textContent = '▼ ';
      arrow.className = 'json-arrow';
      arrow.style.cssText = `
        display: inline-block;
        font-size: 9px;
        color: var(--vscode-descriptionForeground, #8e8e8e);
        width: 12px;
        transition: transform 0.1s ease;
      `;

      const bracketSpan = document.createElement('span');
      bracketSpan.textContent = openBracket;
      bracketSpan.style.color = 'var(--vscode-editor-foreground, #cccccc)';

      collapsable.appendChild(arrow);
      collapsable.appendChild(bracketSpan);
      node.appendChild(collapsable);

      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'json-body';
      childrenContainer.style.borderLeft = '1px dashed var(--vscode-widget-border, #3c3c3c)';
      childrenContainer.style.marginLeft = '6px';
      childrenContainer.style.paddingLeft = '10px';

      if (size === 0) {
        arrow.style.visibility = 'hidden';
        const emptySpan = document.createElement('span');
        emptySpan.textContent = closeBracket;
        node.appendChild(emptySpan);
      } else {
        keys.forEach((k, idx) => {
          const childNode = createNode(isArray ? null : k, value[k], idx === size - 1);
          childrenContainer.appendChild(childNode);
        });
        node.appendChild(childrenContainer);

        const collapsedPreview = document.createElement('span');
        collapsedPreview.className = 'json-preview';
        collapsedPreview.style.cssText = `
          display: none;
          color: var(--vscode-descriptionForeground, #8e8e8e);
          font-style: italic;
          font-size: 11px;
          margin-left: 4px;
        `;
        collapsedPreview.textContent = isArray ? `... ${size} items ...` : `... ${size} keys ...`;
        node.appendChild(collapsedPreview);

        const closeBracketSpan = document.createElement('span');
        closeBracketSpan.textContent = closeBracket;
        closeBracketSpan.style.color = 'var(--vscode-editor-foreground, #cccccc)';
        node.appendChild(closeBracketSpan);

        let collapsed = false;
        const toggle = () => {
          collapsed = !collapsed;
          if (collapsed) {
            arrow.textContent = '▶ ';
            childrenContainer.style.display = 'none';
            collapsedPreview.style.display = 'inline';
          } else {
            arrow.textContent = '▼ ';
            childrenContainer.style.display = 'block';
            collapsedPreview.style.display = 'none';
          }
        };
        collapsable.addEventListener('click', (e) => {
          e.stopPropagation();
          toggle();
        });
      }
    }

    if (!isLast) {
      const comma = document.createElement('span');
      comma.textContent = ',';
      node.appendChild(comma);
    }

    return node;
  }

  container.appendChild(createNode(null, data, true));
  return container;
}

function renderXmlTree(xmlStr: string): HTMLElement {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');

  const container = document.createElement('div');
  container.className = 'xml-tree-container';
  container.style.cssText = `
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-editor-foreground, #cccccc);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 10px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 4px;
    max-height: 320px;
    overflow-y: auto;
    user-select: text;
  `;

  function createXmlNode(node: Node, isLast: boolean): HTMLElement {
    const el = document.createElement('div');
    el.style.marginLeft = '16px';
    el.style.position = 'relative';

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName;
      
      const childNodes = Array.from(element.childNodes).filter(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          return (child.textContent?.trim() || '').length > 0;
        }
        return true;
      });

      const hasChildren = childNodes.some(n => n.nodeType === Node.ELEMENT_NODE);
      const hasText = childNodes.length === 1 && childNodes[0].nodeType === Node.TEXT_NODE;

      const header = document.createElement('span');

      let arrow: HTMLElement | null = null;
      if (hasChildren) {
        arrow = document.createElement('span');
        arrow.textContent = '▼ ';
        arrow.className = 'xml-arrow';
        arrow.style.cssText = `
          display: inline-block;
          font-size: 9px;
          color: var(--vscode-descriptionForeground, #8e8e8e);
          width: 12px;
          cursor: pointer;
          transition: transform 0.1s ease;
        `;
        header.appendChild(arrow);
      }

      const openTag = document.createElement('span');
      openTag.textContent = `<${tagName}`;
      openTag.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
      header.appendChild(openTag);

      Array.from(element.attributes).forEach(attr => {
        const attrSpan = document.createElement('span');
        attrSpan.textContent = ` ${attr.name}=`;
        attrSpan.style.color = 'var(--vscode-symbolIcon-propertyForeground, #9cdcfe)';

        const attrValSpan = document.createElement('span');
        attrValSpan.textContent = `"${attr.value}"`;
        attrValSpan.style.color = 'var(--vscode-debugConsole-orange, #ce9178)';

        header.appendChild(attrSpan);
        header.appendChild(attrValSpan);
      });

      const openTagEnd = document.createElement('span');
      openTagEnd.textContent = '>';
      openTagEnd.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
      header.appendChild(openTagEnd);
      el.appendChild(header);

      if (hasChildren) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'xml-body';
        childrenContainer.style.borderLeft = '1px dashed var(--vscode-widget-border, #3c3c3c)';
        childrenContainer.style.marginLeft = '6px';
        childrenContainer.style.paddingLeft = '10px';

        childNodes.forEach((child, idx) => {
          childrenContainer.appendChild(createXmlNode(child, idx === childNodes.length - 1));
        });
        el.appendChild(childrenContainer);

        const collapsedPreview = document.createElement('span');
        collapsedPreview.className = 'xml-preview';
        collapsedPreview.style.cssText = `
          display: none;
          color: var(--vscode-descriptionForeground, #8e8e8e);
          font-style: italic;
          font-size: 11px;
          margin-left: 4px;
        `;
        collapsedPreview.textContent = '...';
        el.appendChild(collapsedPreview);

        const closeTag = document.createElement('span');
        closeTag.textContent = `</${tagName}>`;
        closeTag.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
        el.appendChild(closeTag);

        let collapsed = false;
        const toggle = () => {
          collapsed = !collapsed;
          if (collapsed) {
            if (arrow) arrow.textContent = '▶ ';
            childrenContainer.style.display = 'none';
            collapsedPreview.style.display = 'inline';
          } else {
            if (arrow) arrow.textContent = '▼ ';
            childrenContainer.style.display = 'block';
            collapsedPreview.style.display = 'none';
          }
        };

        if (arrow) {
          arrow.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle();
          });
        }
        openTag.style.cursor = 'pointer';
        openTag.addEventListener('click', (e) => {
          e.stopPropagation();
          toggle();
        });
      } else if (hasText) {
        const textSpan = document.createElement('span');
        textSpan.textContent = childNodes[0].textContent;
        textSpan.style.color = 'var(--vscode-editor-foreground, #cccccc)';
        el.appendChild(textSpan);

        const closeTag = document.createElement('span');
        closeTag.textContent = `</${tagName}>`;
        closeTag.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
        el.appendChild(closeTag);
      } else {
        openTagEnd.textContent = ' />';
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const textSpan = document.createElement('span');
      textSpan.textContent = node.textContent;
      textSpan.style.color = 'var(--vscode-editor-foreground, #cccccc)';
      el.appendChild(textSpan);
    } else if (node.nodeType === Node.COMMENT_NODE) {
      const commentSpan = document.createElement('span');
      commentSpan.textContent = `<!--${node.textContent}-->`;
      commentSpan.style.color = 'var(--vscode-commentForeground, #6a9955)';
      el.appendChild(commentSpan);
    }

    return el;
  }

  if (doc.documentElement) {
    container.appendChild(createXmlNode(doc.documentElement, true));
  }
  return container;
}

function renderHtmlTree(htmlStr: string): HTMLElement {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlStr, 'text/html');

  const container = document.createElement('div');
  container.className = 'html-tree-container';
  container.style.cssText = `
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-editor-foreground, #cccccc);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 10px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 4px;
    max-height: 320px;
    overflow-y: auto;
    user-select: text;
  `;

  const hasHtmlTag = /<html/i.test(htmlStr);
  const root = hasHtmlTag ? doc.documentElement : (doc.body.children.length > 0 ? doc.body : doc.documentElement);

  function createHtmlDomNode(node: Node, isLast: boolean): HTMLElement {
    const el = document.createElement('div');
    el.style.marginLeft = '16px';
    el.style.position = 'relative';

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName.toLowerCase();
      
      const childNodes = Array.from(element.childNodes).filter(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          return (child.textContent?.trim() || '').length > 0;
        }
        return true;
      });

      const childElements = childNodes.filter(n => n.nodeType === Node.ELEMENT_NODE);
      const hasChildren = childElements.length > 0;
      const hasText = childNodes.length === 1 && childNodes[0].nodeType === Node.TEXT_NODE;

      const header = document.createElement('span');

      let arrow: HTMLElement | null = null;
      if (hasChildren) {
        arrow = document.createElement('span');
        arrow.textContent = '▼ ';
        arrow.className = 'html-arrow';
        arrow.style.cssText = `
          display: inline-block;
          font-size: 9px;
          color: var(--vscode-descriptionForeground, #8e8e8e);
          width: 12px;
          cursor: pointer;
          transition: transform 0.1s ease;
        `;
        header.appendChild(arrow);
      }

      const openTag = document.createElement('span');
      openTag.textContent = `<${tagName}`;
      openTag.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
      header.appendChild(openTag);

      Array.from(element.attributes).forEach(attr => {
        const attrSpan = document.createElement('span');
        attrSpan.textContent = ` ${attr.name}=`;
        attrSpan.style.color = 'var(--vscode-symbolIcon-propertyForeground, #9cdcfe)';

        const attrValSpan = document.createElement('span');
        attrValSpan.textContent = `"${attr.value}"`;
        attrValSpan.style.color = 'var(--vscode-debugConsole-orange, #ce9178)';

        header.appendChild(attrSpan);
        header.appendChild(attrValSpan);
      });

      const openTagEnd = document.createElement('span');
      openTagEnd.textContent = '>';
      openTagEnd.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
      header.appendChild(openTagEnd);
      el.appendChild(header);

      if (hasChildren) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'html-body';
        childrenContainer.style.borderLeft = '1px dashed var(--vscode-widget-border, #3c3c3c)';
        childrenContainer.style.marginLeft = '6px';
        childrenContainer.style.paddingLeft = '10px';

        childNodes.forEach((child, idx) => {
          childrenContainer.appendChild(createHtmlDomNode(child, idx === childNodes.length - 1));
        });
        el.appendChild(childrenContainer);

        const collapsedPreview = document.createElement('span');
        collapsedPreview.className = 'html-preview';
        collapsedPreview.style.cssText = `
          display: none;
          color: var(--vscode-descriptionForeground, #8e8e8e);
          font-style: italic;
          font-size: 11px;
          margin-left: 4px;
        `;
        collapsedPreview.textContent = '...';
        el.appendChild(collapsedPreview);

        const closeTag = document.createElement('span');
        closeTag.textContent = `</${tagName}>`;
        closeTag.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
        el.appendChild(closeTag);

        let collapsed = false;
        const toggle = () => {
          collapsed = !collapsed;
          if (collapsed) {
            if (arrow) arrow.textContent = '▶ ';
            childrenContainer.style.display = 'none';
            collapsedPreview.style.display = 'inline';
          } else {
            if (arrow) arrow.textContent = '▼ ';
            childrenContainer.style.display = 'block';
            collapsedPreview.style.display = 'none';
          }
        };

        if (arrow) {
          arrow.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle();
          });
        }
        openTag.style.cursor = 'pointer';
        openTag.addEventListener('click', (e) => {
          e.stopPropagation();
          toggle();
        });
      } else if (hasText) {
        const textSpan = document.createElement('span');
        textSpan.textContent = childNodes[0].textContent;
        textSpan.style.color = 'var(--vscode-editor-foreground, #cccccc)';
        el.appendChild(textSpan);

        const closeTag = document.createElement('span');
        closeTag.textContent = `</${tagName}>`;
        closeTag.style.color = 'var(--vscode-symbolIcon-classForeground, #569cd6)';
        el.appendChild(closeTag);
      } else {
        openTagEnd.textContent = ' />';
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const textSpan = document.createElement('span');
      textSpan.textContent = node.textContent;
      textSpan.style.color = 'var(--vscode-editor-foreground, #cccccc)';
      el.appendChild(textSpan);
    } else if (node.nodeType === Node.COMMENT_NODE) {
      const commentSpan = document.createElement('span');
      commentSpan.textContent = `<!--${node.textContent}-->`;
      commentSpan.style.color = 'var(--vscode-commentForeground, #6a9955)';
      el.appendChild(commentSpan);
    }

    return el;
  }

  if (root === doc.body && !hasHtmlTag) {
    const childNodes = Array.from(root.childNodes).filter(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        return (child.textContent?.trim() || '').length > 0;
      }
      return true;
    });
    childNodes.forEach((child, idx) => {
      container.appendChild(createHtmlDomNode(child, idx === childNodes.length - 1));
    });
  } else if (root) {
    container.appendChild(createHtmlDomNode(root, true));
  }
  return container;
}

function createModalEditor(opts: ModalEditorOptions): HTMLElement {
  const columnLabel =
    opts.columnName?.trim() ||
    opts.title.replace(/\s*\([^)]*\)\s*$/, '').trim() ||
    opts.title;

  const placeholder = createDockedCellIndicator(columnLabel, opts.title);

  const showEditor = () => {
    applyEditingRowHighlight(opts.editingRowEl ?? null, true);
    applyDockedAnchorCellStyle(opts.anchorEl, true);

    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-inline-editor', 'true');
    wrapper.style.cssText = `
      position:relative;
      width:100%;
      flex-shrink:0;
      box-sizing:border-box;
      padding:12px;
      margin:6px 0 0;
      background:var(--vscode-editor-background);
      border:2px solid var(--vscode-focusBorder);
      border-radius:4px;
      box-shadow:0 2px 12px rgba(0,0,0,0.28);
      display:flex;
      flex-direction:column;
      gap:8px;
    `;

    // ── Title bar ──
    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-shrink:0;';
    const titleMain = document.createElement('span');
    titleMain.style.cssText = 'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);';
    titleMain.textContent = opts.title;
    const titleHint = document.createElement('span');
    titleHint.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;';
    titleHint.textContent = 'Ctrl+Enter to save · Escape to cancel';
    titleBar.appendChild(titleMain);
    titleBar.appendChild(titleHint);

    // ── Textarea ──
    const textarea = document.createElement('textarea');
    textarea.value = opts.initialContent;
    textarea.style.cssText = `
      background:var(--vscode-input-background);
      color:var(--vscode-input-foreground);
      border:1px solid var(--vscode-widget-border);
      border-radius:2px;
      padding:8px;
      font-family:var(--vscode-editor-font-family,monospace);
      font-size:12px;
      resize:vertical;
      min-height:120px;
      max-height:300px;
      outline:none;
      width:100%;
      box-sizing:border-box;
    `;

    // ── Error display ──
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'color:var(--vscode-errorForeground);font-size:11px;min-height:14px;flex-shrink:0;';

    // ── Button row ──
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;flex-shrink:0;';

    // Detect format type
    const formatType = getFormatType(opts.columnType, opts.initialContent);
    const activeFormat = formatType || (opts.isCode ? 'json' : null);

    let formatBtn: HTMLButtonElement | null = null;
    if (activeFormat) {
      formatBtn = document.createElement('button');
      formatBtn.textContent = activeFormat === 'json' ? 'Format JSON' : (activeFormat === 'xml' ? 'Format XML' : 'Format HTML');
      formatBtn.style.cssText = `
        background:none;border:1px solid var(--vscode-button-border,#555);
        color:var(--vscode-descriptionForeground);border-radius:2px;
        padding:4px 10px;cursor:pointer;font-size:12px;margin-right:auto;
      `;
      formatBtn.addEventListener('click', () => {
        try {
          if (activeFormat === 'json') {
            textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2);
          } else {
            textarea.value = prettyFormatXmlOrHtml(textarea.value, activeFormat === 'html');
          }
          errorDiv.textContent = '';
        } catch (e) {
          errorDiv.textContent = `Cannot format: ${(e as Error).message}`;
        }
      });
      btnRow.appendChild(formatBtn);
    }

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = `
      background:var(--vscode-button-background);color:var(--vscode-button-foreground);
      border:none;border-radius:2px;padding:4px 14px;cursor:pointer;font-size:12px;
    `;

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      background:none;border:1px solid var(--vscode-button-border,#555);
      color:var(--vscode-descriptionForeground);border-radius:2px;
      padding:4px 10px;cursor:pointer;font-size:12px;
    `;

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    // ── Tab containers & views ──
    const tabsContainer = document.createElement('div');
    const editorTabContainer = document.createElement('div');
    const viewerTabContainer = document.createElement('div');
    
    editorTabContainer.appendChild(textarea);
    viewerTabContainer.style.cssText = 'width:100%;box-sizing:border-box;display:none;';

    let activeTab: 'edit' | 'view' = 'edit';

    if (activeFormat) {
      tabsContainer.style.cssText = 'display:flex;gap:4px;border-bottom:1px solid var(--vscode-widget-border);margin-bottom:4px;flex-shrink:0;';
      
      const tabEdit = document.createElement('button');
      tabEdit.textContent = 'Edit Raw';
      
      const tabView = document.createElement('button');
      tabView.textContent = 'Formatted View';
      
      const applyTabStyle = (btn: HTMLButtonElement, active: boolean) => {
        btn.style.cssText = `
          background: ${active ? 'var(--vscode-tab-activeBackground, #2d2d2d)' : 'transparent'};
          color: ${active ? 'var(--vscode-tab-activeForeground, #ffffff)' : 'var(--vscode-tab-inactiveForeground, #8e8e8e)'};
          border: none;
          border-bottom: ${active ? '2px solid var(--vscode-activityBar-activeBorder, #007acc)' : '2px solid transparent'};
          padding: 6px 14px;
          font-size: 12px;
          font-weight: ${active ? '600' : 'normal'};
          cursor: pointer;
          outline: none;
        `;
      };

      const switchTab = (tab: 'edit' | 'view') => {
        activeTab = tab;
        if (tab === 'edit') {
          applyTabStyle(tabEdit, true);
          applyTabStyle(tabView, false);
          editorTabContainer.style.display = 'block';
          viewerTabContainer.style.display = 'none';
          if (formatBtn) formatBtn.style.display = 'inline-block';
          setTimeout(() => textarea.focus(), 0);
        } else {
          applyTabStyle(tabEdit, false);
          applyTabStyle(tabView, true);
          editorTabContainer.style.display = 'none';
          viewerTabContainer.style.display = 'block';
          if (formatBtn) formatBtn.style.display = 'none';

          viewerTabContainer.innerHTML = '';
          const currentVal = textarea.value;
          if (!currentVal.trim()) {
            viewerTabContainer.innerHTML = '<div style="padding: 10px; color: var(--vscode-descriptionForeground); font-style: italic;">No content to display</div>';
            return;
          }

          if (activeFormat === 'json') {
            try {
              const parsed = JSON.parse(currentVal);
              const toolbar = document.createElement('div');
              toolbar.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;justify-content:flex-end;';
              
              const expandBtn = document.createElement('button');
              expandBtn.textContent = 'Expand All';
              expandBtn.style.cssText = 'background:none;border:1px solid var(--vscode-button-border,#555);color:var(--vscode-descriptionForeground);border-radius:2px;padding:2px 6px;cursor:pointer;font-size:11px;';
              
              const collapseBtn = document.createElement('button');
              collapseBtn.textContent = 'Collapse All';
              collapseBtn.style.cssText = 'background:none;border:1px solid var(--vscode-button-border,#555);color:var(--vscode-descriptionForeground);border-radius:2px;padding:2px 6px;cursor:pointer;font-size:11px;';
              
              toolbar.appendChild(expandBtn);
              toolbar.appendChild(collapseBtn);
              viewerTabContainer.appendChild(toolbar);

              const treeEl = renderJsonTree(parsed);
              viewerTabContainer.appendChild(treeEl);

              expandBtn.addEventListener('click', () => {
                const arrows = treeEl.querySelectorAll('.json-arrow');
                const bodies = treeEl.querySelectorAll('.json-body');
                const previews = treeEl.querySelectorAll('.json-preview');
                arrows.forEach(el => el.textContent = '▼ ');
                bodies.forEach(el => (el as HTMLElement).style.display = 'block');
                previews.forEach(el => (el as HTMLElement).style.display = 'none');
              });

              collapseBtn.addEventListener('click', () => {
                const arrows = treeEl.querySelectorAll('.json-arrow');
                const bodies = treeEl.querySelectorAll('.json-body');
                const previews = treeEl.querySelectorAll('.json-preview');
                arrows.forEach(el => el.textContent = '▶ ');
                bodies.forEach(el => (el as HTMLElement).style.display = 'none');
                previews.forEach(el => (el as HTMLElement).style.display = 'inline');
              });
            } catch (e) {
              const errBanner = document.createElement('div');
              errBanner.style.cssText = 'color:var(--vscode-errorForeground);padding:10px;border:1px solid var(--vscode-errorForeground);background:rgba(244,67,54,0.08);border-radius:4px;font-size:12px;font-family:monospace;';
              errBanner.textContent = `Invalid JSON: ${(e as Error).message}`;
              viewerTabContainer.appendChild(errBanner);
            }
          } else if (activeFormat === 'xml' || activeFormat === 'html') {
            const isHtml = activeFormat === 'html';
            const parser = new DOMParser();
            const doc = parser.parseFromString(currentVal, isHtml ? 'text/html' : 'application/xml');
            const parseError = doc.querySelector('parsererror');

            if (parseError) {
              const errBanner = document.createElement('div');
              errBanner.style.cssText = 'color:var(--vscode-errorForeground);padding:10px;border:1px solid var(--vscode-errorForeground);background:rgba(244,67,54,0.08);border-radius:4px;font-size:12px;font-family:monospace;';
              errBanner.appendChild(document.createTextNode('Parse Error: '));
              errBanner.appendChild(document.createTextNode(parseError.textContent || ''));
              viewerTabContainer.appendChild(errBanner);
            } else {
              const toolbar = document.createElement('div');
              toolbar.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;justify-content:flex-end;';
              
              const expandBtn = document.createElement('button');
              expandBtn.textContent = 'Expand All';
              expandBtn.style.cssText = 'background:none;border:1px solid var(--vscode-button-border,#555);color:var(--vscode-descriptionForeground);border-radius:2px;padding:2px 6px;cursor:pointer;font-size:11px;';
              
              const collapseBtn = document.createElement('button');
              collapseBtn.textContent = 'Collapse All';
              collapseBtn.style.cssText = 'background:none;border:1px solid var(--vscode-button-border,#555);color:var(--vscode-descriptionForeground);border-radius:2px;padding:2px 6px;cursor:pointer;font-size:11px;';
              
              toolbar.appendChild(expandBtn);
              toolbar.appendChild(collapseBtn);
              viewerTabContainer.appendChild(toolbar);

              const treeEl = isHtml ? renderHtmlTree(currentVal) : renderXmlTree(currentVal);
              viewerTabContainer.appendChild(treeEl);

              const arrowClass = isHtml ? '.html-arrow' : '.xml-arrow';
              const bodyClass = isHtml ? '.html-body' : '.xml-body';
              const previewClass = isHtml ? '.html-preview' : '.xml-preview';

              expandBtn.addEventListener('click', () => {
                const arrows = treeEl.querySelectorAll(arrowClass);
                const bodies = treeEl.querySelectorAll(bodyClass);
                const previews = treeEl.querySelectorAll(previewClass);
                arrows.forEach(el => el.textContent = '▼ ');
                bodies.forEach(el => (el as HTMLElement).style.display = 'block');
                previews.forEach(el => (el as HTMLElement).style.display = 'none');
              });

              collapseBtn.addEventListener('click', () => {
                const arrows = treeEl.querySelectorAll(arrowClass);
                const bodies = treeEl.querySelectorAll(bodyClass);
                const previews = treeEl.querySelectorAll(previewClass);
                arrows.forEach(el => el.textContent = '▶ ');
                bodies.forEach(el => (el as HTMLElement).style.display = 'none');
                previews.forEach(el => (el as HTMLElement).style.display = 'inline');
              });
            }
          }
        }
      };

      tabEdit.addEventListener('click', () => switchTab('edit'));
      tabView.addEventListener('click', () => switchTab('view'));
      
      applyTabStyle(tabEdit, true);
      applyTabStyle(tabView, false);

      tabsContainer.appendChild(tabEdit);
      tabsContainer.appendChild(tabView);
    }

    // ── Lifecycle ──
    const keyboardTrapAbort = new AbortController();
    const { signal } = keyboardTrapAbort;

    const stopKeysEscaping = (e: Event) => { e.stopPropagation(); };

    const teardown = () => {
      keyboardTrapAbort.abort();
      applyDockedAnchorCellStyle(opts.anchorEl, false);
      applyEditingRowHighlight(opts.editingRowEl ?? null, false);
      if (wrapper.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
    };

    const doSave = () => {
      const err = opts.validate(textarea.value);
      if (err) { errorDiv.textContent = err; return; }
      teardown();
      opts.onSave(textarea.value);
    };

    const doCancel = () => {
      teardown();
      opts.onCancel();
    };

    // Keyboard trap: stop host keybindings from stealing focus
    wrapper.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault(); e.stopPropagation(); doSave(); return;
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); doCancel(); return;
        }
        e.stopPropagation();
      },
      { signal },
    );
    wrapper.addEventListener('keyup', stopKeysEscaping, { signal });
    wrapper.addEventListener('beforeinput', stopKeysEscaping, { signal });
    wrapper.addEventListener('compositionend', stopKeysEscaping, { signal });

    saveBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', doCancel);

    // ── Assemble & mount ──
    wrapper.appendChild(titleBar);
    if (activeFormat) {
      wrapper.appendChild(tabsContainer);
    }
    wrapper.appendChild(editorTabContainer);
    if (activeFormat) {
      wrapper.appendChild(viewerTabContainer);
    }
    wrapper.appendChild(errorDiv);
    wrapper.appendChild(btnRow);

    insertDockedPanel(opts, wrapper);
    wrapper.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => { textarea.focus(); textarea.setSelectionRange(0, 0); }, 0);
  };

  showEditor();
  return placeholder;
}
