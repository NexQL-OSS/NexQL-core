/**
 * ERD webview (bundled to dist/erd-webview.js).
 */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
} from 'd3-force';
import type {
  ErdForeignKey,
  ErdPartitionEdge,
  ErdRlsInfo,
  ErdTable,
  ErdWebviewPayload,
} from '../erdTypes';
import { tableQual } from '../erdTypes';
import { buildDbmlFromTables, buildMermaidFromTables } from '../erdExportSerializers';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

const TABLE_W = 220;
const COL_H = 22;
const HEADER_BASE = 36;
const LAYER_INDEX_ROW = 18;
const LAYER_RLS_ROW = 16;

type ErdModelPatch =
  | { kind: 'renameTable'; schema: string; from: string; to: string }
  | { kind: 'renameColumn'; schema: string; table: string; from: string; to: string }
  | {
      kind: 'addColumn';
      schema: string;
      table: string;
      name: string;
      dataType: string;
      notNull: boolean;
    };

interface LayerState {
  tables: boolean;
  fk: boolean;
  indexes: boolean;
  rls: boolean;
  partitions: boolean;
}

const layers: LayerState = {
  tables: true,
  fk: true,
  indexes: true,
  rls: true,
  partitions: true,
};

let payload = (window as unknown as { __ERD_INITIAL__?: ErdWebviewPayload }).__ERD_INITIAL__!;
let tables: ErdTable[] = [];
let foreignKeys: ErdForeignKey[] = [];
let partitionEdges: ErdPartitionEdge[] = [];
let rlsInfo: ErdRlsInfo[] = [];
const indexByTable = new Map<string, string[]>();
const patches: ErdModelPatch[] = [];
let collapsedSchemas = new Set<string>();
let selectedTable: string | null = null;
let positions: Record<string, { x: number; y: number }> = {};
let scale = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let dragEl: HTMLElement | null = null;
let dragName: string | null = null;
let dragOffX = 0;
let dragOffY = 0;

const canvasWrap = () => document.getElementById('canvas-wrap')!;
const canvas = () => document.getElementById('canvas')!;
const svgLayer = () => document.getElementById('fk-layer')!;
const schemaStripEl = () => document.getElementById('schema-strip')!;

function initFromPayload(): void {
  tables = JSON.parse(JSON.stringify(payload.snapshot.tables)) as ErdTable[];
  foreignKeys = [...payload.snapshot.foreignKeys];
  partitionEdges = [...payload.snapshot.partitions];
  rlsInfo = [...payload.snapshot.rls];
  indexByTable.clear();
  for (const row of payload.snapshot.indexes) {
    const k = tableQual(row.schema, row.tableName);
    if (!indexByTable.has(k)) {
      indexByTable.set(k, []);
    }
    indexByTable.get(k)!.push(row.indexName);
  }
  patches.length = 0;
  collapsedSchemas = new Set();
}

function tableHeight(t: ErdTable): number {
  let h = HEADER_BASE;
  if (layers.indexes && indexFor(t)) {
    h += LAYER_INDEX_ROW;
  }
  if (layers.rls && rlsFor(t)) {
    h += LAYER_RLS_ROW;
  }
  h += t.columns.length * COL_H + 8;
  return h;
}

function indexFor(t: ErdTable): string | undefined {
  const list = indexByTable.get(tableQual(t.schema, t.name));
  if (!list || list.length === 0) {
    return undefined;
  }
  return `${list.length} idx`;
}

function rlsFor(t: ErdTable): ErdRlsInfo | undefined {
  return rlsInfo.find((r) => r.schema === t.schema && r.tableName === t.name);
}

function schemaVisibleTables(): ErdTable[] {
  return tables.filter((t) => !collapsedSchemas.has(t.schema));
}

/** Tables drawn on canvas (respects layer toggle). */
function canvasTables(): ErdTable[] {
  if (!layers.tables) {
    return [];
  }
  return schemaVisibleTables();
}

