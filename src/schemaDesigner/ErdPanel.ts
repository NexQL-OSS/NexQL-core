import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { resolveTreeItemConnection } from './connectionHelper';
import { ErrorHandlers } from '../commands/helper';

interface ErdColumn {
  name: string;
  type: string;
  notNull: boolean;
  isPk: boolean;
  isFk: boolean;
}

interface ErdForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName: string;
}

interface ErdTable {
  name: string;
  schema: string;
  /** Approximate row count from pg_class.reltuples (ANALYZE refreshes). */
  estRows?: number;
  columns: ErdColumn[];
}

/**
 * Entity-Relationship Diagram (ERD) Panel
 *
 * Visualises all tables in a schema along with their foreign key relationships.
 * Tables are rendered as cards on a pannable/zoomable canvas; FK arrows connect
 * related columns.  Users can:
 *   - Drag tables to reposition them (layout is auto-saved in the webview state).
 *   - Click a table to highlight all its FK links.
 *   - Jump to a table's definition via "Open in Designer".
 *   - Export the current view as an SVG.
 */
export class ErdPanel {
  public static readonly viewType = 'pgStudio.erd';

  private static _panels = new Map<string, ErdPanel>();
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static async open(
    item: DatabaseTreeItem,
    context: vscode.ExtensionContext
  ): Promise<void> {
    let conn: any;
    try {
      conn = await resolveTreeItemConnection(item);
      if (!conn) { return; }

      const { client, metadata } = conn;
      const labelStr = typeof item.label === 'string' ? item.label : (item.label as any)?.label ?? '';
      const schema = item.schema || labelStr || 'public';
      const db = item.databaseName || metadata?.databaseName || 'postgres';

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Building ERD for "${schema}"…`, cancellable: false },
        async () => {
          const tables = await ErdPanel._fetchTables(client, schema);
          const foreignKeys = await ErdPanel._fetchForeignKeys(client, schema);

          const panelKey = `erd:${item.connectionId}:${db}:${schema}`;
          if (ErdPanel._panels.has(panelKey)) {
            ErdPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
            return;
          }

          const panel = vscode.window.createWebviewPanel(
            ErdPanel.viewType,
            `ERD: ${schema}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
          );

          const erdPanel = new ErdPanel(panel);
          ErdPanel._panels.set(panelKey, erdPanel);
          panel.onDidDispose(() => ErdPanel._panels.delete(panelKey));

          panel.webview.html = ErdPanel._buildHtml(schema, tables, foreignKeys);

          panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'exportSvg') {
              const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`erd-${schema}.svg`),
                filters: { 'SVG Image': ['svg'] }
              });
              if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.svg, 'utf8'));
                vscode.window.showInformationMessage(`ERD exported to ${uri.fsPath}`);
              }
            }
          }, null, erdPanel._disposables);
        }
      );
    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'open ERD');
    } finally {
      if (conn?.release) { conn.release(); }
    }
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  private static async _fetchTables(client: any, schema: string): Promise<ErdTable[]> {
    const tablesResult = await client.query(
      `SELECT c.relname AS table_name,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS est_rows
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r'
       ORDER BY c.relname`,
      [schema]
    );

    // Collect PK columns for each table
    const pkResult = await client.query(
      `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1`,
      [schema]
    );
    const pkMap = new Map<string, Set<string>>();
    for (const row of pkResult.rows) {
      if (!pkMap.has(row.table_name)) { pkMap.set(row.table_name, new Set()); }
      pkMap.get(row.table_name)!.add(row.column_name);
    }

    // Collect FK columns
    const fkColResult = await client.query(
      `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1`,
      [schema]
    );
    const fkMap = new Map<string, Set<string>>();
    for (const row of fkColResult.rows) {
      if (!fkMap.has(row.table_name)) { fkMap.set(row.table_name, new Set()); }
      fkMap.get(row.table_name)!.add(row.column_name);
    }

    const tables: ErdTable[] = [];
    for (const tableRow of tablesResult.rows) {
      const tableName = tableRow.table_name;
      const rawEst = tableRow.est_rows;
      const estRows =
        rawEst !== null && rawEst !== undefined && !Number.isNaN(Number(rawEst))
          ? Number(rawEst)
          : undefined;
      const colResult = await client.query(
        `SELECT a.attname AS column_name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                a.attnotnull AS not_null
         FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = ($1 || '.' || $2)::regclass
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, tableName]
      );

      const pkCols = pkMap.get(tableName) ?? new Set<string>();
      const fkCols = fkMap.get(tableName) ?? new Set<string>();

      tables.push({
        name: tableName,
        schema,
        ...(estRows !== undefined ? { estRows } : {}),
        columns: colResult.rows.map((r: any) => ({
          name: r.column_name,
          type: r.data_type,
          notNull: r.not_null,
          isPk: pkCols.has(r.column_name),
          isFk: fkCols.has(r.column_name),
        })),
      });
    }
    return tables;
  }

  private static async _fetchForeignKeys(client: any, schema: string): Promise<ErdForeignKey[]> {
    const result = await client.query(
      `SELECT
         tc.constraint_name,
         tc.table_name        AS from_table,
         kcu.column_name      AS from_column,
         ccu.table_name       AS to_table,
         ccu.column_name      AS to_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema   = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema   = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
       ORDER BY tc.table_name, kcu.column_name`,
      [schema]
    );
    return result.rows.map((r: any) => ({
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toTable: r.to_table,
      toColumn: r.to_column,
      constraintName: r.constraint_name,
    }));
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private static _buildHtml(
    schema: string,
    tables: ErdTable[],
    foreignKeys: ErdForeignKey[]
  ): string {
    const tablesJson = JSON.stringify(tables);
    const fksJson = JSON.stringify(foreignKeys);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ERD: ${schema}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-editor-font-family, 'Segoe UI', sans-serif);
      font-size: 12px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      overflow: hidden;
      height: 100vh;
    }

    /* ── Toolbar ─────────────────────────────────────────────── */
    #toolbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #toolbar h1 { font-size: 13px; font-weight: 600; flex: 1; }
    #toolbar .badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .tb-btn {
      padding: 4px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .tb-btn:hover { filter: brightness(1.15); }
    .tb-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }

    /* ── Canvas ──────────────────────────────────────────────── */
    #canvas-wrap {
      position: fixed;
      top: 40px; left: 0; right: 0; bottom: 0;
      overflow: hidden;
      cursor: grab;
    }
    #canvas-wrap.grabbing { cursor: grabbing; }
    #canvas {
      position: absolute;
      top: 0; left: 0;
      transform-origin: 0 0;
    }
    svg#fk-layer {
      position: absolute;
      top: 0; left: 0;
      pointer-events: none;
      overflow: visible;
    }

    /* ── Table cards ─────────────────────────────────────────── */
    .erd-table {
      position: absolute;
      min-width: 180px;
      max-width: 260px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      overflow: hidden;
      background: var(--vscode-sideBar-background);
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      cursor: move;
      user-select: none;
    }
    .erd-table.highlighted {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 2px var(--vscode-focusBorder), 0 2px 8px rgba(0,0,0,0.35);
    }
    .erd-table-header {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      padding: 6px 10px 5px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
      font-size: 12px;
    }
    .erd-table-header .hdr-top {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .erd-table-header .icon { font-size: 13px; }
    .erd-table-header .hdr-meta {
      font-size: 10px;
      font-weight: 400;
      opacity: 0.88;
      padding-left: 19px;
      line-height: 1.2;
      color: var(--vscode-button-foreground);
    }
    .erd-table-body { padding: 4px 0; }
    .erd-col {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 10px;
      font-size: 11px;
      white-space: nowrap;
    }
    .erd-col:hover { background: var(--vscode-list-hoverBackground); }
    .erd-col .col-icon { width: 14px; text-align: center; font-size: 10px; }
    .erd-col .col-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .erd-col .col-type { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .erd-col.pk .col-name { color: #f39c12; font-weight: 600; }
    .erd-col.fk .col-name { color: #3498db; }

    /* ── FK lines ────────────────────────────────────────────── */
    .fk-line {
      stroke: var(--vscode-descriptionForeground);
      stroke-width: 1.5;
      fill: none;
      opacity: 0.55;
    }
    .fk-line.active {
      stroke: var(--vscode-focusBorder);
      opacity: 1;
      stroke-width: 2;
    }
    marker#arrow path { fill: var(--vscode-descriptionForeground); }
    marker#arrow-active path { fill: var(--vscode-focusBorder); }

    /* ── Zoom controls ───────────────────────────────────────── */
    #zoom-controls {
      position: fixed;
      bottom: 16px;
      right: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      z-index: 100;
    }
    .zoom-btn {
      width: 28px; height: 28px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-editor-foreground);
      font-size: 15px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* ── Empty state ─────────────────────────────────────────── */
    #empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      gap: 8px;
    }
    #empty .icon { font-size: 48px; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>

<div id="toolbar">
  <h1>📊 ERD — <span id="schema-label"></span></h1>
  <span class="badge" id="stats-label"></span>
  <button class="tb-btn" onclick="resetLayout()">⟳ Reset Layout</button>
  <button class="tb-btn" onclick="fitView()">⊡ Fit View</button>
  <button class="tb-btn primary" onclick="exportSvg()">↓ Export SVG</button>
</div>

<div id="canvas-wrap">
  <div id="canvas">
    <svg id="fk-layer">
      <defs>
        <marker id="arrow" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z"/>
        </marker>
        <marker id="arrow-active" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z"/>
        </marker>
      </defs>
    </svg>
  </div>
</div>

<div id="zoom-controls">
  <button class="zoom-btn" title="Zoom in" onclick="zoom(0.15)">+</button>
  <button class="zoom-btn" title="Reset zoom" onclick="resetZoom()">⊙</button>
  <button class="zoom-btn" title="Zoom out" onclick="zoom(-0.15)">−</button>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // ── Data ──────────────────────────────────────────────────────────────────
  const tables = ${tablesJson};
  const foreignKeys = ${fksJson};
  const schema = ${JSON.stringify(schema)};

  // ── State ─────────────────────────────────────────────────────────────────
  const TABLE_W = 210;
  const COL_H = 22;
  const HEADER_H = 40;

  let scale = 1;
  let panX = 0, panY = 0;
  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let positions = {};     // tableName -> {x, y}
  let selectedTable = null;

  // ── DOM Refs ──────────────────────────────────────────────────────────────
  const canvasWrap = document.getElementById('canvas-wrap');
  const canvas = document.getElementById('canvas');
  const svgLayer = document.getElementById('fk-layer');

  // ── Init ──────────────────────────────────────────────────────────────────
  document.getElementById('schema-label').textContent = schema;
  document.getElementById('stats-label').textContent =
    tables.length + ' tables · ' + foreignKeys.length + ' FK links';

  if (tables.length === 0) {
    canvasWrap.innerHTML = '<div id="empty"><div class="icon">📂</div><p>No tables found in schema "' + schema + '".</p></div>';
  } else {
    initLayout();
    renderTables();
    renderFkLines();
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  function tableHeight(t) {
    return HEADER_H + t.columns.length * COL_H + 8;
  }

  function initLayout() {
    // Simple grid layout
    const cols = Math.ceil(Math.sqrt(tables.length));
    const padX = 40, padY = 40;
    const gapX = 60, gapY = 40;

    tables.forEach((t, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions[t.name] = {
        x: padX + col * (TABLE_W + gapX),
        y: padY + row * (tableHeight(t) + gapY),
      };
    });
  }

  // ── Render tables ─────────────────────────────────────────────────────────
  function renderTables() {
    // Remove existing table els
    document.querySelectorAll('.erd-table').forEach(el => el.remove());

    tables.forEach(t => {
      const pos = positions[t.name];
      const el = document.createElement('div');
      el.className = 'erd-table';
      el.id = 'tbl-' + t.name;
      el.style.left = pos.x + 'px';
      el.style.top = pos.y + 'px';
      el.style.width = TABLE_W + 'px';

      const header = document.createElement('div');
      header.className = 'erd-table-header';
      const meta =
        t.estRows !== undefined && t.estRows !== null && !Number.isNaN(Number(t.estRows))
          ? '<div class="hdr-meta" title="Approximate rows from pg_class.reltuples; run ANALYZE to refresh">' +
            escHtml(formatEstRows(t.estRows)) +
            '</div>'
          : '';
      header.innerHTML =
        '<div class="hdr-top"><span class="icon">▦</span><span class="hdr-title">' +
        escHtml(t.name) +
        '</span></div>' +
        meta;
      el.appendChild(header);

      const body = document.createElement('div');
      body.className = 'erd-table-body';
      t.columns.forEach(c => {
        const row = document.createElement('div');
        const cls = c.isPk ? 'pk' : c.isFk ? 'fk' : '';
        row.className = 'erd-col' + (cls ? ' ' + cls : '');
        const icon = c.isPk ? '🔑' : c.isFk ? '🔗' : '◦';
        row.innerHTML =
          '<span class="col-icon">' + icon + '</span>' +
          '<span class="col-name">' + escHtml(c.name) + '</span>' +
          '<span class="col-type">' + escHtml(c.type) + '</span>';
        body.appendChild(row);
      });
      el.appendChild(body);

      // Click to highlight
      el.addEventListener('mousedown', e => {
        if (e.button !== 0) { return; }
        startDrag(e, t.name, el);
      });
      header.addEventListener('click', e => {
        e.stopPropagation();
        selectTable(t.name === selectedTable ? null : t.name);
      });

      canvas.appendChild(el);
    });
  }

  // ── Selection & highlight ─────────────────────────────────────────────────
  function selectTable(name) {
    selectedTable = name;
    document.querySelectorAll('.erd-table').forEach(el => el.classList.remove('highlighted'));
    document.querySelectorAll('.fk-line').forEach(el => {
      el.classList.remove('active');
      el.setAttribute('marker-end', 'url(#arrow)');
    });

    if (!name) { return; }
    const tblEl = document.getElementById('tbl-' + name);
    if (tblEl) { tblEl.classList.add('highlighted'); }

    document.querySelectorAll('.fk-line[data-from="' + name + '"], .fk-line[data-to="' + name + '"]').forEach(line => {
      line.classList.add('active');
      line.setAttribute('marker-end', 'url(#arrow-active)');
      // Also highlight connected tables
      const peer = line.dataset.from === name ? line.dataset.to : line.dataset.from;
      const peerEl = document.getElementById('tbl-' + peer);
      if (peerEl) { peerEl.classList.add('highlighted'); }
    });
  }

  // ── FK Lines ──────────────────────────────────────────────────────────────
  function renderFkLines() {
    // Clear existing
    svgLayer.querySelectorAll('.fk-line').forEach(el => el.remove());

    // Update SVG size to cover canvas
    const allTableNames = tables.map(t => t.name);
    foreignKeys.forEach(fk => {
      if (!allTableNames.includes(fk.fromTable) || !allTableNames.includes(fk.toTable)) { return; }
      drawFkLine(fk);
    });
  }

  function colIndex(tableName, colName) {
    const t = tables.find(x => x.name === tableName);
    if (!t) { return 0; }
    const idx = t.columns.findIndex(c => c.name === colName);
    return idx < 0 ? 0 : idx;
  }

  function drawFkLine(fk) {
    const fromPos = positions[fk.fromTable];
    const toPos = positions[fk.toTable];
    if (!fromPos || !toPos) { return; }

    const fromH = HEADER_H + colIndex(fk.fromTable, fk.fromColumn) * COL_H + COL_H / 2;
    const toH = HEADER_H + colIndex(fk.toTable, fk.toColumn) * COL_H + COL_H / 2;

    const x1 = fromPos.x + TABLE_W;
    const y1 = fromPos.y + fromH;
    const x2 = toPos.x;
    const y2 = toPos.y + toH;

    // Use right side if target is to the right, else left
    const [sx, sy, ex, ey] = x1 < x2
      ? [fromPos.x + TABLE_W, fromPos.y + fromH, toPos.x, toPos.y + toH]
      : [fromPos.x, fromPos.y + fromH, toPos.x + TABLE_W, toPos.y + toH];

    const midX = (sx + ex) / 2;
    const d = 'M ' + sx + ' ' + sy + ' C ' + midX + ' ' + sy + ', ' + midX + ' ' + ey + ', ' + ex + ' ' + ey;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'fk-line');
    path.setAttribute('marker-end', 'url(#arrow)');
    path.dataset.from = fk.fromTable;
    path.dataset.to = fk.toTable;
    path.setAttribute('title', fk.constraintName);
    svgLayer.appendChild(path);
  }

  // ── Dragging tables ───────────────────────────────────────────────────────
  let dragEl = null, dragName = null, dragOffX = 0, dragOffY = 0;

  function startDrag(e, name, el) {
    dragEl = el;
    dragName = name;
    const rect = el.getBoundingClientRect();
    dragOffX = (e.clientX - rect.left) / scale;
    dragOffY = (e.clientY - rect.top) / scale;
    e.preventDefault();
    e.stopPropagation();
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragEl) { return; }
    const canvasRect = canvas.getBoundingClientRect();
    const x = (e.clientX - canvasRect.left) / scale - dragOffX;
    const y = (e.clientY - canvasRect.top) / scale - dragOffY;
    positions[dragName] = { x, y };
    dragEl.style.left = x + 'px';
    dragEl.style.top = y + 'px';
    renderFkLines();
  }

  function onDragEnd() {
    dragEl = null;
    dragName = null;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
  }

  // ── Canvas pan ────────────────────────────────────────────────────────────
  canvasWrap.addEventListener('mousedown', e => {
    if (e.button !== 0 || dragEl) { return; }
    isPanning = true;
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
    canvasWrap.classList.add('grabbing');
  });

  window.addEventListener('mousemove', e => {
    if (!isPanning) { return; }
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    isPanning = false;
    canvasWrap.classList.remove('grabbing');
  });

  canvasWrap.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    zoom(delta, e.clientX, e.clientY);
  }, { passive: false });

  // ── Zoom ──────────────────────────────────────────────────────────────────
  function zoom(delta, cx, cy) {
    const newScale = Math.max(0.2, Math.min(3, scale + delta));
    if (cx !== undefined && cy !== undefined) {
      // Zoom towards cursor
      const canvasRect = canvasWrap.getBoundingClientRect();
      const mouseX = cx - canvasRect.left;
      const mouseY = cy - canvasRect.top;
      panX = mouseX - (mouseX - panX) * (newScale / scale);
      panY = mouseY - (mouseY - panY) * (newScale / scale);
    }
    scale = newScale;
    applyTransform();
  }

  function resetZoom() {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  }

  function applyTransform() {
    canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  }

  function fitView() {
    if (tables.length === 0) { return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    tables.forEach(t => {
      const pos = positions[t.name];
      const h = tableHeight(t);
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + TABLE_W);
      maxY = Math.max(maxY, pos.y + h);
    });
    const wrapRect = canvasWrap.getBoundingClientRect();
    const cw = wrapRect.width, ch = wrapRect.height;
    const contentW = maxX - minX + 80;
    const contentH = maxY - minY + 80;
    const newScale = Math.min(cw / contentW, ch / contentH, 1);
    scale = newScale;
    panX = (cw - contentW * scale) / 2 - minX * scale + 40 * scale;
    panY = (ch - contentH * scale) / 2 - minY * scale + 40 * scale;
    applyTransform();
  }

  function resetLayout() {
    initLayout();
    renderTables();
    renderFkLines();
    fitView();
  }

  // Auto-fit on load
  setTimeout(fitView, 50);

  // ── Export ────────────────────────────────────────────────────────────────
  function exportSvg() {
    // Compute bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    tables.forEach(t => {
      const pos = positions[t.name];
      const h = tableHeight(t);
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + TABLE_W);
      maxY = Math.max(maxY, pos.y + h);
    });
    const pad = 30;
    const W = maxX - minX + pad * 2;
    const H = maxY - minY + pad * 2;

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" style="background:#1e1e1e;font-family:sans-serif">';

    // Arrow marker
    svg += '<defs><marker id="a" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#888"/></marker></defs>';

    // FK lines
    foreignKeys.forEach(fk => {
      const fromPos = positions[fk.fromTable];
      const toPos = positions[fk.toTable];
      if (!fromPos || !toPos) { return; }
      const fi = colIndex(fk.fromTable, fk.fromColumn);
      const ti = colIndex(fk.toTable, fk.toColumn);
      const [sx, sy, ex, ey] = fromPos.x < toPos.x
        ? [fromPos.x + TABLE_W, fromPos.y + HEADER_H + fi * COL_H + COL_H / 2, toPos.x, toPos.y + HEADER_H + ti * COL_H + COL_H / 2]
        : [fromPos.x, fromPos.y + HEADER_H + fi * COL_H + COL_H / 2, toPos.x + TABLE_W, toPos.y + HEADER_H + ti * COL_H + COL_H / 2];
      const mx = (sx + ex) / 2;
      const ox = sx - minX + pad, oy = sy - minY + pad, dx = ex - minX + pad, dy = ey - minY + pad;
      svg += '<path d="M ' + ox + ' ' + oy + ' C ' + (mx - minX + pad) + ' ' + oy + ', ' + (mx - minX + pad) + ' ' + dy + ', ' + dx + ' ' + dy + '" stroke="#888" stroke-width="1.5" fill="none" marker-end="url(#a)"/>';
    });

    // Tables
    tables.forEach(t => {
      const pos = positions[t.name];
      const h = tableHeight(t);
      const tx = pos.x - minX + pad;
      const ty = pos.y - minY + pad;

      svg += '<rect x="' + tx + '" y="' + ty + '" width="' + TABLE_W + '" height="' + h + '" fill="#252526" stroke="#3c3c3c" rx="4"/>';
      svg += '<rect x="' + tx + '" y="' + ty + '" width="' + TABLE_W + '" height="' + HEADER_H + '" fill="#0e639c" rx="4"/>';
      svg += '<rect x="' + tx + '" y="' + (ty + HEADER_H - 4) + '" width="' + TABLE_W + '" height="4" fill="#0e639c"/>';
      svg += '<text x="' + (tx + 10) + '" y="' + (ty + 17) + '" fill="#fff" font-weight="bold" font-size="12">' + escHtml(t.name) + '</text>';
      if (t.estRows !== undefined && t.estRows !== null && !Number.isNaN(Number(t.estRows))) {
        svg +=
          '<text x="' +
          (tx + 10) +
          '" y="' +
          (ty + 30) +
          '" fill="#cccccc" font-size="10">' +
          escHtml(formatEstRows(t.estRows)) +
          '</text>';
      }

      t.columns.forEach((c, i) => {
        const cy2 = ty + HEADER_H + i * COL_H + 15;
        const icon = c.isPk ? '🔑' : c.isFk ? '🔗' : '·';
        const color = c.isPk ? '#f39c12' : c.isFk ? '#3498db' : '#ccc';
        svg += '<text x="' + (tx + 8) + '" y="' + cy2 + '" fill="' + color + '" font-size="11">' + icon + ' ' + escHtml(c.name) + ' <tspan fill="#777">' + escHtml(c.type) + '</tspan></text>';
      });
    });

    svg += '</svg>';
    vscode.postMessage({ type: 'exportSvg', svg });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function formatEstRows(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x < 0) { return ''; }
    if (x >= 1e9) { return '~' + trimTrailingZero((x / 1e9).toFixed(1)) + 'B rows (est.)'; }
    if (x >= 1e6) { return '~' + trimTrailingZero((x / 1e6).toFixed(1)) + 'M rows (est.)'; }
    if (x >= 1e3) { return '~' + trimTrailingZero((x / 1e3).toFixed(1)) + 'k rows (est.)'; }
    return '~' + x + ' rows (est.)';
  }
  function trimTrailingZero(s) {
    return s.replace(/\.0$/, '');
  }
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
</script>
</body>
</html>`;
  }

  public dispose(): void {
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }
}
