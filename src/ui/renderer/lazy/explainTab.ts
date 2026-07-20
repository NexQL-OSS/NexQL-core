// Free-build fallback. The Explain Plan tab button is hidden in free builds
// (renderQueryResult gates on isProBuild), so this is unreachable from the
// UI; it exists only so the @nexql/pro-renderer alias always resolves.
export async function mountExplainTab(
  explainWrapper: HTMLElement,
  _explainPlan: unknown,
  _queryText: string = '',
  _contextData?: {
    sourceCellIndex?: number;
    performanceAnalysis?: any;
  },
  _postMessage?: (msg: Record<string, unknown>) => void,
): Promise<void> {
  console.warn('[NexQL] Explain plan visualizer is not included in this build.');
  explainWrapper.innerHTML = '';
}