function initGridLayout(): void {
  const vis = schemaVisibleTables();
  const cols = Math.ceil(Math.sqrt(Math.max(1, vis.length)));
  const padX = 40;
  const padY = 40;
  const gapX = 60;
  const gapY = 40;
  vis.forEach((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions[tableQual(t.schema, t.name)] = {
      x: padX + col * (TABLE_W + gapX),
      y: padY + row * (tableHeight(t) + gapY),
    };
  });
}

function runForceLayout(): void {
  const vis = schemaVisibleTables();
  if (vis.length === 0) {
    return;
  }
  const schemaOrder = [...new Set(payload.snapshot.schemas)].sort();
  const schemaStrength = 0.12;

  type SimNode = {
    id: string;
    schema: string;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
  };

  const nodes: SimNode[] = vis.map((t) => {
    const id = tableQual(t.schema, t.name);
    const p = positions[id] ?? { x: 200, y: 200 };
    return { id, schema: t.schema, x: p.x, y: p.y };
  });

  const linkSet = new Set<string>();
  const links: { source: string; target: string }[] = [];
  if (layers.fk) {
    for (const fk of foreignKeys) {
      const from = tableQual(fk.fromSchema, fk.fromTable);
      const toFix = tableQual(fk.toSchema, fk.toTable);
      if (!vis.some((t) => tableQual(t.schema, t.name) === from)) {
        continue;
      }
      if (!vis.some((t) => tableQual(t.schema, t.name) === toFix)) {
        continue;
      }
      const key = `${from}->${toFix}`;
      if (linkSet.has(key)) {
        continue;
      }
      linkSet.add(key);
      links.push({ source: from, target: toFix });
    }
  }

  const simLinks = links.map((l) => ({
    source: l.source,
    target: l.target,
  }));

  const si = (s: string) => schemaOrder.indexOf(s);
  const sim = forceSimulation(nodes as SimNode[])
    .force(
      'link',
      forceLink(simLinks)
        .id((d: unknown) => (d as SimNode).id)
        .distance(140)
        .strength(0.5)
    )
    .force('charge', forceManyBody().strength(-520))
    .force('center', forceCenter(500, 400))
    .force(
      'x',
      forceX()
        .x((d: unknown) => 200 + Math.max(0, si((d as SimNode).schema)) * 420)
        .strength(schemaStrength)
    )
    .force(
      'collide',
      forceCollide().radius((d: unknown) => {
        const id = (d as SimNode).id;
        const t = tables.find((x) => tableQual(x.schema, x.name) === id);
        return t ? tableHeight(t) / 2 + 24 : 80;
      })
    );

  for (let i = 0; i < 360; i += 1) {
    sim.tick();
  }
  sim.stop();

  for (const n of nodes) {
    positions[n.id] = { x: n.x, y: n.y };
  }
}

