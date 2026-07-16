export interface MountChartTabOptions {
  columns: string[];
  rows: unknown[];
}

export function mountChartTab(
  viewContainer: HTMLElement,
  opts: MountChartTabOptions,
): { chartRenderer: any; chartCanvas: HTMLCanvasElement } {
  viewContainer.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:24px; color:var(--vscode-descriptionForeground); font-family:var(--vscode-font-family);">
      <h3 style="margin-bottom:8px; color:var(--vscode-foreground);">Charts & Visualization</h3>
      <p style="text-align:center; max-width:400px; margin-bottom:16px;">
        Plotting and visualizing your query result set using graphs is a premium feature available in NexQL Pro.
      </p>
    </div>
  `;
  return { chartRenderer: null, chartCanvas: document.createElement('canvas') };
}
