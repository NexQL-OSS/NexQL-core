import * as vscode from 'vscode';
import { MODERN_WEBVIEW_BASE_CSS } from '../common/htmlStyles';
import { WebviewPool } from '../utils/WebviewPool';

interface ExplainNode {
  name: string;
  cost?: string;
  actual?: string;
  rows?: number;
  loops?: number;
  extra?: Record<string, any>;
  children?: ExplainNode[];
}

export class ExplainProvider {
  private static panel: vscode.WebviewPanel | undefined;

  public static show(extensionUri: vscode.Uri, planJson: any, query?: string): void {
    const { panel, commit } = WebviewPool.getInstance().getOrCreate(
      'postgres-explain-plan',
      'explainPlan',
      'EXPLAIN ANALYZE Plan',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
      {
        onDispose: () => {
          if (ExplainProvider.panel === panel) {
            ExplainProvider.panel = undefined;
          }
        },
        onRecycle: (recycled) => {
          if (ExplainProvider.panel === recycled.panel) {
            ExplainProvider.panel = undefined;
          }
        },
      },
    );
    ExplainProvider.panel = panel;
    commit?.();

    try {
      const plan = ExplainProvider.parsePlan(planJson);
      panel.webview.html = ExplainProvider.renderHtml(plan, query);
    } catch (err: any) {
      panel.webview.html = ExplainProvider.renderHtml(
        null,
        query,
        `Could not render explain plan: ${err?.message || String(err)}`,
      );
    }
    panel.reveal(vscode.ViewColumn.Beside);
  }

  private static parsePlan(planJson: any): ExplainNode | null {
    let root = planJson;
    if (Array.isArray(planJson)) {
      root = planJson[0];
    }
    if (root && root.Plan) {
      root = root.Plan;
    }

    if (!root || typeof root !== 'object') {
      return null;
    }

    return ExplainProvider.toNode(root);
  }

  private static toNode(plan: any): ExplainNode {
    const node: ExplainNode = {
      name: plan?.['Node Type'] || 'Plan',
      cost: ExplainProvider.formatCost(plan),
      actual: ExplainProvider.formatActual(plan),
      rows: plan?.['Actual Rows'] ?? plan?.['Plan Rows'],
      loops: plan?.['Actual Loops'],
      extra: ExplainProvider.extractExtras(plan),
      children: []
    };

    const children = plan?.Plans || [];
    for (const child of children) {
      node.children?.push(ExplainProvider.toNode(child));
    }
    return node;
  }

  private static formatCost(plan: any): string | undefined {
    if (plan?.['Startup Cost'] !== undefined && plan?.['Total Cost'] !== undefined) {
      return `${plan['Startup Cost']} → ${plan['Total Cost']}`;
    }
    return undefined;
  }

  private static formatActual(plan: any): string | undefined {
    if (plan?.['Actual Startup Time'] !== undefined && plan?.['Actual Total Time'] !== undefined) {
      return `${plan['Actual Startup Time']}ms → ${plan['Actual Total Time']}ms`;
    }
    return undefined;
  }

  private static extractExtras(plan: any): Record<string, any> {
    const extras: Record<string, any> = {};
    const keys = ['Relation Name', 'Schema', 'Index Name', 'Filter', 'Join Filter', 'Hash Cond', 'Merge Cond', 'Rows Removed by Filter'];
    for (const key of keys) {
      if (plan?.[key] !== undefined) {
        extras[key] = plan[key];
      }
    }
    return extras;
  }

  private static renderHtml(root: ExplainNode | null, query?: string, errorMessage?: string): string {
    const escapeHtml = (value: any): string => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const renderNode = (node: ExplainNode): string => {
      const extras = node.extra && Object.keys(node.extra).length > 0
        ? `<div class="extras">${Object.entries(node.extra).map(([k, v]) => `<div><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</div>`).join('')}</div>`
        : '';

      const meta = [
        node.cost ? `<span class="meta">Cost: ${node.cost}</span>` : '',
        node.actual ? `<span class="meta">Actual: ${node.actual}</span>` : '',
        node.rows !== undefined ? `<span class="meta">Rows: ${node.rows}</span>` : '',
        node.loops !== undefined ? `<span class="meta">Loops: ${node.loops}</span>` : ''
      ].filter(Boolean).join('');

      const children = node.children?.length
        ? `<ul>${node.children.map(renderNode).join('')}</ul>`
        : '';

      return `
        <li>
          <div class="node">
            <div class="title">${escapeHtml(node.name)}</div>
            <div class="meta-row">${meta}</div>
            ${extras}
          </div>
          ${children}
        </li>
      `;
    };

    const emptyState = !root
      ? `<div class="empty">
           <strong>${escapeHtml(errorMessage || 'No visual EXPLAIN plan data available.')}</strong>
           <div class="hint">Run <code>EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)</code> to view the graphical plan.</div>
         </div>`
      : '';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>EXPLAIN ANALYZE</title>
        <style>
          ${MODERN_WEBVIEW_BASE_CSS}
          .query { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); padding: 8px; margin-bottom: 16px; white-space: pre-wrap; border-radius: 4px; font-size: 12px; }
          ul { list-style: none; padding-left: 20px; }
          .node { padding: 8px 12px; border: 1px solid var(--vscode-widget-border); margin-bottom: 8px; border-radius: 4px; background: var(--vscode-editor-background); }
          .title { font-weight: 600; margin-bottom: 4px; }
          .meta-row { display: flex; gap: 12px; flex-wrap: wrap; color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 6px; }
          .extras { font-size: 12px; color: var(--vscode-descriptionForeground); }
          .meta { background: color-mix(in srgb, var(--vscode-widget-border) 45%, transparent); padding: 2px 6px; border-radius: 3px; }
          .empty { border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 12px; margin-top: 8px; background: var(--vscode-editor-background); }
          .hint { margin-top: 6px; color: var(--vscode-descriptionForeground); }
          code { font-family: var(--vscode-editor-font-family); }
        </style>
      </head>
      <body>
        <section class="pg-panel">
          <header class="pg-panel-header">
            <div>
              <h2 class="pg-panel-title">EXPLAIN ANALYZE</h2>
              <p class="pg-panel-subtitle">Execution plan tree with operator metadata and row timings.</p>
            </div>
          </header>
          <div class="pg-panel-body">
            ${query ? `<div class="query">${escapeHtml(query)}</div>` : ''}
            ${emptyState}
            ${root ? `<ul>${renderNode(root)}</ul>` : ''}
          </div>
        </section>
      </body>
      </html>
    `;
  }
}