function renderSchemaStrip(): void {
  const el = schemaStripEl();
  el.innerHTML = '';
  const schemas = [...new Set(payload.snapshot.schemas)].sort();
  for (const sch of schemas) {
    const row = document.createElement('div');
    row.className = 'erd-strip-row';
    const collapsed = collapsedSchemas.has(sch);
    row.innerHTML =
      `<button type="button" class="erd-strip-toggle" data-schema="${escAttr(sch)}" aria-expanded="${!collapsed}">` +
      `<span class="chev">${collapsed ? '▸' : '▾'}</span> ${escHtml(sch)}` +
      `</button>`;
    row.querySelector('button')!.addEventListener('click', () => {
      if (collapsedSchemas.has(sch)) {
        collapsedSchemas.delete(sch);
      } else {
        collapsedSchemas.add(sch);
      }
      initGridLayout();
      renderAll();
      setTimeout(fitView, 30);
    });
    el.appendChild(row);
  }
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
  return escHtml(s).replace(/'/g, '&#39;');
}

function renderTables(): void {
  document.querySelectorAll('.erd-table').forEach((el) => el.remove());
  const c = canvas();
  if (!layers.tables) {
    return;
  }

  for (const t of canvasTables()) {
    const q = tableQual(t.schema, t.name);
    const pos = positions[q] ?? { x: 0, y: 0 };
    const el = document.createElement('div');
    el.className = 'erd-table';
    el.id = 'tbl-' + safeId(q);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.style.width = `${TABLE_W}px`;
    el.dataset.qual = q;

    const header = document.createElement('div');
    header.className = 'erd-table-header';
    const meta =
      t.estRows !== undefined &&
      t.estRows !== null &&
      !Number.isNaN(Number(t.estRows))
        ? `<div class="hdr-meta" title="Approximate rows from pg_class.reltuples">${escHtml(formatEstRows(t.estRows))}</div>`
        : '';

    const idxLine =
      layers.indexes && indexFor(t)
        ? `<div class="hdr-layer hdr-idx" title="Non-primary indexes">📇 ${escHtml(indexFor(t)!)}</div>`
        : '';
    const r = layers.rls ? rlsFor(t) : undefined;
    const rlsLine =
      r && (r.relrowsecurity || r.policies.length > 0)
        ? `<div class="hdr-layer hdr-rls" title="${escAttr(r.policies.join(', ') || 'RLS')}">` +
          `${r.relrowsecurity ? '🔒 RLS' : 'RLS off'}${r.policies.length ? ` · ${r.policies.length} pol.` : ''}` +
          `</div>`
        : '';

    header.innerHTML =
      `<div class="hdr-top"><span class="icon">▦</span>` +
      `<span class="hdr-title" data-qual="${escAttr(q)}" title="Double-click to rename">${escHtml(t.name)}</span>` +
      `<button type="button" class="hdr-addcol" data-qual="${escAttr(q)}" title="Add column">+</button></div>` +
      `<div class="hdr-schema">${escHtml(t.schema)}</div>` +
      meta +
      idxLine +
      rlsLine;

    el.appendChild(header);

    const titleEl = header.querySelector('.hdr-title') as HTMLElement;
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameTable(q, t.schema, t.name, titleEl);
    });

    (header.querySelector('.hdr-addcol') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      promptAddColumn(q, t.schema, t.name);
    });

    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.hdr-addcol')) {
        return;
      }
      e.stopPropagation();
      selectTable(selectedTable === q ? null : q);
    });

    const body = document.createElement('div');
    body.className = 'erd-table-body';
    for (const col of t.columns) {
      const row = document.createElement('div');
      const cls = col.isPk ? 'pk' : col.isFk ? 'fk' : '';
      row.className = 'erd-col' + (cls ? ` ${cls}` : '');
      const icon = col.isPk ? '🔑' : col.isFk ? '🔗' : '◦';
      row.innerHTML =
        `<span class="col-icon">${icon}</span>` +
        `<span class="col-name" data-c="${escAttr(col.name)}" data-q="${escAttr(q)}">${escHtml(col.name)}</span>` +
        `<span class="col-type">${escHtml(col.type)}</span>`;
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const cn = row.querySelector('.col-name') as HTMLElement;
        startRenameColumn(q, t.schema, t.name, col.name, cn);
      });
      body.appendChild(row);
    }
    el.appendChild(body);

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) {
        return;
      }
      const tgt = e.target as HTMLElement;
      if (
        tgt.closest('.erd-table-body') ||
        tgt.closest('.hdr-title') ||
        tgt.closest('.hdr-addcol') ||
        tgt.closest('button')
      ) {
        return;
      }
      startDrag(e, q, el);
    });

    c.appendChild(el);
  }
}

function startRenameTable(qual: string, schema: string, current: string, _el: HTMLElement): void {
  vscode.postMessage({ type: 'erdRenameTable', qual, schema, currentName: current });
}

function startRenameColumn(
  qual: string,
  schema: string,
  table: string,
  current: string,
  _el: HTMLElement
): void {
  vscode.postMessage({ type: 'erdRenameColumn', qual, schema, table, currentColumn: current });
}

