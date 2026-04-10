
export interface ExplainNode {
  'Node Type': string;
  'Total Cost': number;
  'Startup Cost': number;
  'Plan Rows': number;
  'Plan Width': number;
  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: ExplainNode[];
  [key: string]: any;
}

export class ExplainVisualizer {
  private container: HTMLElement;
  private plan: ExplainNode;
  private maxCost: number = 0;

  constructor(container: HTMLElement, plan: any) {
    this.container = container;
    // Handle different plan formats (generic JSON w/ Plan key vs direct array)
    this.plan = (plan.Plan || (Array.isArray(plan) ? plan[0]?.Plan : plan)) as ExplainNode;
    this.calculateStats();
  }

  private calculateStats() {
    this.maxCost = this.findMaxCost(this.plan);
  }

  private findMaxCost(node: ExplainNode): number {
    let max = node['Total Cost'] || 0;
    if (node.Plans) {
      for (const child of node.Plans) {
        max = Math.max(max, this.findMaxCost(child));
      }
    }
    return max;
  }

  public getTimeBadgeColor(actualTotalTime: number): 'green' | 'amber' | 'red' {
    if (actualTotalTime < 10) return 'green';
    if (actualTotalTime <= 100) return 'amber';
    return 'red';
  }

  public findHottestNode(node: ExplainNode): ExplainNode {
    let hottest = node;
    let maxTime = node['Actual Total Time'] ?? -Infinity;

    const traverse = (n: ExplainNode) => {
      const t = n['Actual Total Time'];
      if (t !== undefined && t > maxTime) {
        maxTime = t;
        hottest = n;
      }
      if (n.Plans) {
        for (const child of n.Plans) {
          traverse(child);
        }
      }
    };

    traverse(node);

    // If no node had Actual Total Time defined, return root
    if (maxTime === -Infinity) {
      return node;
    }

    return hottest;
  }

