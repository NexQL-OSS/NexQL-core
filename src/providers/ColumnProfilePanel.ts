import * as vscode from 'vscode';
import { ConnectionManager } from '../services/ConnectionManager';
import { SecretStorageService } from '../services/SecretStorageService';
import { disposePooledOwner, WebviewPool } from '../utils/WebviewPool';

/**
 * Column Profiling Panel (Phase 3.4)
 *
 * Displays deep statistical analysis for a single table column in a dedicated
 * webview panel.  Metrics include:
 *   - Row / null / distinct / blank counts
 *   - Min, max, average (numeric / date columns)
 *   - Average and max string length (text columns)
 *   - Top-10 most-frequent values with relative frequency bars
 *   - 10-bucket histogram (numeric columns, uses width_bucket)
 *
 * For large tables (>100 k estimated rows) all queries are run on a 10 %
 * BERNOULLI sample to keep response times snappy.
 */
export class ColumnProfilePanel {
  public static readonly viewType = 'pgStudio.columnProfile';

  // One panel per (connectionId + database + schema + table + column)
  private static _panels = new Map<string, ColumnProfilePanel>();

  public readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
  }

  public dispose(isRecycling = false): void {
    const key = [...ColumnProfilePanel._panels.entries()]
      .find(([, v]) => v === this)?.[0];
    if (key) { ColumnProfilePanel._panels.delete(key); }
    if (!isRecycling) {
      this._panel.dispose();
    }
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public static async open(
    connectionId: string,
    database: string,
    schema: string,
    table: string,
    column: string,
    columnType: string,
    context: vscode.ExtensionContext
  ): Promise<void> {
    const panelKey = `colprofile:${connectionId}:${database}:${schema}:${table}:${column}`;

    // Re-use existing panel if already open
    if (ColumnProfilePanel._panels.has(panelKey)) {
      ColumnProfilePanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    // Resolve connection config
    const connections = vscode.workspace.getConfiguration()
      .get<any[]>('postgresExplorer.connections') || [];
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) {
      vscode.window.showErrorMessage('Column Profile: connection not found.');
      return;
    }

    const password = await SecretStorageService.getInstance().getPassword(connectionId);
    // password may be undefined for connections without a stored password – continue anyway.

    let client: any;
    try {
      client = await ConnectionManager.getInstance().getPooledClient({
        id: conn.id,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        database,
        name: conn.name,
        password: password ?? undefined,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Column Profile: could not connect – ${err.message}`);
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Profiling column "${schema}"."${table}"."${column}"…`,
          cancellable: false,
        },
        async () => {
          // -------------------------------------------------------------------
          // 1. Check approximate row count (pg_class.reltuples)
          // -------------------------------------------------------------------
          const reltuplesResult = await client.query(
            `SELECT reltuples::bigint AS est_rows
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = $1 AND n.nspname = $2`,
            [table, schema]
          );
          const estRows: number = Number(reltuplesResult.rows[0]?.est_rows ?? 0);
          const useSample = estRows > 100_000;
          const sampleClause = useSample ? 'TABLESAMPLE BERNOULLI(10)' : '';

          // -------------------------------------------------------------------
          // 2. Basic stats
          // -------------------------------------------------------------------
          const basicResult = await client.query(
            `SELECT
               COUNT(*) AS total_rows,
               COUNT("${column}") AS non_null_count,
               COUNT(*) - COUNT("${column}") AS null_count,
               COUNT(DISTINCT "${column}") AS distinct_count,
               COUNT(CASE WHEN "${column}"::text = '' THEN 1 END) AS blank_count
             FROM "${schema}"."${table}" ${sampleClause}`
          );
          const basic = basicResult.rows[0] || {};

          // -------------------------------------------------------------------
          // 3. Numeric / date stats (min / max / avg)
          // -------------------------------------------------------------------
          const isNumericOrDate = /^(smallint|integer|int|bigint|numeric|decimal|real|double|float|money|serial|timestamp|date|time|interval)/.test(
            columnType.toLowerCase()
          );
          let numericStats: any = {};
          if (isNumericOrDate) {
            const numResult = await client.query(
              `SELECT
                 MIN("${column}") AS min_val,
                 MAX("${column}") AS max_val,
                 AVG("${column}"::numeric) AS avg_val
               FROM "${schema}"."${table}" ${sampleClause}
               WHERE "${column}" IS NOT NULL`
            );
            numericStats = numResult.rows[0] || {};
          }

          // -------------------------------------------------------------------
          // 4. String length stats (text columns)
          // -------------------------------------------------------------------
          const isText = /^(char|varchar|text|name|citext|bpchar)/.test(columnType.toLowerCase());
          let strStats: any = {};
          if (isText) {
            const strResult = await client.query(
              `SELECT
                 AVG(LENGTH("${column}")) AS avg_length,
                 MAX(LENGTH("${column}")) AS max_length
               FROM "${schema}"."${table}" ${sampleClause}
               WHERE "${column}" IS NOT NULL`
            );
            strStats = strResult.rows[0] || {};
          }

          // -------------------------------------------------------------------
          // 5. Top-10 most frequent values
          // -------------------------------------------------------------------
          const topResult = await client.query(
            `SELECT "${column}"::text AS value, COUNT(*) AS frequency
             FROM "${schema}"."${table}" ${sampleClause}
             WHERE "${column}" IS NOT NULL
             GROUP BY "${column}"
             ORDER BY COUNT(*) DESC
             LIMIT 10`
          );
          const topValues: Array<{ value: string; frequency: number }> = topResult.rows.map(
            (r: any) => ({ value: String(r.value), frequency: Number(r.frequency) })
          );

          // -------------------------------------------------------------------
          // 6. Histogram (numeric columns only)
          // -------------------------------------------------------------------
          let histogramBuckets: Array<{ bucket: number; lo: string; hi: string; count: number }> = [];
          if (isNumericOrDate && numericStats.min_val !== null && numericStats.max_val !== null) {
            const minN = Number(numericStats.min_val);
            const maxN = Number(numericStats.max_val);
            if (minN < maxN) {
              const histResult = await client.query(
                `WITH bounds AS (
                   SELECT MIN("${column}"::numeric) AS lo, MAX("${column}"::numeric) AS hi
                   FROM "${schema}"."${table}" ${sampleClause}
                   WHERE "${column}" IS NOT NULL
                 )
                 SELECT
                   width_bucket("${column}"::numeric, b.lo, b.hi + 1e-10, 10) AS bucket,
                   MIN("${column}"::numeric) AS lo,
                   MAX("${column}"::numeric) AS hi,
                   COUNT(*) AS count
                 FROM "${schema}"."${table}" ${sampleClause}
                 CROSS JOIN bounds b
                 WHERE "${column}" IS NOT NULL
                 GROUP BY bucket
                 ORDER BY bucket`
              );
              histogramBuckets = histResult.rows.map((r: any) => ({
                bucket: Number(r.bucket),
                lo: String(r.lo),
                hi: String(r.hi),
                count: Number(r.count),
              }));
            }
          }

          // -------------------------------------------------------------------
          // Build the webview panel
          // -------------------------------------------------------------------
          const { panel, commit } = WebviewPool.getInstance().getOrCreate(
            ColumnProfilePanel.viewType,
            panelKey,
            `Column: ${table}.${column}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
            {
              onDispose: () => {
                disposePooledOwner(ColumnProfilePanel._panels, panel, false);
              },
              onRecycle: (recycled) => {
                disposePooledOwner(ColumnProfilePanel._panels, recycled.panel, true);
              },
            }
          );

          const cpPanel = new ColumnProfilePanel(panel);
          ColumnProfilePanel._panels.set(panelKey, cpPanel);
          commit?.();

          panel.webview.html = ColumnProfilePanel._buildHtml({
            schema,
            table,
            column,
            columnType,
            estRows,
            useSample,
            basic,
            numericStats,
            strStats,
            isNumericOrDate,
            isText,
            topValues,
            histogramBuckets,
          });
        }
      );
    } finally {
      if (client?.release) { client.release(); }
    }
  }

  // ---------------------------------------------------------------------------
  // HTML builder
  // ---------------------------------------------------------------------------

  private static _buildHtml(data: {
    schema: string;
    table: string;
    column: string;
    columnType: string;
    estRows: number;
    useSample: boolean;
    basic: any;
    numericStats: any;
    strStats: any;
    isNumericOrDate: boolean;
    isText: boolean;
    topValues: Array<{ value: string; frequency: number }>;
    histogramBuckets: Array<{ bucket: number; lo: string; hi: string; count: number }>;
  }): string {
    const {
      schema, table, column, columnType, estRows, useSample,
      basic, numericStats, strStats, isNumericOrDate, isText,
      topValues, histogramBuckets,
    } = data;

    const totalRows = Number(basic.total_rows ?? 0);
    const nullCount = Number(basic.null_count ?? 0);
    const nonNullCount = Number(basic.non_null_count ?? 0);
    const distinctCount = Number(basic.distinct_count ?? 0);
    const blankCount = Number(basic.blank_count ?? 0);

    const nullPct = totalRows > 0 ? ((nullCount / totalRows) * 100).toFixed(1) : '0.0';
    const distinctPct = nonNullCount > 0 ? ((distinctCount / nonNullCount) * 100).toFixed(1) : '0.0';

    const fmt = (v: any) => (v === null || v === undefined) ? '—' : String(v);
    const fmtNum = (v: any) => {
      const n = Number(v);
      return isNaN(n) ? '—' : n.toLocaleString();
    };
    const fmtFloat = (v: any, dec = 2) => {
      const n = Number(v);
      return isNaN(n) ? '—' : n.toFixed(dec);
    };

    // Top-10 frequency bars
    const maxFreq = topValues.length > 0 ? topValues[0].frequency : 1;
    const topValuesHtml = topValues.length === 0
      ? '<p class="empty-msg">No non-null values found.</p>'
      : topValues.map(tv => {
          const pct = ((tv.frequency / maxFreq) * 100).toFixed(1);
          const rowPct = totalRows > 0 ? ((tv.frequency / totalRows) * 100).toFixed(1) : '0.0';
          const safeVal = tv.value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          return `
          <div class="freq-row">
            <div class="freq-label" title="${safeVal}">${safeVal}</div>
            <div class="freq-bar-wrap">
              <div class="freq-bar" style="width:${pct}%"></div>
            </div>
            <div class="freq-count">${fmtNum(tv.frequency)} <span class="freq-pct">(${rowPct}%)</span></div>
          </div>`;
        }).join('\n');

    // Histogram
    const maxHistCount = histogramBuckets.length > 0
      ? Math.max(...histogramBuckets.map(b => b.count))
      : 1;
    const histHtml = histogramBuckets.length === 0
      ? ''
      : `
      <section class="section">
        <h2 class="section-title">Histogram (10 buckets)</h2>
        <div class="histogram">
          ${histogramBuckets.map(b => {
            const heightPct = maxHistCount > 0 ? ((b.count / maxHistCount) * 100).toFixed(1) : '0';
            const label = `${parseFloat(b.lo).toFixed(2)} – ${parseFloat(b.hi).toFixed(2)}`;
            return `
            <div class="hist-col">
              <div class="hist-bar-wrap">
                <div class="hist-bar" style="height:${heightPct}%" title="${label}: ${fmtNum(b.count)} rows"></div>
              </div>
              <div class="hist-count">${fmtNum(b.count)}</div>
              <div class="hist-label" title="${label}">${parseFloat(b.lo).toFixed(1)}</div>
            </div>`;
          }).join('\n')}
        </div>
      </section>`;

    // Numeric section
    const numericHtml = isNumericOrDate ? `
      <section class="section">
        <h2 class="section-title">Numeric / Date Statistics</h2>
        <table class="stats-table">
          <tr><td class="label">Minimum</td><td class="value">${fmt(numericStats.min_val)}</td></tr>
          <tr><td class="label">Maximum</td><td class="value">${fmt(numericStats.max_val)}</td></tr>
          <tr><td class="label">Average</td><td class="value">${fmtFloat(numericStats.avg_val, 4)}</td></tr>
        </table>
      </section>` : '';

    // String length section
    const strHtml = isText ? `
      <section class="section">
        <h2 class="section-title">String Length Statistics</h2>
        <table class="stats-table">
          <tr><td class="label">Average Length</td><td class="value">${fmtFloat(strStats.avg_length, 1)} chars</td></tr>
          <tr><td class="label">Max Length</td><td class="value">${fmtNum(strStats.max_length)} chars</td></tr>
        </table>
      </section>` : '';

    const sampleBanner = useSample
      ? `<div class="sample-banner">
           Sampled from ~${fmtNum(estRows)} estimated rows using TABLESAMPLE BERNOULLI(10).
           Counts are extrapolated; use for indicative analysis only.
         </div>`
      : '';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Column Profile: ${column}</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-widget-border, #444);
    --accent: var(--vscode-focusBorder, #0078d4);
    --header-bg: var(--vscode-sideBarSectionHeader-background, #252526);
    --row-alt: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    --bar-color: var(--vscode-progressBar-background, #0078d4);
    --badge-bg: var(--vscode-badge-background, #4d4d4d);
    --badge-fg: var(--vscode-badge-foreground, #ffffff);
    --font: var(--vscode-font-family, system-ui, sans-serif);
    --mono: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-font-size, 13px);
  }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font);
    line-height: 1.5;
  }

  .header {
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--header-bg);
  }

  .header h1 {
    margin: 0 0 4px;
    font-size: 1.2em;
    font-weight: 600;
  }

  .header .meta {
    opacity: 0.7;
    font-size: 0.88em;
    font-family: var(--mono);
  }

  .sample-banner {
    margin: 12px 20px 0;
    padding: 8px 12px;
    background: var(--vscode-inputValidation-warningBackground, #6c4a00);
    border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    border-radius: 4px;
    font-size: 0.85em;
  }

  .content {
    padding: 16px 20px;
    max-width: 960px;
  }

  .section {
    margin-bottom: 24px;
  }

  .section-title {
    margin: 0 0 10px;
    font-size: 1em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.75;
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
  }

  .stats-table {
    width: 100%;
    border-collapse: collapse;
  }

  .stats-table tr:nth-child(even) { background: var(--row-alt); }

  .stats-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }

  .stats-table td.label {
    width: 200px;
    opacity: 0.8;
    font-weight: 500;
  }

  .stats-table td.value {
    font-family: var(--mono);
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--badge-bg);
    color: var(--badge-fg);
    font-size: 0.82em;
    font-family: var(--mono);
    margin-left: 6px;
  }

  /* Top-10 frequency bars */
  .freq-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .freq-label {
    width: 200px;
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 0.85em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .freq-bar-wrap {
    flex: 1;
    background: var(--row-alt);
    border-radius: 3px;
    height: 14px;
    overflow: hidden;
  }

  .freq-bar {
    height: 100%;
    background: var(--bar-color);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .freq-count {
    width: 100px;
    flex-shrink: 0;
    text-align: right;
    font-family: var(--mono);
    font-size: 0.85em;
  }

  .freq-pct {
    opacity: 0.65;
  }

  /* Histogram */
  .histogram {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 160px;
    padding-bottom: 32px;
    position: relative;
    overflow-x: auto;
  }

  .hist-col {
    flex: 1;
    min-width: 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    position: relative;
  }

  .hist-bar-wrap {
    flex: 1;
    width: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }

  .hist-bar {
    width: 100%;
    background: var(--bar-color);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
  }

  .hist-count {
    font-size: 0.7em;
    font-family: var(--mono);
    margin-top: 2px;
    white-space: nowrap;
  }

  .hist-label {
    position: absolute;
    bottom: -28px;
    font-size: 0.65em;
    font-family: var(--mono);
    white-space: nowrap;
    transform: rotate(-35deg);
    transform-origin: top left;
    opacity: 0.7;
  }

  .empty-msg {
    opacity: 0.6;
    font-style: italic;
  }
</style>
</head>
<body>

<div class="header">
  <h1>Column Profile: <code>${column}</code></h1>
  <div class="meta">${schema}.${table} &nbsp;·&nbsp; ${columnType}</div>
</div>

${sampleBanner}

<div class="content">

  <!-- Basic Statistics -->
  <section class="section">
    <h2 class="section-title">Basic Statistics</h2>
    <table class="stats-table">
      <tr>
        <td class="label">Total Rows</td>
        <td class="value">${fmtNum(totalRows)}</td>
      </tr>
      <tr>
        <td class="label">Non-null Count</td>
        <td class="value">${fmtNum(nonNullCount)}</td>
      </tr>
      <tr>
        <td class="label">Null Count</td>
        <td class="value">${fmtNum(nullCount)} <span class="badge">${nullPct}%</span></td>
      </tr>
      <tr>
        <td class="label">Distinct Count</td>
        <td class="value">${fmtNum(distinctCount)} <span class="badge">${distinctPct}% of non-null</span></td>
      </tr>
      ${isText ? `<tr>
        <td class="label">Blank (empty string)</td>
        <td class="value">${fmtNum(blankCount)}</td>
      </tr>` : ''}
    </table>
  </section>

  ${numericHtml}
  ${strHtml}

  <!-- Top-10 Most Frequent Values -->
  <section class="section">
    <h2 class="section-title">Top 10 Most Frequent Values</h2>
    ${topValuesHtml}
  </section>

  ${histHtml}

</div>
</body>
</html>`;
  }
}