function applyRenameTableResult(msg: Record<string, unknown>): void {
  const qual = String(msg.qual ?? '');
  const schema = String(msg.schema ?? '');
  const from = String(msg.from ?? '').trim();
  const to = String(msg.to ?? '').trim();
  if (!qual || !to || to === from) {
    return;
  }
  const t = tables.find((x) => tableQual(x.schema, x.name) === qual);
  if (!t || t.name !== from) {
    return;
  }
  patches.push({ kind: 'renameTable', schema, from, to });
  const oldQual = qual;
  const newQual = tableQual(schema, to);
  t.name = to;
  if (positions[oldQual]) {
    positions[newQual] = positions[oldQual];
    delete positions[oldQual];
  }
  if (selectedTable === oldQual) {
    selectedTable = newQual;
  }
  renderAll();
}

function applyRenameColumnResult(msg: Record<string, unknown>): void {
  const qual = String(msg.qual ?? '');
  const schema = String(msg.schema ?? '');
  const tableName = String(msg.table ?? '');
  const from = String(msg.from ?? '').trim();
  const toCol = String(msg.to ?? '').trim();
  if (!qual || !toCol || toCol === from) {
    return;
  }
  const t = tables.find((x) => tableQual(x.schema, x.name) === qual);
  if (!t) {
    return;
  }
  const col = t.columns.find((c) => c.name === from);
  if (!col) {
    return;
  }
  patches.push({ kind: 'renameColumn', schema, table: tableName, from, to: toCol });
  col.name = toCol;
  renderAll();
}

function promptAddColumn(qual: string, schema: string, table: string): void {
  vscode.postMessage({ type: 'erdAddColumn', qual, schema, table });
}

function applyAddColumnResult(msg: Record<string, unknown>): void {
  const qual = String(msg.qual ?? '');
  const schema = String(msg.schema ?? '');
  const tableName = String(msg.table ?? '');
  const name = String(msg.name ?? '').trim();
  const dataType = String(msg.dataType ?? 'text').trim();
  const notNull = Boolean(msg.notNull);
  if (!name) {
    return;
  }
  const t = tables.find((x) => tableQual(x.schema, x.name) === qual);
  if (!t) {
    return;
  }
  patches.push({
    kind: 'addColumn',
    schema,
    table: tableName,
    name,
    dataType,
    notNull,
  });
  t.columns.push({
    name,
    type: dataType,
    notNull,
    isPk: false,
    isFk: false,
  });
  renderAll();
}

function wireHostToWebviewMessages(): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') {
      return;
    }
    if (m.type === 'erdAddColumnResult') {
      applyAddColumnResult(m);
    } else if (m.type === 'erdRenameTableResult') {
      applyRenameTableResult(m);
    } else if (m.type === 'erdRenameColumnResult') {
      applyRenameColumnResult(m);
    }
  });
}

function selectTable(name: string | null): void {
  selectedTable = name;
  document.querySelectorAll('.erd-table').forEach((el) => el.classList.remove('highlighted'));
  document.querySelectorAll('.fk-line').forEach((el) => {
    el.classList.remove('active');
    (el as SVGElement).setAttribute('marker-end', 'url(#arrow)');
  });
  document.querySelectorAll('.part-line').forEach((el) => {
    el.classList.remove('active');
  });

  if (!name) {
    return;
  }
  const tblEl = document.getElementById('tbl-' + safeId(name));
  if (tblEl) {
    tblEl.classList.add('highlighted');
  }

  document.querySelectorAll(`.fk-line[data-from="${cssEsc(name)}"], .fk-line[data-to="${cssEsc(name)}"]`).forEach((line) => {
    line.classList.add('active');
    (line as SVGElement).setAttribute('marker-end', 'url(#arrow-active)');
    const peer =
      line.getAttribute('data-from') === name ? line.getAttribute('data-to') : line.getAttribute('data-from');
    if (peer) {
      const peerEl = document.getElementById('tbl-' + safeId(peer));
      if (peerEl) {
        peerEl.classList.add('highlighted');
      }
    }
  });
}

function cssEsc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeId(q: string): string {
  return encodeURIComponent(q).replace(/%/g, '_');
}

function colIndex(tableQualKey: string, colName: string): number {
  const t = tables.find((x) => tableQual(x.schema, x.name) === tableQualKey);
  if (!t) {
    return 0;
  }
  const idx = t.columns.findIndex((c) => c.name === colName);
  return idx < 0 ? 0 : idx;
}

