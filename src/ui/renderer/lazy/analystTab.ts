export interface MountAnalystTabOptions {
  columns: string[];
  rows: unknown[];
  columnTypes: Record<string, string> | undefined;
  isStreaming: boolean;
  buildPivotOptimizeUserMessage: (ctx: any, sql: string) => string;
  buildFullDatasetRerunQuery: () => string | undefined;
  exportQuery: string | undefined;
  query: string | undefined;
  postMessage: (msg: Record<string, unknown>) => void;
  sourceCellIndex: number;
}

// Free-build fallback. The Analyst tab button is hidden in free builds
// (renderQueryResult gates on isProBuild), so this is unreachable from the
// UI; it exists only so the @nexql/pro-renderer alias always resolves.
export async function mountAnalystTab(
  viewContainer: HTMLElement,
  _opts: MountAnalystTabOptions,
): Promise<void> {
  console.warn('[NexQL] Analyst tab is not included in this build.');
  viewContainer.innerHTML = '';
}
