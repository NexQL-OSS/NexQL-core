import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MODERN_WEBVIEW_BASE_CSS } from '../../common/htmlStyles';
import { normalizeExplainPlan, computePlanHotspots, PlanNodeSummary } from './planModel';
import { analyzeDeepPlan } from './deepPlanAnalysis';
import { PlanDiffEngine } from '../../services/PlanDiffEngine';
import { PlanStoreWorkspace, StoredPlan } from './PlanStoreWorkspace';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMs(n: number): string {
  if (n < 1) {
    return `${n.toFixed(2)}ms`;
  }
  if (n < 1000) {
    return `${n.toFixed(1)}ms`;
  }
  return `${(n / 1000).toFixed(2)}s`;
}

function fmtNum(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(n)}`;
}

function toDiffNode(node: PlanNodeSummary): any {
  return {
    'Node Type': node.nodeType,
    'Startup Cost': node.startupCost,
    'Total Cost': node.totalCost,
    'Plan Rows': node.planRows,
    'Actual Rows': node.actualRows,
    'Actual Total Time': node.actualTotalTime,
    'Actual Loops': node.actualLoops,
    Plans: node.children.map((child) => toDiffNode(child)),
  };
}

interface ParsedPlanPayload {
  root: any | null;
  planningTime: number | null;
  executionTime: number | null;
  nodeCount: number;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePlanPayload(payload: unknown): ParsedPlanPayload {
  const parsed = typeof payload === 'string'
    ? (() => {
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    })()
    : payload;

  let wrapper: any = null;
  let root: any = null;
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && typeof first === 'object' && first.Plan) {
      wrapper = first;
      root = first.Plan;
    } else if (first && typeof first === 'object') {
      root = first;
    }
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as any;
    if (obj.Plan) {
      wrapper = obj;
      root = obj.Plan;
    } else {
      root = obj;
    }
  }

  const countNodes = (node: any): number => {
    if (!node || typeof node !== 'object') {
      return 0;
    }
    const children = Array.isArray(node.Plans) ? node.Plans : [];
    return 1 + children.reduce((sum: number, child: any) => sum + countNodes(child), 0);
  };

  return {
    root: root && typeof root === 'object' ? root : null,
    planningTime: asFiniteNumber(wrapper?.['Planning Time']),
    executionTime: asFiniteNumber(wrapper?.['Execution Time']),
    nodeCount: countNodes(root),
  };
}

interface RenderPayload {
  plan: any;
  query?: string;
  connectionId?: string;
  databaseName?: string;
  source?: StoredPlan['source'];
  sourceCellIndex?: number;
  performanceAnalysis?: any;
  notebookUri?: string;
}

export class PlanStudioPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static currentPlanId: string | undefined;
  private static comparePlanId: string | undefined;
  private static pinnedIds = new Set<string>();
  private static activeTab: 'plan' | 'diff' | 'insights' | 'raw' = 'plan';
  private static isQueryExpanded = true;
  private static extensionUri: vscode.Uri | undefined;
  private static htmlTemplateCache: string | undefined;

  /** Ensure template edits are picked up without extension host restart. */
  private static invalidateTemplateCaches(): void {
    PlanStudioPanel.htmlTemplateCache = undefined;
  }

  private static getHtmlTemplate(): string {
    if (PlanStudioPanel.htmlTemplateCache) {
      return PlanStudioPanel.htmlTemplateCache;
    }
    const extUri = PlanStudioPanel.extensionUri;
    if (!extUri) {
      return '<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>{{INLINE_STYLES}}</style></head><body>{{BODY_CONTENT}}</body></html>';
    }
    try {
      const templatePath = path.join(extUri.fsPath, 'templates', 'plan-studio', 'index.html');
      PlanStudioPanel.htmlTemplateCache = fs.readFileSync(templatePath, 'utf8');
      return PlanStudioPanel.htmlTemplateCache;
    } catch {
      return '<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>{{INLINE_STYLES}}</style></head><body>{{BODY_CONTENT}}</body></html>';
    }
  }

  private static readTemplateAsset(filename: string): string {
    const extUri = PlanStudioPanel.extensionUri;
    if (!extUri) {
      return '';
    }
    try {
      const assetPath = path.join(extUri.fsPath, 'templates', 'plan-studio', filename);
      return fs.readFileSync(assetPath, 'utf8');
    } catch {
      return '';
    }
  }

  /** Shared template layer (`templates/shared/styles.css`). */
  private static readSharedCssTemplate(): string {
    const extUri = PlanStudioPanel.extensionUri;
    if (!extUri) {
      return '';
    }
    try {
      const assetPath = path.join(extUri.fsPath, 'templates', 'shared', 'styles.css');
      return fs.readFileSync(assetPath, 'utf8');
    } catch {
      return '';
    }
  }

  private static getCssTemplate(): string {
    return PlanStudioPanel.readTemplateAsset('styles.css');
  }

  private static getScriptTemplate(): string {
    return PlanStudioPanel.readTemplateAsset('scripts.js');
  }

  public static show(
    extensionUri: vscode.Uri,
    planStore: PlanStoreWorkspace,
    payload: RenderPayload
  ): StoredPlan | undefined {
    return PlanStudioPanel.render(extensionUri, planStore, payload, true);
  }

  public static syncIfOpen(
    extensionUri: vscode.Uri,
    planStore: PlanStoreWorkspace,
    payload: RenderPayload
  ): StoredPlan | undefined {
    if (!PlanStudioPanel.panel) {
      return undefined;
    }
    return PlanStudioPanel.render(extensionUri, planStore, payload, false);
  }

  private static render(
    extensionUri: vscode.Uri,
    planStore: PlanStoreWorkspace,
    payload: RenderPayload,
    revealPanel: boolean
  ): StoredPlan | undefined {
    PlanStudioPanel.extensionUri = extensionUri;
    const normalized = normalizeExplainPlan(payload.plan);
    if (!normalized) {
      vscode.window.showErrorMessage('Plan Studio requires JSON EXPLAIN plan payload.');
      return undefined;
    }
    const saved = planStore.savePlan({
      query: payload.query ?? '',
      connectionId: payload.connectionId,
      databaseName: payload.databaseName,
      plan: payload.plan,
      source: payload.source ?? 'manual',
      notebookUri: payload.notebookUri,
      sourceCellIndex: payload.sourceCellIndex,
      performanceAnalysis: payload.performanceAnalysis,
    });
    if (payload.notebookUri) {
      planStore.linkPlanToNotebook(payload.notebookUri, saved.id);
    }
    PlanStudioPanel.currentPlanId = saved.id;

    if (!PlanStudioPanel.panel) {
      PlanStudioPanel.panel = vscode.window.createWebviewPanel(
        'postgres-plan-studio',
        'Plan Studio',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      PlanStudioPanel.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.png');
      PlanStudioPanel.panel.onDidDispose(() => {
        PlanStudioPanel.panel = undefined;
        PlanStudioPanel.currentPlanId = undefined;
        PlanStudioPanel.comparePlanId = undefined;
        PlanStudioPanel.pinnedIds.clear();
        PlanStudioPanel.isQueryExpanded = true;
        PlanStudioPanel.invalidateTemplateCaches();
      });
      PlanStudioPanel.panel.webview.onDidReceiveMessage((msg) =>
        PlanStudioPanel.handleMessage(msg, planStore, payload.notebookUri)
      );
    }
    PlanStudioPanel.refresh(planStore, payload.notebookUri);
    if (revealPanel) {
      PlanStudioPanel.panel.reveal(vscode.ViewColumn.Beside);
    }
    return saved;
  }

  private static refresh(planStore: PlanStoreWorkspace, notebookUri?: string): void {
    if (!PlanStudioPanel.panel || !PlanStudioPanel.currentPlanId) {
      return;
    }
    const all = planStore.getPlans();
    const selected = all.find((p) => p.id === PlanStudioPanel.currentPlanId);
    if (!selected) {
      return;
    }
    PlanStudioPanel.panel.webview.html = PlanStudioPanel.renderHtml(planStore, selected, notebookUri);
  }

  private static async handleMessage(
    msg: any,
    planStore: PlanStoreWorkspace,
    notebookUri?: string
  ): Promise<void> {
    if (typeof msg?.queryExpanded === 'boolean') {
      PlanStudioPanel.isQueryExpanded = msg.queryExpanded;
    }
    switch (msg.type) {
      case 'selectPlan':
        PlanStudioPanel.currentPlanId = msg.id;
        PlanStudioPanel.refresh(planStore, notebookUri);
        break;
      case 'setCompare':
        PlanStudioPanel.comparePlanId = msg.id || undefined;
        PlanStudioPanel.activeTab = 'diff';
        PlanStudioPanel.refresh(planStore, notebookUri);
        break;
      case 'clearCompare':
        PlanStudioPanel.comparePlanId = undefined;
        PlanStudioPanel.refresh(planStore, notebookUri);
        break;
      case 'pin':
        PlanStudioPanel.pinnedIds.add(msg.id);
        PlanStudioPanel.refresh(planStore, notebookUri);
        break;
      case 'unpin':
        PlanStudioPanel.pinnedIds.delete(msg.id);
        PlanStudioPanel.refresh(planStore, notebookUri);
        break;
      case 'switchTab':
        PlanStudioPanel.activeTab = msg.tab;
        PlanStudioPanel.refresh(planStore, notebookUri);
        break;
      case 'rerun':
        await vscode.commands.executeCommand('postgres-explorer.rerunPlanQuery', {
          planId: PlanStudioPanel.currentPlanId,
          withAnalyze: msg.withAnalyze === true,
        });
        break;
      case 'openSourceCell':
        await vscode.commands.executeCommand('postgres-explorer.openPlanSourceCell', {
          planId: PlanStudioPanel.currentPlanId,
        });
        break;
      case 'exportJson': {
        const plan = planStore.getPlans().find((p) => p.id === PlanStudioPanel.currentPlanId);
        if (!plan) {
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`plan-${plan.id}.json`),
          filters: { JSON: ['json'] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(plan.plan, null, 2)));
          vscode.window.showInformationMessage('Plan exported.');
        }
        break;
      }
      case 'copyQuery': {
        const plan = planStore.getPlans().find((p) => p.id === PlanStudioPanel.currentPlanId);
        if (plan?.query) {
          await vscode.env.clipboard.writeText(plan.query);
          vscode.window.showInformationMessage('Query copied to clipboard.');
        }
        break;
      }
      case 'deletePlan':
        planStore.deletePlan(msg.id);
        if (PlanStudioPanel.currentPlanId === msg.id) {
          const remaining = planStore.getPlans();
          PlanStudioPanel.currentPlanId = remaining[0]?.id;
        }
        PlanStudioPanel.pinnedIds.delete(msg.id);
        if (PlanStudioPanel.comparePlanId === msg.id) {
          PlanStudioPanel.comparePlanId = undefined;
        }
        PlanStudioPanel.refresh(planStore, notebookUri);
        break;
      case 'setQueryExpanded':
        PlanStudioPanel.isQueryExpanded = msg.expanded === true;
        break;
      default:
        break;
    }
  }

  private static renderHtml(planStore: PlanStoreWorkspace, selected: StoredPlan, notebookUri?: string): string {
    const normalized = normalizeExplainPlan(selected.plan);
    if (!normalized) {
      return '<html><body>Invalid plan</body></html>';
    }

    const allPlans = planStore.getPlans();
    const compareTarget = PlanStudioPanel.comparePlanId
      ? allPlans.find((p) => p.id === PlanStudioPanel.comparePlanId)
      : undefined;
    const compareNormalized = compareTarget ? normalizeExplainPlan(compareTarget.plan) : null;
    const hotspots = computePlanHotspots(normalized, 5);
    const analyzerRecommendations = selected.performanceAnalysis?.metrics?.recommendations ?? [];
    const deepAnalysis = analyzeDeepPlan(selected.plan, selected.query || '');
    const recommendations = [
      ...analyzerRecommendations,
      ...(deepAnalysis?.recommendations ?? []),
    ];

    const worstNode = hotspots[0];
    const headerChips = `
      <div class="header-chip"><span class="chip-label">Total Cost</span><span class="chip-value">${esc(normalized.root.totalCost.toFixed(2))}</span></div>
      <div class="header-chip"><span class="chip-label">Exec Time</span><span class="chip-value">${esc(fmtMs(normalized.root.actualTotalTime))}</span></div>
      <div class="header-chip"><span class="chip-label">Rows Out</span><span class="chip-value">${esc(fmtNum(normalized.root.actualRows))}</span></div>
      <div class="header-chip ${worstNode && worstNode.costSharePercent > 50 ? 'chip-warn' : ''}">
        <span class="chip-label">Worst Node</span>
        <span class="chip-value">${worstNode ? esc(worstNode.nodeType) : '—'}</span>
      </div>
      <div class="header-chip">
        <span class="chip-label">Function Hotspot</span>
        <span class="chip-value">${deepAnalysis?.functions[0] ? esc(deepAnalysis.functions[0].functionName) : '—'}</span>
      </div>
      <div class="header-chip">
        <span class="chip-label">CTE Hotspot</span>
        <span class="chip-value">${deepAnalysis?.ctes[0] ? esc(deepAnalysis.ctes[0].cteName) : '—'}</span>
      </div>
    `;
    const parsedPlan = parsePlanPayload(selected.plan);
    const rawRoot = parsedPlan.root;
    const rawTotalExecution = parsedPlan.executionTime ?? 0;
    const rawFindMaxCost = (node: any): number => {
      const current = asFiniteNumber(node?.['Total Cost']) ?? 0;
      const children = Array.isArray(node?.Plans) ? node.Plans : [];
      if (children.length === 0) {
        return current;
      }
      return children.reduce((max: number, child: any) => Math.max(max, rawFindMaxCost(child)), current);
    };
    const rawGetNodeTime = (node: any): number => asFiniteNumber(node?.['Actual Total Time']) ?? -1;
    const rawFindHottestNode = (node: any): any => {
      let hottest = node;
      let hottestTime = rawGetNodeTime(node);
      const visit = (current: any) => {
        const currentTime = rawGetNodeTime(current);
        if (currentTime > hottestTime) {
          hottestTime = currentTime;
          hottest = current;
        }
        const children = Array.isArray(current?.Plans) ? current.Plans : [];
        children.forEach((child: any) => visit(child));
      };
      visit(node);
      if (hottestTime >= 0) {
        return hottest;
      }
      const findByCost = (current: any): any => {
        const children = Array.isArray(current?.Plans) ? current.Plans : [];
        let best = current;
        let bestCost = asFiniteNumber(current?.['Total Cost']) ?? -1;
        children.forEach((child: any) => {
          const childBest = findByCost(child);
          const childCost = asFiniteNumber(childBest?.['Total Cost']) ?? -1;
          if (childCost > bestCost) {
            best = childBest;
            bestCost = childCost;
          }
        });
        return best;
      };
      return findByCost(node);
    };
    const rawMaxCost = rawRoot ? rawFindMaxCost(rawRoot) : 0;
    const hottestNode = rawRoot ? rawFindHottestNode(rawRoot) : null;
    const shouldUseMonospace = (label: string): boolean => /cond|filter|output|key|name/i.test(label);
    const formatDetailValue = (value: unknown): string => {
      if (value === null || value === undefined) {
        return '?';
      }
      if (Array.isArray(value)) {
        return value.map((v) => formatDetailValue(v)).join(', ');
      }
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch {
          return '[object]';
        }
      }
      return String(value);
    };
    const getTimeBadgeClass = (ms: number | null): string => {
      if (ms === null || ms < 10) {
        return 'time-green';
      }
      if (ms <= 100) {
        return 'time-amber';
      }
      return 'time-red';
    };
    const getNodeSeverity = (node: any): { severity: 'critical' | 'high' | 'medium' | 'low'; reason: string; isHotspot: boolean } => {
      const cost = asFiniteNumber(node?.['Total Cost']) ?? 0;
      const time = asFiniteNumber(node?.['Actual Total Time']) ?? 0;
      const costPercent = rawMaxCost > 0 ? (cost / rawMaxCost) * 100 : 0;
      const timePercent = rawTotalExecution > 0 ? (time / rawTotalExecution) * 100 : 0;
      const isHighCost = costPercent >= 10;
      const isHighTime = timePercent >= 10;
      if (!isHighCost && !isHighTime) {
        return { severity: 'low', reason: '', isHotspot: false };
      }
      let severity: 'critical' | 'high' | 'medium' | 'low' = 'low';
      if (costPercent >= 40 || timePercent >= 40) {
        severity = 'critical';
      } else if (costPercent >= 25 || timePercent >= 25) {
        severity = 'high';
      } else if (costPercent >= 15 || timePercent >= 15) {
        severity = 'medium';
      }
      const reasonParts: string[] = [];
      if (isHighCost) {
        reasonParts.push(`${costPercent.toFixed(1)}% of plan cost`);
      }
      if (isHighTime) {
        reasonParts.push(`${timePercent.toFixed(1)}% of execution time`);
      }
      return { severity, reason: reasonParts.join('; '), isHotspot: true };
    };
    const renderOperatorCard = (node: any, depth: number): string => {
      const children = Array.isArray(node?.Plans) ? node.Plans : [];
      const hasChildren = children.length > 0;
      const nodeType = String(node?.['Node Type'] ?? 'Unknown Node');
      const time = asFiniteNumber(node?.['Actual Total Time']);
      const cost = asFiniteNumber(node?.['Total Cost']);
      const rows = asFiniteNumber(node?.['Actual Rows']) ?? asFiniteNumber(node?.['Plan Rows']);
      const planRows = asFiniteNumber(node?.['Plan Rows']);
      const actualRows = asFiniteNumber(node?.['Actual Rows']);
      const barRatio = rawMaxCost > 0 && cost !== null ? (cost / rawMaxCost) * 100 : 0;
      const severityInfo = getNodeSeverity(node);
      const rowRatioBadge = (() => {
        if (!planRows || !actualRows || planRows <= 0) {
          return '';
        }
        const ratio = actualRows / planRows;
        if (ratio > 10 || ratio < 0.1) {
          const magnitude = ratio >= 1 ? Math.round(ratio) : Math.round(1 / ratio);
          const direction = ratio >= 1 ? 'over' : 'under';
          return `<span class="pill">est ${magnitude}x ${direction}</span>`;
        }
        return '';
      })();
      const detailEntries: Array<{ label: string; value: unknown }> = [
        { label: 'Cost', value: `${(asFiniteNumber(node?.['Startup Cost']) ?? 0).toFixed(2)} .. ${(asFiniteNumber(node?.['Total Cost']) ?? 0).toFixed(2)}` },
        { label: 'Rows', value: `${Math.round(asFiniteNumber(node?.['Plan Rows']) ?? 0)} (plan) / ${Math.round(asFiniteNumber(node?.['Actual Rows']) ?? 0)} (actual)` },
        { label: 'Loops', value: asFiniteNumber(node?.['Actual Loops']) },
        { label: 'Relation', value: node?.['Relation Name'] },
        { label: 'Alias', value: node?.Alias },
        { label: 'Index Name', value: node?.['Index Name'] },
        { label: 'Join Type', value: node?.['Join Type'] },
        { label: 'Strategy', value: node?.Strategy },
        { label: 'Parallel Aware', value: node?.['Parallel Aware'] },
        { label: 'Index Cond', value: node?.['Index Cond'] },
        { label: 'Recheck Cond', value: node?.['Recheck Cond'] },
        { label: 'Hash Cond', value: node?.['Hash Cond'] },
        { label: 'Merge Cond', value: node?.['Merge Cond'] },
        { label: 'Join Filter', value: node?.['Join Filter'] },
        { label: 'Filter', value: node?.Filter },
        { label: 'Sort Key', value: node?.['Sort Key'] },
        { label: 'Group Key', value: node?.['Group Key'] },
        { label: 'Output', value: node?.Output },
        { label: 'Rows Removed by Filter', value: node?.['Rows Removed by Filter'] },
        { label: 'Rows Removed by Join Filter', value: node?.['Rows Removed by Join Filter'] },
      ];
      const detailEntriesHtml = detailEntries
        .filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== '')
        .map((entry) => `
          <div class="explain-detail-item">
            <span class="explain-label">${esc(entry.label)}</span>
            <span class="explain-value ${shouldUseMonospace(entry.label) ? 'mono' : ''}">${esc(formatDetailValue(entry.value))}</span>
          </div>
        `)
        .join('');

      const childHtml = hasChildren
        ? `<div class="explain-children">${children.map((child: any) => renderOperatorCard(child, depth + 1)).join('')}</div>`
        : '';

      return `
        <div class="explain-node ${node === hottestNode ? 'hottest' : ''} ${severityInfo.isHotspot ? `is-hotspot hotspot-${severityInfo.severity}` : ''} ${depth > 1 && hasChildren ? 'collapsed' : ''}">
          <div class="explain-node-header" ${hasChildren ? 'data-toggle-node="true"' : ''}>
            <div class="explain-node-left">
              <span class="toggle-icon">${hasChildren ? 'v' : ''}</span>
              <span class="explain-node-type">${esc(nodeType)}</span>
              ${severityInfo.isHotspot ? `<span class="hotspot-badge hotspot-${severityInfo.severity}" title="${esc(severityInfo.reason)}">🔴 ${esc(severityInfo.severity)}</span>` : ''}
            </div>
            <div class="explain-node-stats">
              <span class="pill ${getTimeBadgeClass(time)}">time ${time === null ? '?' : `${time.toFixed(2)}ms`}</span>
              <span class="pill">cost ${cost === null ? '?' : cost.toFixed(2)}</span>
              <span class="pill">rows ${rows === null ? '?' : Math.round(rows).toLocaleString()}</span>
              ${rowRatioBadge}
            </div>
          </div>
          <div class="cost-bar" style="width:${Math.max(2, Math.min(100, barRatio))}%"></div>
          <div class="explain-details">${detailEntriesHtml}</div>
          ${childHtml}
        </div>
      `;
    };
    const summaryCardHtml = rawRoot && hottestNode ? `
      <div class="explain-summary-card">
        <div class="explain-summary-title">Performance Summary</div>
        <div class="explain-summary-main">
          Primary bottleneck: ${esc(String(hottestNode?.['Node Type'] ?? 'Unknown'))}
          ${(asFiniteNumber(hottestNode?.['Actual Total Time']) ?? null) !== null ? ` (${(asFiniteNumber(hottestNode?.['Actual Total Time']) as number).toFixed(2)} ms)` : ''}
        </div>
        <div class="explain-metric-grid">
          <div class="explain-metric"><span class="explain-metric-label">Planning</span><span class="explain-metric-value">${parsedPlan.planningTime === null ? '?' : `${parsedPlan.planningTime.toFixed(2)} ms`}</span></div>
          <div class="explain-metric"><span class="explain-metric-label">Execution</span><span class="explain-metric-value">${parsedPlan.executionTime === null ? '?' : `${parsedPlan.executionTime.toFixed(2)} ms`}</span></div>
          <div class="explain-metric"><span class="explain-metric-label">Root Cost</span><span class="explain-metric-value">${(asFiniteNumber(rawRoot?.['Total Cost']) ?? 0).toFixed(2)}</span></div>
          <div class="explain-metric"><span class="explain-metric-label">Plan Nodes</span><span class="explain-metric-value">${parsedPlan.nodeCount}</span></div>
        </div>
      </div>
    ` : '';
    const planTreeHtml = rawRoot
      ? `
        ${summaryCardHtml}
        <div class="explain-toolbar">
          <button data-local-action="expandAllNodes">Expand All</button>
          <button data-local-action="collapseAllNodes">Collapse All</button>
        </div>
        <div class="explain-tree-root">${renderOperatorCard(rawRoot, 0)}</div>
      `
      : '<div class="empty-state">No explain plan data available.</div>';

    const notebookPlans = notebookUri ? planStore.getNotebookPlans(notebookUri) : [];
    const history = allPlans.slice(0, 30);

    let diffHtml = '';
    if (compareNormalized && compareTarget) {
      const diff = PlanDiffEngine.diffPlans(
        toDiffNode(normalized.root),
        toDiffNode(compareNormalized.root),
        'Current',
        'Comparison'
      );
      const costDelta = normalized.root.totalCost - compareNormalized.root.totalCost;
      const timeDelta = normalized.root.actualTotalTime - compareNormalized.root.actualTotalTime;
      const rowsDelta = normalized.root.actualRows - compareNormalized.root.actualRows;
      const deltaClass = (n: number) => (n > 0 ? 'delta-bad' : n < 0 ? 'delta-good' : 'delta-neutral');
      const sign = (n: number) => (n > 0 ? '+' : '');
      const structuralRows = diff.nodeDiffs
        .filter((item) => item.changeType !== 'unchanged')
        .map((item) => `
          <tr class="diff-${item.changeType}">
            <td><strong>${esc(item.nodeType)}</strong></td>
            <td><span class="badge badge-${item.changeType}">${esc(item.changeType)}</span></td>
            <td class="${deltaClass(item.costDelta ?? 0)}">${sign(item.costDelta ?? 0)}${esc((item.costDelta ?? 0).toFixed(2))}</td>
            <td class="${deltaClass(item.timeDelta ?? 0)}">${sign(item.timeDelta ?? 0)}${esc(fmtMs(item.timeDelta ?? 0))}</td>
            <td class="diff-reason">${esc(item.reason ?? '')}</td>
          </tr>
        `)
        .join('');
      diffHtml = `
        <div class="diff-summary">
          <div class="diff-summary-card ${deltaClass(costDelta)}">
            <div class="diff-summary-label">Cost Δ</div>
            <div class="diff-summary-value">${sign(costDelta)}${esc(costDelta.toFixed(2))}</div>
          </div>
          <div class="diff-summary-card ${deltaClass(timeDelta)}">
            <div class="diff-summary-label">Time Δ</div>
            <div class="diff-summary-value">${sign(timeDelta)}${esc(fmtMs(timeDelta))}</div>
          </div>
          <div class="diff-summary-card ${deltaClass(rowsDelta)}">
            <div class="diff-summary-label">Rows Δ</div>
            <div class="diff-summary-value">${sign(rowsDelta)}${esc(fmtNum(rowsDelta))}</div>
          </div>
          <div class="diff-summary-meta">
            <div>vs <strong>${esc(compareTarget.capturedAt)}</strong></div>
            <button class="btn-link" data-action="clearCompare">Clear comparison</button>
          </div>
        </div>
        ${structuralRows ? `
          <table class="diff-table">
            <thead><tr><th>Node</th><th>Change</th><th>Cost Δ</th><th>Time Δ</th><th>Reason</th></tr></thead>
            <tbody>${structuralRows}</tbody>
          </table>
        ` : '<div class="empty-state">No structural changes between these plans. Differences are runtime-only.</div>'}
      `;
    } else {
      diffHtml = `
        <div class="empty-state">
          <p>No comparison plan selected.</p>
          <p class="muted">Pick a plan from the right rail and click <strong>Compare</strong>, or pin plans you want to keep available.</p>
        </div>
      `;
    }

    const insightsHtml = `
      <div class="insights-section">
        <h3>Hot Path</h3>
        <p class="muted">Nodes ranked by cost share. Higher percentage means more of total query cost.</p>
        <div class="hotspot-bars">
          ${hotspots.map((h, i) => `
            <div class="hotspot-bar ${i === 0 ? 'hot' : i === 1 ? 'warm' : ''}">
              <div class="hotspot-bar-fill" style="width:${Math.max(4, h.costSharePercent).toFixed(1)}%"></div>
              <div class="hotspot-bar-label">
                <span class="hotspot-name">${esc(h.nodeType)}</span>
                <span class="hotspot-stats">${esc(h.costSharePercent.toFixed(1))}% cost · ${esc(fmtMs(h.actualTimeMs))}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="insights-section">
        <h3>Recommendations</h3>
        ${recommendations.length
          ? `<ul class="reco-list">${recommendations.map((r: string) => `<li>${esc(r)}</li>`).join('')}</ul>`
          : '<div class="empty-state">No analyzer recommendations. Run with <code>EXPLAIN (ANALYZE, BUFFERS)</code> for richer insight.</div>'}
      </div>
      <div class="insights-section">
        <h3>Functions</h3>
        ${deepAnalysis?.functions.length
          ? `<ul class="reco-list">${deepAnalysis.functions.slice(0, 5).map((f) => `<li><strong>${esc(f.functionName)}</strong> (${esc(f.severity)}): ${esc(f.reason)}</li>`).join('')}</ul>`
          : '<div class="empty-state">No function scan hotspots detected.</div>'}
      </div>
      <div class="insights-section">
        <h3>CTEs</h3>
        ${deepAnalysis?.ctes.length
          ? `<ul class="reco-list">${deepAnalysis.ctes.slice(0, 5).map((c) => `<li><strong>${esc(c.cteName)}</strong> (${esc(c.severity)}): scans ${esc(String(c.scans))}, ${esc(c.reason)}</li>`).join('')}</ul>`
          : '<div class="empty-state">No CTE scan hotspots detected.</div>'}
      </div>
      <div class="insights-section">
        <h3>Subplans</h3>
        ${deepAnalysis?.subqueries.length
          ? `<ul class="reco-list">${deepAnalysis.subqueries.slice(0, 5).map((s) => `<li><strong>${esc(s.nodeType)}</strong> (${esc(s.severity)}): ${esc(s.reason)}</li>`).join('')}</ul>`
          : '<div class="empty-state">No expensive subquery/subplan operators detected.</div>'}
      </div>
      <div class="insights-section">
        <h3>Estimate Skew</h3>
        ${deepAnalysis?.estimateSkew.length
          ? `<ul class="reco-list">${deepAnalysis.estimateSkew.slice(0, 5).map((s) => `<li><strong>${esc(s.nodeType)}</strong> (${esc(s.severity)}): ${esc(s.skewRatio.toFixed(1))}x skew (${esc(String(s.planRows))} est vs ${esc(String(s.actualRows))} actual)</li>`).join('')}</ul>`
          : '<div class="empty-state">No significant row-estimate skew detected.</div>'}
      </div>
    `;

    const rawJsonHtml = `<pre class="raw-json">${esc(JSON.stringify(selected.plan, null, 2))}</pre>`;

    const pinned = allPlans.filter((p) => PlanStudioPanel.pinnedIds.has(p.id));
    const railActionGroupStyle = [
      'display:flex',
      'gap:4px',
      'padding:2px',
      'border-radius:6px',
      'border:1px solid var(--vscode-widget-border,#3f3f46)',
      'background:var(--vscode-editor-background,#1f1f24)',
    ].join(';');
    const railActionButtonStyle = [
      'appearance:none',
      '-webkit-appearance:none',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'width:24px',
      'height:24px',
      'padding:0',
      'margin:0',
      'border-radius:4px',
      'line-height:1',
      'font:inherit',
      'color:var(--vscode-foreground,#d4d4d8)',
      'background:var(--vscode-editor-background,#1f1f24)',
      'border:1px solid var(--vscode-widget-border,#3f3f46)',
      'cursor:pointer',
      'vertical-align:middle',
      'box-sizing:border-box',
    ].join(';');
    const renderHistoryItem = (p: StoredPlan, opts: { showPin: boolean; showCompare: boolean }) => {
      const isCurrent = p.id === selected.id;
      const isCompare = p.id === PlanStudioPanel.comparePlanId;
      const isPinned = PlanStudioPanel.pinnedIds.has(p.id);
      const norm = normalizeExplainPlan(p.plan);
      const cost = norm ? norm.root.totalCost.toFixed(0) : '—';
      const time = norm ? fmtMs(norm.root.actualTotalTime) : '—';
      return `
        <div class="rail-item ${isCurrent ? 'current' : ''} ${isCompare ? 'compare' : ''}">
          <div class="rail-item-main" data-action="selectPlan" data-id="${esc(p.id)}">
            <div class="rail-item-time">${esc(p.capturedAt.replace('T', ' ').slice(0, 19))}</div>
            <div class="rail-item-meta">
              <span class="rail-cost">${esc(cost)}</span>
              <span class="rail-time">${esc(time)}</span>
              <span class="rail-source">${esc(p.source)}</span>
            </div>
          </div>
          <div class="rail-item-actions rail-action-group" style="${railActionGroupStyle}">
            ${opts.showCompare && !isCurrent ? `<button class="rail-btn rail-btn--compare" style="${railActionButtonStyle}" data-action="setCompare" data-id="${esc(p.id)}" title="Compare with current" type="button"><span class="rail-btn-icon">⇄</span></button>` : ''}
            ${opts.showPin ? `<button class="rail-btn rail-btn--pin ${isPinned ? 'active' : ''}" style="${railActionButtonStyle}" data-action="${isPinned ? 'unpin' : 'pin'}" data-id="${esc(p.id)}" title="${isPinned ? 'Unpin' : 'Pin'}" type="button"><span class="rail-btn-icon">${isPinned ? '★' : '☆'}</span></button>` : ''}
            <button class="rail-btn rail-btn--delete rail-btn-danger" style="${railActionButtonStyle}" data-action="deletePlan" data-id="${esc(p.id)}" title="Delete" type="button"><span class="rail-btn-icon">🗑</span></button>
          </div>
        </div>
      `;
    };

    const tab = PlanStudioPanel.activeTab;
    const tabContent =
      tab === 'plan' ? `<div class="explain-tree">${planTreeHtml}</div>` :
        tab === 'diff' ? diffHtml :
          tab === 'insights' ? insightsHtml :
            rawJsonHtml;

    const inlineStyles = `${MODERN_WEBVIEW_BASE_CSS}\n${PlanStudioPanel.readSharedCssTemplate()}\n${PlanStudioPanel.getCssTemplate()}`;
    const bodyContent = `
      <div class="toolbar">
        <button class="toolbar-btn primary" data-action="rerun" data-analyze="false" title="Re-run query and capture new plan">▶ Re-run</button>
        <button class="toolbar-btn" data-action="rerun" data-analyze="true" title="Re-run with EXPLAIN ANALYZE">⚡ Run ANALYZE</button>
        <div class="toolbar-divider"></div>
        <button class="toolbar-btn" data-action="openSourceCell" title="Jump to source notebook cell">↗ Open Source Cell</button>
        <div class="toolbar-spacer"></div>
        <button class="toolbar-btn" data-action="copyQuery" title="Copy query SQL">📋 Copy SQL</button>
        <button class="toolbar-btn" data-action="exportJson" title="Export plan as JSON">⬇ Export JSON</button>
      </div>
      <div class="header-strip">${headerChips}</div>
      <div class="tabs">
        <button class="tab ${tab === 'plan' ? 'active' : ''}" data-action="switchTab" data-tab="plan">Plan Tree</button>
        <button class="tab ${tab === 'diff' ? 'active' : ''}" data-action="switchTab" data-tab="diff">Diff${compareTarget ? ' •' : ''}</button>
        <button class="tab ${tab === 'insights' ? 'active' : ''}" data-action="switchTab" data-tab="insights">Insights</button>
        <button class="tab ${tab === 'raw' ? 'active' : ''}" data-action="switchTab" data-tab="raw">Raw JSON</button>
      </div>
      <div class="main-layout">
        <div class="main-content">${tabContent}</div>
        <aside class="right-rail">
          <div class="rail-section">
            <div class="rail-section-head"><span class="rail-section-title">Query</span></div>
            <details class="rail-query"${PlanStudioPanel.isQueryExpanded ? ' open' : ''}><summary>Show SQL</summary><pre>${esc(selected.query || '--')}</pre></details>
            <div class="muted" style="margin-top:6px">
              ${esc(selected.connectionId ?? 'no connection')} · ${esc(selected.databaseName ?? 'no db')}
            </div>
          </div>

          ${pinned.length > 0 ? `
            <div class="rail-section">
              <div class="rail-section-head">
                <span class="rail-section-title">★ Pinned</span>
                <span class="rail-section-count">${pinned.length}</span>
              </div>
              ${pinned.map((p) => renderHistoryItem(p, { showPin: true, showCompare: true })).join('')}
            </div>
          ` : ''}

          ${notebookPlans.length > 0 ? `
            <div class="rail-section">
              <div class="rail-section-head">
                <span class="rail-section-title">From this Notebook</span>
                <span class="rail-section-count">${notebookPlans.length}</span>
              </div>
              ${notebookPlans.slice(0, 10).map((p) => renderHistoryItem(p, { showPin: true, showCompare: true })).join('')}
            </div>
          ` : ''}

          <div class="rail-section">
            <div class="rail-section-head">
              <span class="rail-section-title">Recent History</span>
              <span class="rail-section-count">${history.length}</span>
            </div>
            ${history.map((p) => renderHistoryItem(p, { showPin: true, showCompare: true })).join('')}
          </div>
        </aside>
      </div>
    `;
    const htmlTemplate = PlanStudioPanel.getHtmlTemplate();
    const inlineScript = PlanStudioPanel.getScriptTemplate();
    return htmlTemplate
      .replace(/\{\{INLINE_STYLES\}\}/g, () => inlineStyles)
      .replace(/\{\{INLINE_SCRIPTS\}\}/g, () => inlineScript)
      .replace(/\{\{BODY_CONTENT\}\}/g, () => bodyContent);
  }
}
