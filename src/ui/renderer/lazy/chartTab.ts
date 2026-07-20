export interface MountChartTabOptions {
  columns: string[];
  rows: unknown[];
}

// Free-build fallback. The Chart tab button is hidden in free builds
// (renderQueryResult gates on isProBuild), so this is unreachable from the
// UI; it exists only so the @nexql/pro-renderer alias always resolves.
export function mountChartTab(
  viewContainer: HTMLElement,
  _opts: MountChartTabOptions,
): { chartRenderer: any; chartCanvas: HTMLCanvasElement } {
  console.warn('[NexQL] Chart tab is not included in this build.');
  viewContainer.innerHTML = '';
  return { chartRenderer: null, chartCanvas: document.createElement('canvas') };
}