function renderFkLines(): void {
  const svg = svgLayer();
  svg.querySelectorAll('.fk-line').forEach((el) => el.remove());
  if (!layers.fk) {
    return;
  }

  const visSet = new Set(canvasTables().map((t) => tableQual(t.schema, t.name)));
  for (const fk of foreignKeys) {
    const fq = tableQual(fk.fromSchema, fk.fromTable);
    const tq = tableQual(fk.toSchema, fk.toTable);
    if (!visSet.has(fq) || !visSet.has(tq)) {
      continue;
    }
    drawFkLine(fk);
  }
}

function drawFkLine(fk: ErdForeignKey): void {
  const fromPos = positions[tableQual(fk.fromSchema, fk.fromTable)];
  const toPos = positions[tableQual(fk.toSchema, fk.toTable)];
  if (!fromPos || !toPos) {
    return;
  }
  const fq = tableQual(fk.fromSchema, fk.fromTable);
  const tq = tableQual(fk.toSchema, fk.toTable);
  const fromT = tables.find((x) => tableQual(x.schema, x.name) === fq)!;
  const hdr = HEADER_BASE + (layers.indexes && indexFor(fromT) ? LAYER_INDEX_ROW : 0) + (layers.rls && rlsFor(fromT) ? LAYER_RLS_ROW : 0);

  const fromH = hdr + colIndex(fq, fk.fromColumn) * COL_H + COL_H / 2;
  const toT = tables.find((x) => tableQual(x.schema, x.name) === tq)!;
  const hdrT =
    HEADER_BASE +
    (layers.indexes && indexFor(toT) ? LAYER_INDEX_ROW : 0) +
    (layers.rls && rlsFor(toT) ? LAYER_RLS_ROW : 0);
  const toH = hdrT + colIndex(tq, fk.toColumn) * COL_H + COL_H / 2;

  const x1 = fromPos.x + TABLE_W;
  const y1 = fromPos.y + fromH;
  const x2 = toPos.x;
  const y2 = toPos.y + toH;

  const [sx, sy, ex, ey] =
    x1 < x2
      ? [fromPos.x + TABLE_W, fromPos.y + fromH, toPos.x, toPos.y + toH]
      : [fromPos.x, fromPos.y + fromH, toPos.x + TABLE_W, toPos.y + toH];

  const midX = (sx + ex) / 2;
  const d = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ey}, ${ex} ${ey}`;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'fk-line');
  path.setAttribute('marker-end', 'url(#arrow)');
  path.setAttribute('data-from', fq);
  path.setAttribute('data-to', tq);
  path.setAttribute('title', fk.constraintName);
  svgLayer().appendChild(path);
}

function renderPartitionLines(): void {
  const svg = svgLayer();
  svg.querySelectorAll('.part-line').forEach((el) => el.remove());
  if (!layers.partitions) {
    return;
  }
  const visSet = new Set(canvasTables().map((t) => tableQual(t.schema, t.name)));
  for (const pe of partitionEdges) {
    const pq = tableQual(pe.parentSchema, pe.parentTable);
    const cq = tableQual(pe.childSchema, pe.childTable);
    if (!visSet.has(pq) || !visSet.has(cq)) {
      continue;
    }
    const p1 = positions[pq];
    const p2 = positions[cq];
    if (!p1 || !p2) {
      continue;
    }
    const pt = tables.find((x) => tableQual(x.schema, x.name) === cq)!;
    const hdr =
      HEADER_BASE +
      (layers.indexes && indexFor(pt) ? LAYER_INDEX_ROW : 0) +
      (layers.rls && rlsFor(pt) ? LAYER_RLS_ROW : 0);
    const cy = p2.y + hdr / 2;
    const px = p1.x + TABLE_W / 2;
    const py = p1.y + tableHeight(tables.find((x) => tableQual(x.schema, x.name) === pq)!) / 2;
    const d = `M ${p2.x + TABLE_W / 2} ${cy} L ${px} ${py}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'part-line');
    path.setAttribute('data-from', cq);
    path.setAttribute('data-to', pq);
    path.setAttribute('title', 'partition');
    svg.appendChild(path);
  }
}

