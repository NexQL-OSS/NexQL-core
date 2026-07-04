export async function mountExplainTab(
  explainWrapper: HTMLElement,
  explainPlan: unknown,
  queryText: string = '',
  contextData?: {
    sourceCellIndex?: number;
    performanceAnalysis?: any;
  },
  postMessage?: (msg: Record<string, unknown>) => void,
): Promise<void> {
  const { ExplainVisualizer } = await import('../../../renderer/components/ExplainVisualizer');
  const { FlameGraphRenderer } = await import('../../../renderer/components/chart/FlameGraphRenderer');
  const { PlanDiffEngine } = await import('../../../services/PlanDiffEngine');
  const { ExplainRecommendationsPanel } = await import('../../../renderer/components/ExplainRecommendationsPanel');
  const { analyzeDeepPlan } = await import('../../../features/planStudio/deepPlanAnalysis');
  const {
    fillToolbarButtonContent,
    applyResultViewTabStyle,
    attachResultViewTabHover,
  } = await import('../../../renderer/components/ResultToolbarUi');

  explainWrapper.innerHTML = '';
  explainWrapper.style.display = 'flex';
  explainWrapper.style.flexDirection = 'column';
  explainWrapper.style.height = '100%';
  explainWrapper.style.minHeight = '0';

  const root = document.createElement('section');
  root.className = 'pg-panel';
  root.style.cssText = 'display:flex; flex-direction:column; height:100%; min-height:0;';

  const header = document.createElement('header');
  header.className = 'pg-panel-header';
  header.style.cssText = 'align-items:flex-start;';

  const headerText = document.createElement('div');
  const title = document.createElement('h2');
  title.className = 'pg-panel-title';
  title.textContent = 'EXPLAIN ANALYZE';
  const subtitle = document.createElement('p');
  subtitle.className = 'pg-panel-subtitle';
  subtitle.textContent = 'Notebook-style output with tree, flame graph, plan diff, recommendations, and report export.';
  headerText.appendChild(title);
  headerText.appendChild(subtitle);

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; align-items:center; justify-content:flex-end;';

  const toolbarShell = document.createElement('div');
  toolbarShell.style.cssText = [
    'display:flex',
    'gap:6px',
    'padding:4px',
    'border-radius:10px',
    'border:1px solid color-mix(in srgb, var(--vscode-widget-border) 65%, transparent)',
    'background:color-mix(in srgb, var(--vscode-editor-background) 88%, transparent)',
  ].join(';');

  const content = document.createElement('div');
  content.className = 'pg-panel-body';
  content.style.cssText = 'flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:12px;';

  const makeButton = (label: string, glyph: Parameters<typeof fillToolbarButtonContent>[1], active = false): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    fillToolbarButtonContent(button, glyph, label);
    applyResultViewTabStyle(button, active);
    attachResultViewTabHover(button);
    return button;
  };
  const launchStudioBtn = makeButton('Open in Plan Studio', 'explain');
  launchStudioBtn.onclick = () => {
    if (!postMessage) {
      return;
    }
    postMessage({
      type: 'openPlanStudio',
      plan: explainPlan,
      query: queryText,
      sourceCellIndex: contextData?.sourceCellIndex,
      performanceAnalysis: contextData?.performanceAnalysis,
    });
  };

  const setActive = (buttons: HTMLButtonElement[], activeIndex: number): void => {
    buttons.forEach((button, index) => {
      applyResultViewTabStyle(button, index === activeIndex);
    });
  };

  const parsePlanNode = (payload: unknown): any => {
    const parsed = typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      return first?.Plan || first || null;
    }
    if (parsed && typeof parsed === 'object' && 'Plan' in (parsed as any)) {
      return (parsed as any).Plan;
    }
    return parsed || null;
  };

  const rootPlan = parsePlanNode(explainPlan);

  const buildAssistantResultsPayload = (
    recommendations: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low';
        category: 'scan' | 'cost' | 'function' | 'cte' | 'subquery' | 'estimate';
      title: string;
      description: string;
      suggestion: string;
      estimatedImprovement: string;
    }>,
  ): string => {
    const columns = ['section', 'metric', 'value'];
    const rows: Array<Record<string, string>> = [];

    if (rootPlan) {
      rows.push(
        { section: 'plan', metric: 'root_node', value: String(rootPlan['Node Type'] || 'unknown') },
        { section: 'plan', metric: 'total_cost', value: String(rootPlan['Total Cost'] ?? 'n/a') },
        { section: 'plan', metric: 'actual_total_time_ms', value: String(rootPlan['Actual Total Time'] ?? 'n/a') },
        { section: 'plan', metric: 'plan_rows', value: String(rootPlan['Plan Rows'] ?? 'n/a') },
      );
    }

    recommendations.forEach((rec, idx) => {
      rows.push(
        { section: `recommendation_${idx + 1}`, metric: 'severity', value: rec.severity },
        { section: `recommendation_${idx + 1}`, metric: 'category', value: rec.category },
        { section: `recommendation_${idx + 1}`, metric: 'title', value: rec.title },
        { section: `recommendation_${idx + 1}`, metric: 'description', value: rec.description },
        { section: `recommendation_${idx + 1}`, metric: 'suggestion', value: rec.suggestion },
      );
    });

    return JSON.stringify({ columns, rows });
  };

  const renderEmpty = (message: string): void => {
    content.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state-simple';
    empty.textContent = message;
    content.appendChild(empty);
    if (!explainPlan && /^\s*EXPLAIN\b/i.test(queryText || '')) {
      const hint = document.createElement('div');
      hint.className = 'pg-muted';
      hint.style.marginTop = '8px';
      hint.textContent = 'Converts this EXPLAIN output to JSON and renders it in this tab.';
      content.appendChild(hint);

      const convertButton = makeButton('Convert to JSON', 'explain', true);
      convertButton.style.marginTop = '10px';
      convertButton.onclick = () => {
        postMessage?.({
          type: 'convertExplainToJson',
          query: queryText,
          sourceCellIndex: contextData?.sourceCellIndex,
        });
      };
      content.appendChild(convertButton);
    }
  };

  const renderTree = (): void => {
    content.innerHTML = '';
    if (!explainPlan) {
      renderEmpty('No explain plan data available. Run EXPLAIN (ANALYZE, FORMAT JSON) to get a visual plan.');
      return;
    }
    try {
      const treePanel = document.createElement('section');
      treePanel.className = 'pg-panel';
      treePanel.style.cssText = 'display:flex; flex-direction:column; min-height:0;';

      const treeHeader = document.createElement('div');
      treeHeader.className = 'pg-panel-header';
      treeHeader.innerHTML = '<div><h3 class="pg-panel-title">Plan Tree</h3><p class="pg-panel-subtitle">Operator cards with hotspot badges and execution metadata.</p></div>';

      const treeBody = document.createElement('div');
      treeBody.className = 'pg-panel-body';
      treeBody.style.cssText = 'min-height:0; overflow:auto;';

      treePanel.appendChild(treeHeader);
      treePanel.appendChild(treeBody);
      content.appendChild(treePanel);
      new ExplainVisualizer(treeBody, explainPlan).render();
    } catch (e) {
      renderEmpty('Failed to render explain plan: ' + String(e));
    }
  };

  const renderFlameGraph = (): void => {
    content.innerHTML = '';
    if (!rootPlan) {
      renderEmpty('No plan data available for flame graph.');
      return;
    }
    const shell = document.createElement('section');
    shell.className = 'pg-panel';
    shell.style.cssText = 'display:flex; flex-direction:column; min-height:0;';
    const flameHeader = document.createElement('div');
    flameHeader.className = 'pg-panel-header';
    flameHeader.innerHTML = '<div><h3 class="pg-panel-title">Flame Graph</h3><p class="pg-panel-subtitle">Hottest execution path through the plan.</p></div>';
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'pg-panel-body';
    canvasWrap.style.cssText = 'min-height:260px;';
    const canvas = document.createElement('canvas');
    canvas.height = 240;
    canvasWrap.appendChild(canvas);
    shell.appendChild(flameHeader);
    shell.appendChild(canvasWrap);
    content.appendChild(shell);
    try {
      const renderer = new FlameGraphRenderer(
        canvas,
        rootPlan,
        new ExplainVisualizer(document.createElement('div'), explainPlan).getHotspots(),
        { useActualTime: true },
      );
      renderer.render();
    } catch (e) {
      renderEmpty('Failed to render flame graph: ' + String(e));
    }
  };

  const renderRecommendations = (): void => {
    content.innerHTML = '';
    if (!rootPlan) {
      renderEmpty('No plan data available for recommendations.');
      return;
    }
    try {
      const visualizer = new ExplainVisualizer(document.createElement('div'), explainPlan);
      const hotspots = visualizer.getHotspots();
      type ExplainRecommendation = {
        severity: 'critical' | 'high' | 'medium' | 'low';
        category: 'scan' | 'cost' | 'function' | 'cte' | 'subquery' | 'estimate';
        title: string;
        description: string;
        suggestion: string;
        estimatedImprovement: string;
      };
      const deepAnalysis = analyzeDeepPlan(explainPlan, queryText || '');
      const recommendations: ExplainRecommendation[] = hotspots.length
        ? hotspots.map((hotspot, index) => ({
            severity: hotspot.severity,
            category: 'scan',
            title: `Hotspot ${index + 1}: ${hotspot.node['Node Type']}`,
            description: hotspot.reason,
            suggestion: `Review ${hotspot.node['Node Type']} and consider indexing or predicate tuning.`,
            estimatedImprovement: `${Math.min(90, Math.round(hotspot.costPercent))}%`,
          }))
        : [{
            severity: 'low',
            category: 'cost',
            title: 'No obvious hotspots detected',
            description: 'The current plan does not show strong hotspots or severe bottlenecks.',
            suggestion: 'No changes recommended.',
            estimatedImprovement: '0%',
          }];
      if (deepAnalysis) {
        recommendations.push(
          ...deepAnalysis.functions.slice(0, 2).map((f, idx) => ({
            severity: f.severity,
            category: 'function' as const,
            title: `Function Finding ${idx + 1}: ${f.functionName}`,
            description: f.reason,
            suggestion: `Inspect ${f.functionName} implementation and pre-filter rows before function evaluation.`,
            estimatedImprovement: '10-40%',
          })),
          ...deepAnalysis.ctes.slice(0, 2).map((c, idx) => ({
            severity: c.severity,
            category: 'cte' as const,
            title: `CTE Finding ${idx + 1}: ${c.cteName}`,
            description: c.reason,
            suggestion: `Review CTE ${c.cteName} for materialization/reuse pressure and intermediate row reduction.`,
            estimatedImprovement: '5-30%',
          })),
          ...deepAnalysis.subqueries.slice(0, 1).map((s, idx) => ({
            severity: s.severity,
            category: 'subquery' as const,
            title: `Subplan Finding ${idx + 1}: ${s.nodeType}`,
            description: s.reason,
            suggestion: 'Flatten or rewrite nested subquery paths with high cardinality.',
            estimatedImprovement: '5-25%',
          })),
          ...deepAnalysis.estimateSkew.slice(0, 1).map((s, idx) => ({
            severity: s.severity,
            category: 'estimate' as const,
            title: `Estimate Skew ${idx + 1}: ${s.nodeType}`,
            description: s.reason,
            suggestion: 'Refresh statistics and validate predicate selectivity/index support.',
            estimatedImprovement: '5-35%',
          })),
        );
      }
      const analyzerRecommendations = contextData?.performanceAnalysis?.metrics?.recommendations;
      if (Array.isArray(analyzerRecommendations) && analyzerRecommendations.length > 0) {
        recommendations.push(
          ...analyzerRecommendations.slice(0, 5).map((text: string, idx: number) => ({
            severity: 'medium' as const,
            category: 'cost' as const,
            title: `Analyzer Recommendation ${idx + 1}`,
            description: text,
            suggestion: text,
            estimatedImprovement: 'n/a',
          }))
        );
      }

      new ExplainRecommendationsPanel(content).render(recommendations, queryText, {
        onSendToAssistant: () => {
          if (!postMessage) {
            return;
          }
          postMessage({
            type: 'sendToChat',
            data: {
              query: queryText || '-- EXPLAIN query not available in this output',
              explainRecommendations: buildAssistantResultsPayload(recommendations),
              intent: 'optimizeQuery',
            },
          });
        },
      });
    } catch (e) {
      renderEmpty('Failed to generate recommendations: ' + String(e));
    }
  };

  const renderDiff = (): void => {
    content.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'pg-panel';
    wrapper.style.cssText = 'display:flex; flex-direction:column; gap:10px; height:100%; min-height:0;';

    const intro = document.createElement('div');
    intro.className = 'pg-panel-body pg-muted';
    intro.textContent = 'Paste a second EXPLAIN JSON plan below to compare it with the current one.';

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Paste second EXPLAIN JSON here';
    textarea.style.cssText = 'width:100%; min-height:140px; resize:vertical; font-family: var(--vscode-editor-font-family); padding:10px; border-radius:6px; border:1px solid var(--vscode-widget-border); background:var(--vscode-editor-background); color:var(--vscode-editor-foreground);';

    const compareButton = makeButton('Compare Plans', 'review', true);
    const result = document.createElement('div');
    result.style.cssText = 'flex:1; min-height:0; overflow:auto; border:1px solid var(--vscode-widget-border); border-radius:6px; background:var(--vscode-editor-background);';

    compareButton.onclick = () => {
      result.innerHTML = '';
      try {
        const other = parsePlanNode(textarea.value);
        if (!rootPlan || !other) {
          result.textContent = 'Both plans must contain valid JSON EXPLAIN plans.';
          return;
        }
        const diff = PlanDiffEngine.diffPlans(rootPlan, other);
        const summary = document.createElement('div');
        summary.style.cssText = 'padding:12px; border-bottom:1px solid var(--vscode-widget-border);';
        summary.textContent = `Cost Δ ${diff.summary.totalCostDelta.toFixed(2)} | Time Δ ${diff.summary.totalTimeDelta.toFixed(2)}ms | Added ${diff.summary.nodesAdded}, Removed ${diff.summary.nodesRemoved}, Modified ${diff.summary.nodesModified}`;
        result.appendChild(summary);
        const changed = diff.nodeDiffs.filter((item) => item.changeType !== 'unchanged').slice(0, 40);
        if (!changed.length) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:12px;';
          empty.textContent = 'No node-level differences found.';
          result.appendChild(empty);
          return;
        }
        const table = document.createElement('table');
        table.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
        table.innerHTML = '<thead><tr><th style="text-align:left;padding:6px;border:1px solid var(--vscode-widget-border);">Node</th><th style="text-align:left;padding:6px;border:1px solid var(--vscode-widget-border);">Change</th><th style="text-align:left;padding:6px;border:1px solid var(--vscode-widget-border);">Cost Δ</th><th style="text-align:left;padding:6px;border:1px solid var(--vscode-widget-border);">Time Δ</th><th style="text-align:left;padding:6px;border:1px solid var(--vscode-widget-border);">Reason</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const item of changed) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td style="padding:6px;border:1px solid var(--vscode-widget-border);">${item.nodeType}</td><td style="padding:6px;border:1px solid var(--vscode-widget-border);">${item.changeType}</td><td style="padding:6px;border:1px solid var(--vscode-widget-border);">${item.costDelta?.toFixed(2) ?? ''}</td><td style="padding:6px;border:1px solid var(--vscode-widget-border);">${item.timeDelta?.toFixed(2) ?? ''}</td><td style="padding:6px;border:1px solid var(--vscode-widget-border);">${item.reason ?? ''}</td>`;
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        result.appendChild(table);
      } catch (e) {
        result.textContent = 'Failed to compare plans: ' + String(e);
      }
    };

    wrapper.appendChild(intro);
    wrapper.appendChild(textarea);
    wrapper.appendChild(compareButton);
    wrapper.appendChild(result);
    content.appendChild(wrapper);
  };

  const renderReport = (): void => {
    content.innerHTML = '';
    const report = document.createElement('section');
    report.className = 'pg-panel';
    report.style.cssText = 'display:flex; flex-direction:column; min-height:0;';

    const reportHeader = document.createElement('div');
    reportHeader.className = 'pg-panel-header';
    reportHeader.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';

    const reportTitleWrap = document.createElement('div');
    reportTitleWrap.innerHTML = '<h3 class="pg-panel-title">Explain Report JSON</h3><p class="pg-panel-subtitle">Copy this snapshot for sharing or assistant review.</p>';

    const copyButton = makeButton('Copy Report JSON', 'save', false);
    copyButton.onclick = async () => {
      await navigator.clipboard.writeText(details.textContent || '');
      const icon = copyButton.querySelector('.pg-result-tb__tx');
      if (icon) {
        icon.textContent = 'Copied';
      }
      setTimeout(() => {
        const tx = copyButton.querySelector('.pg-result-tb__tx');
        if (tx) {
          tx.textContent = 'Copy Report JSON';
        }
      }, 1200);
    };

    reportHeader.appendChild(reportTitleWrap);
    reportHeader.appendChild(copyButton);

    const reportBody = document.createElement('div');
    reportBody.className = 'pg-panel-body';

    const details = document.createElement('pre');
    details.style.cssText = 'margin:0; padding:12px; border:1px solid var(--vscode-widget-border); border-radius:6px; white-space:pre-wrap; background:var(--vscode-editor-background);';
    details.textContent = JSON.stringify({
      query: queryText,
      explainPlan,
      generatedAt: new Date().toISOString(),
    }, null, 2);

    reportBody.appendChild(details);
    report.appendChild(reportHeader);
    report.appendChild(reportBody);
    content.appendChild(report);
  };

  const buttons = [
    makeButton('Tree', 'explain', true),
    makeButton('Flame Graph', 'chart'),
    makeButton('Recommendations', 'menuBolt'),
    makeButton('Compare Plans', 'review'),
    makeButton('Save Report', 'save'),
  ];

  const renderers = [renderTree, renderFlameGraph, renderRecommendations, renderDiff, renderReport];
  buttons.forEach((button, index) => {
    button.onclick = () => {
      setActive(buttons, index);
      renderers[index]();
    };
    toolbarShell.appendChild(button);
  });

  header.appendChild(headerText);
  toolbar.appendChild(launchStudioBtn);
  toolbar.appendChild(toolbarShell);
  header.appendChild(toolbar);
  root.appendChild(header);
  root.appendChild(content);
  explainWrapper.appendChild(root);
  renderTree();
}
