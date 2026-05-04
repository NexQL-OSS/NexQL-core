import { ChartControls } from '../../../renderer/components/chart/ChartControls';
import { ChartRenderer } from '../../../renderer/components/chart/ChartRenderer';

export interface MountChartTabOptions {
  columns: string[];
  rows: unknown[];
  /** Banner when sliding-window streaming applies */
  createStreamingWarning: () => HTMLElement | null;
}

export function mountChartTab(
  viewContainer: HTMLElement,
  opts: MountChartTabOptions,
): { chartRenderer: ChartRenderer; chartCanvas: HTMLCanvasElement } {
  const streamingHint = opts.createStreamingWarning();
  if (streamingHint) {
    viewContainer.appendChild(streamingHint);
  }

  const chartCanvas = document.createElement('canvas');
  const chartRenderer = new ChartRenderer(chartCanvas);

  const chartWrapper = document.createElement('div');
  chartWrapper.style.cssText =
    'flex: 1; display: flex; flex-direction: column; height: 100%; overflow: hidden;';

  const controlsContainer = document.createElement('div');
  controlsContainer.style.cssText =
    'width: 20%; min-width: 160px; max-width: 240px; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-widget-border);';

  const canvasContainer = document.createElement('div');
  canvasContainer.style.cssText = 'flex: 1; padding: 8px; position: relative; min-height: 0;';
  canvasContainer.appendChild(chartCanvas);

  const innerContainer = document.createElement('div');
  innerContainer.style.cssText = 'display: flex; flex: 1; overflow: hidden; height: 100%;';
  innerContainer.appendChild(controlsContainer);
  innerContainer.appendChild(canvasContainer);
  chartWrapper.appendChild(innerContainer);

  viewContainer.appendChild(chartWrapper);

  new ChartControls(controlsContainer, {
    columns: opts.columns,
    rows: opts.rows,
    onConfigChange: (config) => {
      chartRenderer.render(opts.rows as any[], config);
    },
  });

  return { chartRenderer, chartCanvas };
}
