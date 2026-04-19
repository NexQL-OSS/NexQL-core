import * as vscode from 'vscode';
import type { QueryResults } from '../../common/types';

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal markdown → HTML for export (headers + paragraphs). */
export function simpleMarkdownToHtml(md: string): string {
  const lines = md.split(/\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trimEnd();
    if (t === '') {
      out.push('<p class="md-spacer"></p>');
      continue;
    }
    let m = /^###\s+(.+)$/.exec(t);
    if (m) {
      out.push(`<h3>${escapeHtml(m[1])}</h3>`);
      continue;
    }
    m = /^##\s+(.+)$/.exec(t);
    if (m) {
      out.push(`<h2>${escapeHtml(m[1])}</h2>`);
      continue;
    }
    m = /^#\s+(.+)$/.exec(t);
    if (m) {
      out.push(`<h1>${escapeHtml(m[1])}</h1>`);
      continue;
    }
    out.push(`<p>${escapeHtml(t)}</p>`);
  }
  return out.join('\n');
}

function tryParseQueryResultFromOutput(cell: vscode.NotebookCell): QueryResults | null {
  for (const output of cell.outputs) {
    for (const item of output.items) {
      if (
        item.mime === 'application/vnd.postgres-notebook.result' ||
        item.mime === 'application/x-postgres-result'
      ) {
        try {
          const text = new TextDecoder().decode(item.data as Uint8Array);
          return JSON.parse(text) as QueryResults;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function tryParseErrorFromOutput(cell: vscode.NotebookCell): string | null {
  for (const output of cell.outputs) {
    for (const item of output.items) {
      if (item.mime === 'application/vnd.postgres-notebook.error') {
        try {
          const text = new TextDecoder().decode(item.data as Uint8Array);
          const j = JSON.parse(text) as { error?: string };
          return j.error ?? text;
        } catch {
          return new TextDecoder().decode(item.data as Uint8Array);
        }
      }
    }
  }
  return null;
}

function renderResultTable(data: QueryResults): string {
  const cols = data.columns ?? [];
  const rows = data.rows ?? [];
  if (cols.length === 0) {
    return `<p class="muted">No columns in result.</p>`;
  }
  const thead = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const tbody = rows
    .map((row) => {
      const cells = cols.map((c) => {
        const v = row[c];
        const s = v === null || v === undefined ? '' : String(v);
        return `<td>${escapeHtml(s)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('\n');
  const meta = [
    data.rowCount != null ? `${data.rowCount} row(s)` : '',
    data.executionTime != null ? `${data.executionTime.toFixed(3)}s` : '',
    data.command ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `
<div class="result-meta">${escapeHtml(meta)}</div>
<table class="result-grid"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

export function serializeNotebookForGist(doc: vscode.NotebookDocument): { filename: string; json: string } {
  const rawName = doc.uri.path.split('/').pop() || 'notebook.pgsql';
  const filename = rawName.endsWith('.pgsql') ? rawName : `${rawName}.pgsql`;
  const cells = doc.getCells().map((c) => ({
    value: c.document.getText(),
    kind: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql',
    language: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql',
  }));
  const meta = { ...(doc.metadata as Record<string, unknown>) };
  delete meta.password;
  delete meta.custom;
  const json = JSON.stringify({ cells, metadata: meta }, null, 2);
  return { filename, json };
}

const EXPORT_CSS = `
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1rem 1.5rem; max-width: 56rem; margin-inline: auto; line-height: 1.45; }
h1 { font-size: 1.35rem; }
h2 { font-size: 1.15rem; }
h3 { font-size: 1.05rem; }
pre.sql { background: color-mix(in srgb, Canvas 92%, CanvasText 8%); padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.md-spacer { margin: 0.25rem 0; }
.section { margin-bottom: 1.75rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); padding-bottom: 1rem; }
.cell-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: color-mix(in srgb, CanvasText 55%, transparent); margin-bottom: 0.35rem; }
.result-meta { font-size: 0.8rem; color: color-mix(in srgb, CanvasText 60%, transparent); margin: 0.5rem 0; }
.result-grid { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.result-grid th, .result-grid td { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
.result-grid thead { background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
.error-box { background: color-mix(in srgb, #c00 12%, transparent); padding: 0.75rem; border-radius: 6px; white-space: pre-wrap; }
.muted { color: color-mix(in srgb, CanvasText 50%, transparent); }
header.doc-title { margin-bottom: 1.5rem; }
header.doc-title h1 { margin: 0 0 0.25rem 0; }
@media print {
  body { padding: 0; max-width: none; }
  .section { break-inside: avoid; }
}
`;

/**
 * Builds a standalone HTML document from the current notebook cells and outputs.
 */
export function buildNotebookHtmlDocument(doc: vscode.NotebookDocument, title: string): string {
  const parts: string[] = [];
  let i = 0;
  for (const cell of doc.getCells()) {
    i++;
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const html = simpleMarkdownToHtml(cell.document.getText());
      parts.push(
        `<section class="section"><div class="cell-label">Markdown · cell ${i}</div><div class="md">${html}</div></section>`,
      );
      continue;
    }
    const sql = cell.document.getText();
    const sqlInner: string[] = [
      `<div class="cell-label">SQL · cell ${i}</div><pre class="sql">${escapeHtml(sql)}</pre>`,
    ];
    const err = tryParseErrorFromOutput(cell);
    if (err) {
      sqlInner.push(`<div class="error-box">${escapeHtml(err)}</div>`);
      parts.push(`<section class="section">${sqlInner.join('\n')}</section>`);
      continue;
    }
    const result = tryParseQueryResultFromOutput(cell);
    if (result && result.success !== false && result.columns?.length) {
      sqlInner.push(`<div class="result-wrap">${renderResultTable(result)}</div>`);
    } else if (result && result.success === false) {
      sqlInner.push(
        `<div class="error-box">${escapeHtml(String((result as any).error ?? 'Query failed'))}</div>`,
      );
    } else if (result) {
      const cmd = result.command ?? 'statement';
      const rc = result.rowCount != null ? `${result.rowCount} row(s)` : '';
      sqlInner.push(`<p class="muted">${escapeHtml([cmd, rc].filter(Boolean).join(' · '))}</p>`);
    }
    parts.push(`<section class="section">${sqlInner.join('\n')}</section>`);
  }

  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>${EXPORT_CSS}</style>
</head>
<body>
  <header class="doc-title">
    <h1>${safeTitle}</h1>
    <p class="muted">Exported from PgStudio · Use your browser’s Print dialog to save as PDF.</p>
  </header>
  ${parts.join('\n')}
</body>
</html>`;
}