function startDrag(e: MouseEvent, name: string, el: HTMLElement): void {
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

function onDragMove(e: MouseEvent): void {
  if (!dragEl || !dragName) {
    return;
  }
  const cr = canvas().getBoundingClientRect();
  const x = (e.clientX - cr.left) / scale - dragOffX;
  const y = (e.clientY - cr.top) / scale - dragOffY;
  positions[dragName] = { x, y };
  dragEl.style.left = `${x}px`;
  dragEl.style.top = `${y}px`;
  renderFkLines();
  renderPartitionLines();
}

function onDragEnd(): void {
  dragEl = null;
  dragName = null;
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
}

function applyTransform(): void {
  canvas().style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
}

function zoom(delta: number, cx?: number, cy?: number): void {
  const newScale = Math.max(0.15, Math.min(3, scale + delta));
  if (cx !== undefined && cy !== undefined) {
    const canvasRect = canvasWrap().getBoundingClientRect();
    const mouseX = cx - canvasRect.left;
    const mouseY = cy - canvasRect.top;
    panX = mouseX - (mouseX - panX) * (newScale / scale);
    panY = mouseY - (mouseY - panY) * (newScale / scale);
  }
  scale = newScale;
  applyTransform();
}

function resetZoom(): void {
  scale = 1;
  panX = 0;
  panY = 0;
  applyTransform();
}

function fitView(): void {
  const vis = schemaVisibleTables();
  if (vis.length === 0) {
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of vis) {
    const q = tableQual(t.schema, t.name);
    const pos = positions[q];
    if (!pos) {
      continue;
    }
    const h = tableHeight(t);
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + TABLE_W);
    maxY = Math.max(maxY, pos.y + h);
  }
  const wrapRect = canvasWrap().getBoundingClientRect();
  const cw = wrapRect.width;
  const ch = wrapRect.height;
  const contentW = maxX - minX + 80;
  const contentH = maxY - minY + 80;
  const newScale = Math.min(cw / contentW, ch / contentH, 1);
  scale = newScale;
  panX = (cw - contentW * scale) / 2 - minX * scale + 40 * scale;
  panY = (ch - contentH * scale) / 2 - minY * scale + 40 * scale;
  applyTransform();
}

function renderAll(): void {
  renderSchemaStrip();
  renderTables();
  renderFkLines();
  renderPartitionLines();
  updateStats();
}

function updateStats(): void {
  const el = document.getElementById('stats-label');
  if (el) {
    el.textContent = `${schemaVisibleTables().length} tables · ${foreignKeys.length} FK · ${patches.length} pending edits`;
  }
}

function formatEstRows(n: number): string {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) {
    return '';
  }
  if (x >= 1e9) {
    return `~${trimTrailingZero((x / 1e9).toFixed(1))}B rows (est.)`;
  }
  if (x >= 1e6) {
    return `~${trimTrailingZero((x / 1e6).toFixed(1))}M rows (est.)`;
  }
  if (x >= 1e3) {
    return `~${trimTrailingZero((x / 1e3).toFixed(1))}k rows (est.)`;
  }
  return `~${x} rows (est.)`;
}

function trimTrailingZero(s: string): string {
  return s.replace(/\.0$/, '');
}

