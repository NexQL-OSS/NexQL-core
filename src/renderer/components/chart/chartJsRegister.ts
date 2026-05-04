import { Chart, registerables } from 'chart.js';

let registered = false;

/** Idempotent Chart.js registration — call before constructing Chart instances. */
export function ensureChartJsRegistered(): void {
  if (registered) {
    return;
  }
  Chart.register(...registerables);
  registered = true;
}
