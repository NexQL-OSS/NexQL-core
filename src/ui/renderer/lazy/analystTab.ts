import type { PivotAiHelpContext } from '../../../renderer/components/analyst/AnalystPanel';

export interface MountAnalystTabOptions {
  columns: string[];
  rows: unknown[];
  columnTypes: Record<string, string> | undefined;
  isStreaming: boolean;
  buildPivotOptimizeUserMessage: (ctx: PivotAiHelpContext, sql: string) => string;
  buildFullDatasetRerunQuery: () => string | undefined;
  exportQuery: string | undefined;
  query: string | undefined;
  postMessage: (msg: Record<string, unknown>) => void;
}

export async function mountAnalystTab(
  viewContainer: HTMLElement,
  opts: MountAnalystTabOptions,
): Promise<void> {
  const { renderAnalystPanel } = await import('../../../renderer/components/analyst/AnalystPanel');

  viewContainer.appendChild(
    renderAnalystPanel({
      columns: opts.columns,
      rows: opts.rows as Record<string, unknown>[],
      columnTypes: opts.columnTypes,
      isStreaming: opts.isStreaming,
      onAskAiForPivotHelp: (pivotCtx) => {
        const sqlText = (opts.buildFullDatasetRerunQuery() || opts.exportQuery || opts.query || '').trim();
        opts.postMessage({
          type: 'sendToChat',
          data: {
            query: sqlText || opts.query || '',
            message: opts.buildPivotOptimizeUserMessage(pivotCtx, sqlText || opts.query || ''),
          },
        });
      },
      onRunFullDataset: () => {
        const rerunQuery = opts.buildFullDatasetRerunQuery();
        if (!rerunQuery) {
          opts.postMessage({
            type: 'showErrorMessage',
            message: 'No query available to rerun for full dataset.',
          });
          return;
        }
        opts.postMessage({
          type: 'runDerivedQuery',
          query: rerunQuery,
          source: 'streaming-analyst-pivot-full-dataset',
          fullDataset: true,
        });
      },
    }),
  );
}