function buildExportSvg(): string {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of schemaVisibleTables()) {
    const q = tableQual(t.schema, t.name);
    const pos = positions[q];
    if (!pos) {
      continue;
    }
    const h = tableHeight(t);
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + TABLE_W);
    maxY = Math.max(maxY, pos.y + h);
  }
  const pad = 30;
  const W = maxX - minX + pad * 2;
  const H = maxY - minY + pad * 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#1e1e1e;font-family:sans-serif">`;
  svg +=
    '<defs><marker id="a" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#888"/></marker></defs>';

  if (layers.fk) {
    const visSet = new Set(schemaVisibleTables().map((t) => tableQual(t.schema, t.name)));
    for (const fk of foreignKeys) {
      const fq = tableQual(fk.fromSchema, fk.fromTable);
      const tq = tableQual(fk.toSchema, fk.toTable);
      if (!visSet.has(fq) || !visSet.has(tq)) {
        continue;
      }
      const fromPos = positions[fq];
      const toPos = positions[tq];
      if (!fromPos || !toPos) {
        continue;
      }
      const fromT = tables.find((x) => tableQual(x.schema, x.name) === fq)!;
      const toT = tables.find((x) => tableQual(x.schema, x.name) === tq)!;
      const hdrF =
        HEADER_BASE +
        (layers.indexes && indexFor(fromT) ? LAYER_INDEX_ROW : 0) +
        (layers.rls && rlsFor(fromT) ? LAYER_RLS_ROW : 0);
      const hdrT =
        HEADER_BASE +
        (layers.indexes && indexFor(toT) ? LAYER_INDEX_ROW : 0) +
        (layers.rls && rlsFor(toT) ? LAYER_RLS_ROW : 0);
      const fi = colIndex(fq, fk.fromColumn);
      const ti = colIndex(tq, fk.toColumn);
      const [sx, sy, ex, ey] =
        fromPos.x < toPos.x
          ? [
              fromPos.x + TABLE_W,
              fromPos.y + hdrF + fi * COL_H + COL_H / 2,
              toPos.x,
              toPos.y + hdrT + ti * COL_H + COL_H / 2,
            ]
          : [
              fromPos.x,
              fromPos.y + hdrF + fi * COL_H + COL_H / 2,
              toPos.x + TABLE_W,
              toPos.y + hdrT + ti * COL_H + COL_H / 2,
            ];
      const mx = (sx + ex) / 2;
      const ox = sx - minX + pad;
      const oy = sy - minY + pad;
      const dx = ex - minX + pad;
      const dy = ey - minY + pad;
      svg += `<path d="M ${ox} ${oy} C ${mx - minX + pad} ${oy}, ${mx - minX + pad} ${dy}, ${dx} ${dy}" stroke="#888" stroke-width="1.5" fill="none" marker-end="url(#a)"/>`;
    }
  }

  for (const t of schemaVisibleTables()) {
    const q = tableQual(t.schema, t.name);
    const pos = positions[q];
    if (!pos) {
      continue;
    }
    const h = tableHeight(t);
    const tx = pos.x - minX + pad;
    const ty = pos.y - minY + pad;
    svg += `<rect x="${tx}" y="${ty}" width="${TABLE_W}" height="${h}" fill="#252526" stroke="#3c3c3c" rx="4"/>`;
    svg += `<rect x="${tx}" y="${ty}" width="${TABLE_W}" height="${HEADER_BASE}" fill="#0e639c" rx="4"/>`;
    svg += `<text x="${tx + 10}" y="${ty + 22}" fill="#fff" font-weight="bold" font-size="12">${escHtml(t.name)}</text>`;
    let yOff = HEADER_BASE;
    if (layers.indexes && indexFor(t)) {
      svg += `<text x="${tx + 8}" y="${ty + yOff + 12}" fill="#aaa" font-size="10">idx: ${escHtml(indexFor(t)!)}</text>`;
      yOff += LAYER_INDEX_ROW;
    }
    if (layers.rls) {
      const r = rlsFor(t);
      if (r && (r.relrowsecurity || r.policies.length)) {
        svg += `<text x="${tx + 8}" y="${ty + yOff + 12}" fill="#9cdcfe" font-size="10">RLS ${r.policies.length}</text>`;
        yOff += LAYER_RLS_ROW;
      }
    }
    t.columns.forEach((c, i) => {
      const cy2 = ty + yOff + i * COL_H + 15;
      const icon = c.isPk ? '🔑' : c.isFk ? '🔗' : '·';
      const color = c.isPk ? '#f39c12' : c.isFk ? '#3498db' : '#ccc';
      svg += `<text x="${tx + 8}" y="${cy2}" fill="${color}" font-size="11">${icon} ${escHtml(c.name)} <tspan fill="#777">${escHtml(c.type)}</tspan></text>`;
    });
  }

  svg += '</svg>';
  return svg;
}

