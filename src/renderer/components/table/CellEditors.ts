/**
 * CellEditors.ts
 * Type-aware inline cell editor factory for PgStudio's data grid.
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
}

export type EditorType = 'text' | 'number' | 'boolean' | 'date' | 'time' | 'datetime' | 'json' | 'array' | 'fk' | 'longtext';

/**
 * Types where a one-line input is a poor fit; use the same anchored modal as long-text / JSON (without JSON validation).
 * Names are lowercase PostgreSQL typnames / common aliases (see pg_catalog / pg-types builtins).
 */
const PG_TYPES_WITH_MODAL_TEXT_EDITOR = new Set([
  'text',
  'varchar',
  'character varying',
  'bpchar',
  'char',
  'character',
  'name',
  'xml',
  'interval',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
  'bit',
  'varbit',
  'bit varying',
  'tsvector',
  'tsquery',
  'inet',
  'cidr',
  'macaddr',
  'macaddr8',
  'geometry',
  'geography',
  'bytea',
  'uuid',
  'money',
  'int4range',
  'int8range',
  'numrange',
  'daterange',
  'tsrange',
  'tstzrange',
  'int4multirange',
  'int8multirange',
  'nummultirange',
  'datemultirange',
  'tsmultirange',
  'tstzmultirange',
]);

function pgTypeUsesModalTextEditor(columnType: string): boolean {
  const t = columnType.trim().toLowerCase();
  if (!t) {
    return false;
  }
  if (t.startsWith('oid:')) {
    return true;
  }
  if (PG_TYPES_WITH_MODAL_TEXT_EDITOR.has(t)) {
    return true;
  }
  if (/^(varchar|bpchar|char|bit|varbit|numeric|decimal)\s*\(/.test(t)) {
    return true;
  }
  return false;
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
  if (type === 'bool' || type === 'boolean') { return 'boolean'; }

  // Numeric (money uses modal text — locale/formatting is easier in the expanded editor)
  if (['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'decimal',
       'smallint', 'integer', 'bigint', 'real', 'double precision'].includes(type)) {
    return 'number';
  }

  // Date/time
  if (type === 'date') { return 'date'; }
  if (type === 'time' || type === 'timetz' ||
      type === 'time without time zone' || type === 'time with time zone') {
    return 'time';
  }
  if (type === 'timestamp' || type === 'timestamptz' ||
      type === 'timestamp without time zone' || type === 'timestamp with time zone') {
    return 'datetime';
  }

  // JSON
  if (type === 'json' || type === 'jsonb') { return 'json'; }

  // XML, interval, geometry, full-width text types, etc. — anchored modal (same UX as long text)
  if (pgTypeUsesModalTextEditor(type)) {
    return 'longtext';
  }

  // Long text detection (unknown OID label or legacy "string" + very long value)
  if (typeof currentValue === 'string' && currentValue.length > 200) { return 'longtext'; }

  return 'text';
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
    default:         return createTextEditor(options);
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

// ─── Text ────────────────────────────────────────────────────────────

function createTextEditor(opts: CellEditorOptions): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value =
    opts.currentValue !== null && opts.currentValue !== undefined
      ? cellValueToEditString(opts.currentValue)
      : '';
  applyEditorBaseStyle(input);

  const save = () => opts.onSave(input.value === '' && opts.isNullable ? null : input.value);
  input.addEventListener('keydown', (e) => handleKeydown(e, save, opts.onCancel));
  input.addEventListener('blur', save);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return input;
}

// ─── Long Text (modal overlay) ───────────────────────────────────────

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
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 3px;
    padding: 8px;
    min-width: 200px;
    max-width: 400px;
    position: relative;
    z-index: 1000;
  `;

  const items = parseArrayLiteral(opts.currentValue);

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:6px;';
  header.innerHTML = `<span style="font-size:11px;color:var(--vscode-descriptionForeground);">Array items (${opts.columnType})</span>`;

  const itemsContainer = document.createElement('div');
  itemsContainer.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;';

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
        if (e.key === 'Escape') { opts.onCancel(); }
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
  saveBtn.addEventListener('click', () => opts.onSave(toArrayLiteral(items)));

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    background:none;border:1px solid var(--vscode-button-border,#555);
    color:var(--vscode-descriptionForeground);border-radius:2px;
    padding:2px 8px;cursor:pointer;font-size:11px;
  `;
  cancelBtn.addEventListener('click', opts.onCancel);

  btnGroup.appendChild(saveBtn);
  btnGroup.appendChild(cancelBtn);
  footer.appendChild(addBtn);
  footer.appendChild(btnGroup);

  wrapper.appendChild(header);
  wrapper.appendChild(itemsContainer);
  wrapper.appendChild(footer);
  return wrapper;
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

// ─── Inline Expanding Editor (replaces clipped fixed-position modal) ──
//
// Notebook output runs inside an iframe whose ancestors apply overflow:hidden.
// No fixed/absolute overlay can escape this clipping.  Instead we inject an
// inline panel into the output's own DOM flow — it pushes the table down,
// stays fully visible, and scrolls into view automatically.

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

function createModalEditor(opts: ModalEditorOptions): HTMLElement {
  // The inline placeholder returned to the caller (sits inside the <td>)
  const placeholder = document.createElement('div');
  placeholder.style.cssText = `
    padding:2px 6px;
    background:var(--vscode-input-background);
    border:1px solid var(--vscode-focusBorder);
    border-radius:2px;
    font-size:11px;
    color:var(--vscode-descriptionForeground);
    cursor:pointer;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    max-width:200px;
  `;
  const preview = opts.initialContent.slice(0, 60) + (opts.initialContent.length > 60 ? '...' : '');
  placeholder.textContent = preview || '(empty)';
  placeholder.title = 'Click to open editor';

  const showEditor = () => {
    const container = opts.anchorEl ? findOutputContainer(opts.anchorEl) : document.body;

    // ── Wrapper: inline block in normal DOM flow ──
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-inline-editor', 'true');
    wrapper.style.cssText = `
      position:relative;
      z-index:100;
      width:100%;
      box-sizing:border-box;
      padding:12px;
      margin:0;
      background:var(--vscode-editor-background);
      border:2px solid var(--vscode-focusBorder);
      border-radius:4px;
      box-shadow:0 4px 16px rgba(0,0,0,0.35);
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

    if (opts.isCode) {
      const formatBtn = document.createElement('button');
      formatBtn.textContent = 'Format JSON';
      formatBtn.style.cssText = `
        background:none;border:1px solid var(--vscode-button-border,#555);
        color:var(--vscode-descriptionForeground);border-radius:2px;
        padding:4px 10px;cursor:pointer;font-size:12px;margin-right:auto;
      `;
      formatBtn.addEventListener('click', () => {
        try {
          textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2);
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

    // ── Lifecycle ──
    const keyboardTrapAbort = new AbortController();
    const { signal } = keyboardTrapAbort;

    const stopKeysEscaping = (e: Event) => { e.stopPropagation(); };

    const teardown = () => {
      keyboardTrapAbort.abort();
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
        if (e.key === 'Enter' && e.ctrlKey) {
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
    wrapper.appendChild(textarea);
    wrapper.appendChild(errorDiv);
    wrapper.appendChild(btnRow);

    // Insert at the top of the output container (above the table) so the
    // editor is always visible and never hidden beneath scrolled-away rows.
    container.insertBefore(wrapper, container.firstChild);
    wrapper.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => { textarea.focus(); textarea.setSelectionRange(0, 0); }, 0);
  };

  showEditor();
  return placeholder;
}
