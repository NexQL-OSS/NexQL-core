import * as vscode from 'vscode';
import type { ErdWebviewPayload } from './erdTypes';

/**
 * Build ERD webview document with CSP, external bundle, and initial state JSON.
 */
export function buildErdWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  payload: ErdWebviewPayload
): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join('; ');

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'erd-webview.js'));
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>ERD</title>
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
    #main-wrap { display: flex; height: 100vh; }
    #schema-strip {
      width: 150px;
      flex-shrink: 0;
      background: var(--vscode-sideBar-background);
      border-right: 1px solid var(--vscode-panel-border);
      padding: 8px 6px;
      overflow-y: auto;
    }
    .erd-strip-row { margin-bottom: 4px; }
    .erd-strip-toggle {
      width: 100%;
      text-align: left;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      background: var(--vscode-list-inactiveSelectionBackground);
      color: var(--vscode-editor-foreground);
      font-size: 11px;
      cursor: pointer;
    }
    .erd-strip-toggle:hover { filter: brightness(1.08); }
    #body-col { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    #toolbar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      padding: 6px 10px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      z-index: 100;
    }
    #toolbar h1 { font-size: 13px; font-weight: 600; }
    .tb-btn {
      padding: 3px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .tb-btn:hover { filter: brightness(1.12); }
    .tb-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .layer-toggles { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 11px; }
    .layer-toggles label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    #canvas-wrap {
      flex: 1;
      position: relative;
      overflow: hidden;
      cursor: grab;
    }
    #canvas-wrap.grabbing { cursor: grabbing; }
    #canvas {
      position: absolute; top: 0; left: 0;
      transform-origin: 0 0;
    }
    svg#fk-layer { position: absolute; top: 0; left: 0; pointer-events: none; overflow: visible; }
    .erd-table {
      position: absolute;
      min-width: 180px; max-width: 260px;
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
      display: flex; flex-direction: column; align-items: stretch; gap: 1px;
      padding: 5px 8px 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600; font-size: 12px;
    }
    .erd-table-header .hdr-top { display: flex; align-items: center; gap: 4px; }
    .erd-table-header .hdr-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .erd-table-header .hdr-addcol {
      padding: 0 6px; font-size: 14px; line-height: 1;
      border: none; border-radius: 2px;
      background: rgba(255,255,255,0.15);
      color: inherit; cursor: pointer;
    }
    .erd-table-header .hdr-schema { font-size: 10px; font-weight: 400; opacity: 0.85; }
    .erd-table-header .hdr-meta { font-size: 10px; font-weight: 400; opacity: 0.88; }
    .erd-table-header .hdr-layer { font-size: 10px; font-weight: 400; padding-left: 2px; }
    .erd-table-body { padding: 3px 0; }
    .erd-col { display: flex; align-items: center; gap: 5px; padding: 2px 8px; font-size: 11px; white-space: nowrap; }
    .erd-col:hover { background: var(--vscode-list-hoverBackground); }
    .erd-col .col-icon { width: 14px; text-align: center; font-size: 10px; }
    .erd-col .col-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .erd-col .col-type { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .erd-col.pk .col-name { color: #f39c12; font-weight: 600; }
    .erd-col.fk .col-name { color: #3498db; }
    .fk-line { stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; fill: none; opacity: 0.55; }
    .fk-line.active { stroke: var(--vscode-focusBorder); opacity: 1; stroke-width: 2; }
    .part-line { stroke: #9b59b6; stroke-width: 1.2; stroke-dasharray: 4 3; fill: none; opacity: 0.65; }
    marker#arrow path { fill: var(--vscode-descriptionForeground); }
    marker#arrow-active path { fill: var(--vscode-focusBorder); }
    #zoom-controls {
      position: fixed; bottom: 16px; right: 16px;
      display: flex; flex-direction: column; gap: 4px; z-index: 100;
    }
    .zoom-btn {
      width: 28px; height: 28px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-editor-foreground);
      font-size: 15px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    #empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); gap: 8px; }
    @media print {
      #toolbar, #schema-strip, #zoom-controls { display: none !important; }
      #canvas-wrap { overflow: visible !important; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
<div id="main-wrap">
  <div id="schema-strip" aria-label="Schemas"></div>
  <div id="body-col">
    <div id="toolbar">
      <h1>ERD — <span id="schema-title"></span></h1>
      <span class="badge" id="stats-label"></span>
      <span id="read-badge" style="display:none;font-size:11px;color:var(--vscode-inputValidation-warningForeground);">read-only connection</span>
      <div class="layer-toggles">
        <label><input type="checkbox" id="layer-tables" checked /> tables</label>
        <label><input type="checkbox" id="layer-fk" checked /> FK</label>
        <label><input type="checkbox" id="layer-idx" checked /> indexes</label>
        <label><input type="checkbox" id="layer-rls" checked /> RLS</label>
        <label><input type="checkbox" id="layer-part" checked /> partitions</label>
      </div>
      <button type="button" class="tb-btn" data-erd-action="autoLayout">⚡ Auto layout</button>
      <button type="button" class="tb-btn" data-erd-action="resetLayout">⟳ Grid</button>
      <button type="button" class="tb-btn" data-erd-action="fitView">⊡ Fit</button>
      <button type="button" class="tb-btn primary" data-erd-action="syncMigration">Sync migration…</button>
      <button type="button" class="tb-btn" data-erd-action="exportSvg">SVG</button>
      <button type="button" class="tb-btn" data-erd-action="exportPng">PNG</button>
      <button type="button" class="tb-btn" data-erd-action="exportMermaid">Mermaid</button>
      <button type="button" class="tb-btn" data-erd-action="exportDbml">DBML</button>
      <button type="button" class="tb-btn" data-erd-action="printErd">Print / PDF</button>
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
      <button type="button" class="zoom-btn" title="Zoom in" data-erd-zoom="in">+</button>
      <button type="button" class="zoom-btn" title="Reset zoom" data-erd-zoom="reset">⊙</button>
      <button type="button" class="zoom-btn" title="Zoom out" data-erd-zoom="out">−</button>
    </div>
  </div>
</div>
<script nonce="${nonce}">window.__ERD_INITIAL__ = ${safeJson};</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