  public render() {
    this.container.innerHTML = '';

    // Styles
    const style = document.createElement('style');
    style.textContent = `
      .explain-tree {
        font-family: var(--vscode-editor-font-family);
        font-size: 13px;
        padding: 20px;
        overflow: auto;
        height: 100%;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
      }
      .explain-node {
        border: 1px solid var(--vscode-widget-border);
        border-radius: 4px;
        margin: 8px 0;
        padding: 8px;
        background: var(--vscode-editor-background);
        position: relative;
        transition: all 0.2s;
      }
      .explain-node:hover {
        border-color: var(--vscode-focusBorder);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      }
      .explain-node-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 600;
        cursor: pointer;
      }
      .explain-node-type {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .explain-node-stats {
        display: flex;
        gap: 12px;
        font-size: 0.9em;
        opacity: 0.8;
      }
      .explain-children {
        margin-left: 24px;
        border-left: 1px dashed var(--vscode-widget-border);
        padding-left: 12px;
      }
      .explain-details {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px dashed var(--vscode-widget-border);
        font-size: 0.9em;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 8px;
      }
      .explain-detail-item {
        display: flex;
        flex-direction: column;
      }
      .explain-label {
        opacity: 0.6;
        font-size: 0.85em;
      }
      .cost-bar {
        height: 4px;
        background: var(--vscode-progressBar-background);
        margin-top: 4px;
        border-radius: 2px;
        opacity: 0.3;
      }
      .high-cost {
        border-left: 4px solid var(--vscode-errorForeground);
      }
      .medium-cost {
        border-left: 4px solid var(--vscode-charts-yellow);
      }
      .toggle-icon {
        width: 16px;
        text-align: center;
        transition: transform 0.2s;
      }
      .explain-node.collapsed .explain-children,
      .explain-node.collapsed .explain-details {
        display: none;
      }
      .explain-node.collapsed .toggle-icon {
        transform: rotate(-90deg);
      }
      .badge {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 0.85em;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .time-badge {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 0.85em;
        font-weight: 600;
      }
      .time-badge-green {
        background: rgba(0, 180, 0, 0.2);
        color: #4caf50;
      }
      .time-badge-amber {
        background: rgba(255, 165, 0, 0.2);
        color: #ff9800;
      }
      .time-badge-red {
        background: rgba(220, 0, 0, 0.2);
        color: #f44336;
      }
      .seq-scan-warning {
        display: inline-block;
        margin-left: 8px;
        font-size: 0.85em;
        font-weight: 600;
        color: #ff9800;
      }
      .explain-summary-card {
        margin: 12px 20px 20px;
        padding: 12px 16px;
        border: 1px solid var(--vscode-widget-border);
        border-radius: 4px;
        background: var(--vscode-editor-background);
        font-family: var(--vscode-editor-font-family);
        font-size: 13px;
      }
      .explain-summary-card h4 {
        margin: 0 0 8px;
        font-size: 0.9em;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        opacity: 0.6;
      }
      .explain-summary-bottleneck {
        margin-bottom: 8px;
      }
      .explain-summary-suggestion {
        margin-top: 8px;
        padding: 8px;
        background: rgba(255, 165, 0, 0.1);
        border-left: 3px solid #ff9800;
        border-radius: 2px;
      }
      .explain-summary-suggestion code {
        font-family: var(--vscode-editor-font-family);
        font-size: 0.9em;
        display: block;
        margin-top: 4px;
        opacity: 0.9;
      }
    `;
    this.container.appendChild(style);

    const treeContainer = document.createElement('div');
    treeContainer.className = 'explain-tree';

    if (this.plan) {
      const hottestNode = this.findHottestNode(this.plan);
      treeContainer.appendChild(this.createNodeElement(this.plan, hottestNode));

      // Append sequential scan warning to the hottest node element
      if (
        hottestNode['Node Type'] === 'Seq Scan' &&
        (hottestNode['Actual Rows'] ?? 0) > 1000
      ) {
        const hottestEl = treeContainer.querySelector('[data-hottest="true"]');
        if (hottestEl) {
          const header = hottestEl.querySelector('.explain-node-header');
          if (header) {
            const warning = document.createElement('span');
            warning.className = 'seq-scan-warning';
            warning.textContent = `⚠ missing index on ${hottestNode['Relation Name'] ?? 'unknown'}`;
            header.appendChild(warning);
          }
        }
      }
    } else {
      treeContainer.textContent = 'No plan data available';
    }

    this.container.appendChild(treeContainer);

    // Render summary card below the tree
    if (this.plan) {
      const hottestNodeForSummary = this.findHottestNode(this.plan);
      this.container.appendChild(this.renderSummaryCard(hottestNodeForSummary));
    }
  }

  public renderSummaryCard(hottestNode: ExplainNode): HTMLElement {
    const card = document.createElement('div');
    card.className = 'explain-summary-card';

    const title = document.createElement('h4');
    title.textContent = 'Performance Summary';
    card.appendChild(title);

    const bottleneck = document.createElement('div');
    bottleneck.className = 'explain-summary-bottleneck';
    const actualTime = hottestNode['Actual Total Time'];
    const timeStr = actualTime !== undefined ? ` (${actualTime.toFixed(2)} ms)` : '';
    bottleneck.textContent = `Primary bottleneck: ${hottestNode['Node Type']}${timeStr}`;
    card.appendChild(bottleneck);

    if (hottestNode['Node Type'] === 'Seq Scan') {
      const suggestion = document.createElement('div');
      suggestion.className = 'explain-summary-suggestion';

      const label = document.createElement('span');
      label.textContent = '💡 Consider adding an index to speed up this sequential scan:';
      suggestion.appendChild(label);

      const relationName = hottestNode['Relation Name'] ?? 'table_name';
      const code = document.createElement('code');
      code.textContent = `CREATE INDEX ON ${relationName} (...);`;
      suggestion.appendChild(code);

      card.appendChild(suggestion);
    }

    return card;
  }