function exportSvg(): void {
  vscode.postMessage({ type: 'exportSvg', svg: buildExportSvg() });
}

function exportPng(): void {
  const svg = buildExportSvg();
  const img = new Image();
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  img.onload = () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.width = img.width || 1200;
    canvasEl.height = img.height || 800;
    const ctx = canvasEl.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.drawImage(img, 0, 0);
      const data = canvasEl.toDataURL('image/png').split(',')[1];
      vscode.postMessage({ type: 'exportPng', base64: data });
    }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function exportText(kind: 'mermaid' | 'dbml'): void {
  const mermaid = buildMermaidFromTables(tables, foreignKeys);
  const dbml = buildDbmlFromTables(tables, foreignKeys);
  vscode.postMessage({
    type: 'exportText',
    kind,
    content: kind === 'mermaid' ? mermaid : dbml,
  });
}

function syncMigration(): void {
  vscode.postMessage({
    type: 'syncMigration',
    patches: [...patches],
    readOnly: payload.readOnlyConnection,
  });
}

function wireToolbar(): void {
  const toolbarActions: Record<string, () => void> = {
    autoLayout: () => {
      runForceLayout();
      renderAll();
      fitView();
    },
    resetLayout: () => {
      initGridLayout();
      runForceLayout();
      renderAll();
      fitView();
    },
    fitView,
    syncMigration,
    exportSvg,
    exportPng,
    exportMermaid: () => exportText('mermaid'),
    exportDbml: () => exportText('dbml'),
    printErd: () => window.print(),
  };

  document.querySelectorAll<HTMLElement>('[data-erd-action]').forEach((btn) => {
    const action = btn.dataset.erdAction;
    if (!action || !toolbarActions[action]) {
      return;
    }
    btn.addEventListener('click', () => toolbarActions[action]());
  });

  document.querySelectorAll<HTMLElement>('[data-erd-zoom]').forEach((btn) => {
    const z = btn.dataset.erdZoom;
    btn.addEventListener('click', () => {
      if (z === 'in') {
        zoom(0.15);
      } else if (z === 'out') {
        zoom(-0.15);
      } else if (z === 'reset') {
        resetZoom();
      }
    });
  });

  const bindLayer = (id: string, key: keyof LayerState) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.checked = layers[key];
      el.addEventListener('change', () => {
        layers[key] = el.checked;
        renderAll();
      });
    }
  };
  bindLayer('layer-tables', 'tables');
  bindLayer('layer-fk', 'fk');
  bindLayer('layer-idx', 'indexes');
  bindLayer('layer-rls', 'rls');
  bindLayer('layer-part', 'partitions');
}

function wireCanvas(): void {
  canvasWrap().addEventListener('mousedown', (e) => {
    if (e.button !== 0 || dragEl) {
      return;
    }
    isPanning = true;
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
    canvasWrap().classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!isPanning) {
      return;
    }
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    isPanning = false;
    canvasWrap().classList.remove('grabbing');
  });
  canvasWrap().addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      zoom(delta, e.clientX, e.clientY);
    },
    { passive: false }
  );
}

function boot(): void {
  payload = (window as unknown as { __ERD_INITIAL__: ErdWebviewPayload }).__ERD_INITIAL__;
  if (!payload?.snapshot) {
    return;
  }
  initFromPayload();
  document.getElementById('schema-title')!.textContent = payload.snapshot.schemas.join(', ');
  document.getElementById('read-badge')!.style.display = payload.readOnlyConnection ? 'inline' : 'none';

  if (tables.length === 0) {
    canvasWrap().innerHTML =
      '<div id="empty"><div class="icon">📂</div><p>No tables in selected schema(s).</p></div>';
    return;
  }

  initGridLayout();
  runForceLayout();
  wireHostToWebviewMessages();
  wireToolbar();
  wireCanvas();
  renderAll();
  setTimeout(fitView, 50);
}

boot();
