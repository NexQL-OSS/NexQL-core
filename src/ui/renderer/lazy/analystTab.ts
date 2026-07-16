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

export async function mountAnalystTab(
  viewContainer: HTMLElement,
  opts: MountAnalystTabOptions,
): Promise<void> {
  viewContainer.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:24px; color:var(--vscode-descriptionForeground); font-family:var(--vscode-font-family);">
      <h3 style="margin-bottom:8px; color:var(--vscode-foreground);">Data Analyst Dashboard</h3>
      <p style="text-align:center; max-width:400px; margin-bottom:16px;">
        Interactive pivot tables, grouping, aggregation, and AI analyst guidance are premium features available in NexQL Pro.
      </p>
    </div>
  `;
}
