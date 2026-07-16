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
  explainWrapper.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:24px; color:var(--vscode-descriptionForeground); font-family:var(--vscode-font-family);">
      <h3 style="margin-bottom:8px; color:var(--vscode-foreground);">Explain Plan Visualizer</h3>
      <p style="text-align:center; max-width:400px; margin-bottom:16px;">
        Visual EXPLAIN tree, flame graphs, recommendations, and plan comparisons are premium features available in NexQL Pro.
      </p>
      <button style="padding:6px 12px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; cursor:pointer;" onclick="window.postMessage({type:'upgrade'})">Learn More</button>
    </div>
  `;
}