  private createNodeElement(node: ExplainNode, hottestNode?: ExplainNode): HTMLElement {
    const el = document.createElement('div');
    el.className = 'explain-node';

    if (hottestNode && node === hottestNode) {
      el.dataset.hottest = 'true';
    }

    // Header
    const header = document.createElement('div');
    header.className = 'explain-node-header';

    const typeSection = document.createElement('div');
    typeSection.className = 'explain-node-type';

    // Toggle
    if (node.Plans && node.Plans.length > 0) {
      const toggle = document.createElement('span');
      toggle.className = 'toggle-icon';
      toggle.textContent = '▼';
      typeSection.appendChild(toggle);

      header.onclick = (e) => {
        // Don't toggle if clicking specific actions if we add them later
        el.classList.toggle('collapsed');
        e.stopPropagation();
      };
    } else {
      typeSection.style.marginLeft = '16px';
    }

    const typeName = document.createElement('span');
    typeName.textContent = node['Node Type'];
    typeSection.appendChild(typeName);

    // Add badges for specific things (e.g. Scan direction, Strategy)
    if (node['Scan Direction'] === 'Backward') {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'Backward';
      typeSection.appendChild(b);
    }

    header.appendChild(typeSection);

    // Stats Summary
    const stats = document.createElement('div');
    stats.className = 'explain-node-stats';

    const actualTime = node['Actual Total Time'];
    const totalCost = node['Total Cost'];

    if (actualTime !== undefined) {
      const color = this.getTimeBadgeColor(actualTime);
      stats.innerHTML = `<span class="time-badge time-badge-${color}">⏱ ${actualTime.toFixed(2)}ms</span>`;
    }
    stats.innerHTML += `<span>💰 ${totalCost.toFixed(2)}</span>`;

    // Rows mismatch warning
    const planRows = node['Plan Rows'];
    const actualRows = node['Actual Rows'];
    if (actualRows !== undefined && planRows !== undefined) {
      const misEst = Math.abs(actualRows - planRows) / (planRows || 1);
      if (misEst > 10 && actualRows > 0) { // Off by 10x
        stats.innerHTML += `<span style="color:var(--vscode-errorForeground)">⚠️ Bad Est.</span>`;
      }
    }

    header.appendChild(stats);
    el.appendChild(header);

    // Cost Bar
    const bar = document.createElement('div');
    bar.className = 'cost-bar';
    const costRatio = (node['Total Cost'] || 0) / (this.maxCost || 1);
    bar.style.width = `${Math.min(100, costRatio * 100)}%`;
    el.appendChild(bar);

    // Details Panel
    const details = document.createElement('div');
    details.className = 'explain-details';

    // Populate details
    const importantKeys = ['Relation Name', 'Alias', 'Index Name', 'Hash Cond', 'Filter', 'Join Filter', 'Output'];
    const ignoredKeys = ['Node Type', 'Plans', 'Total Cost', 'Startup Cost', 'Plan Rows', 'Plan Width', 'Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops'];

    // Add standard stats first
    const mkDetail = (label: string, val: any) => {
      const d = document.createElement('div');
      d.className = 'explain-detail-item';
      d.innerHTML = `<span class="explain-label">${label}</span><span>${val}</span>`;
      return d;
    };

    details.appendChild(mkDetail('Cost', `${node['Startup Cost']} .. ${node['Total Cost']}`));
    details.appendChild(mkDetail('Rows', `${node['Plan Rows']} (Plan) / ${node['Actual Rows'] ?? '?'} (Actual)`));
    if (node['Actual Loops']) details.appendChild(mkDetail('Loops', node['Actual Loops']));

    // Dynamic keys
    for (const [key, val] of Object.entries(node)) {
      if (ignoredKeys.includes(key)) continue;
      if (importantKeys.includes(key) || typeof val === 'string' || typeof val === 'number') {
        details.appendChild(mkDetail(key, val));
      }
    }
    el.appendChild(details);

    // Children
    if (node.Plans && node.Plans.length > 0) {
      const children = document.createElement('div');
      children.className = 'explain-children';
      node.Plans.forEach(child => {
        children.appendChild(this.createNodeElement(child, hottestNode));
      });
      el.appendChild(children);
    }

    return el;
  }
}
