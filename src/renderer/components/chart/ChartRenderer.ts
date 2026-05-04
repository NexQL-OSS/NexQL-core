import { Chart, ChartType, TooltipPositionerFunction } from 'chart.js';
import { ensureChartJsRegistered } from './chartJsRegister';
import { createGradient, darkenColor, formatDate, isDateColumn } from '../../utils/formatting';
import { ChartRenderOptions } from '../../../common/types';

// Default colors matching renderer_v2.ts
export const DEFAULT_COLORS = [
  'rgba(54, 162, 235, 0.6)', // Blue
  'rgba(255, 99, 132, 0.6)', // Red
  'rgba(75, 192, 192, 0.6)', // Teal
  'rgba(255, 206, 86, 0.6)', // Yellow
  'rgba(153, 102, 255, 0.6)', // Purple
  'rgba(255, 159, 64, 0.6)', // Orange
  'rgba(199, 199, 199, 0.6)', // Grey
  'rgba(231, 233, 237, 0.6)'  // Light Grey
];

export const BORDER_COLORS = [
  'rgba(54, 162, 235, 1)',
  'rgba(255, 99, 132, 1)',
  'rgba(75, 192, 192, 1)',
  'rgba(255, 206, 86, 1)',
  'rgba(153, 102, 255, 1)',
  'rgba(255, 159, 64, 1)',
  'rgba(199, 199, 199, 1)',
  'rgba(231, 233, 237, 1)'
];


export class ChartRenderer {
  private chartInstance: Chart | null = null;

  constructor(private canvas: HTMLCanvasElement) { }

  public render(rows: any[], options: ChartRenderOptions) {
    ensureChartJsRegistered();
    // Destroy existing chart
    this.destroy();

    if (!rows || rows.length === 0 || options.yAxisCols.length === 0) {
      return;
    }

    // 1. Prepare Data (Sort & Limit)
    let chartData = [...rows];
    this.sortData(chartData, options);

    if (options.limitRows && options.limitRows > 0 && chartData.length > options.limitRows) {
      chartData = chartData.slice(0, options.limitRows);
    }

    // 2. Prepare Labels
    const isXAxisDate = isDateColumn(options.xAxisCol);
    const labels = chartData.map(row => {
      const value = row[options.xAxisCol];
      if (isXAxisDate && value) {
        return formatDate(value, options.dateFormat || 'YYYY-MM-DD');
      }
      return String(value ?? '');
    });

    // 3. Prepare Configuration
    let chartType: ChartType = 'bar';
    let datasets: any[] = [];
    let chartOptions: any = this.getBaseChartOptions(options);

    // 4. Build Datasets based on Type
    if (options.type === 'bar' || options.type === 'stackedBar') {
      chartType = 'bar';
      this.buildBarDatasets(chartData, labels, datasets, options);
      if (options.type === 'stackedBar') {
        chartOptions.scales.x.stacked = true;
        chartOptions.scales.y.stacked = true;
      }
    } else if (options.type === 'line') {
      chartType = 'line';
      this.buildLineDatasets(chartData, labels, datasets, options);
    } else if (options.type === 'area') {
      chartType = 'line';
      this.buildAreaDatasets(chartData, labels, datasets, options);
    } else if (options.type === 'pie' || options.type === 'doughnut') {
      chartType = options.type as ChartType;
      this.buildPieDatasets(chartData, labels, datasets, options, chartOptions);
    }

    // 5. Add Custom Plugins
    const plugins = [
      this.createDataLabelsPlugin(options),
      this.createBlurPlugin(options)
    ];

    // 6. Create Chart
    this.chartInstance = new Chart(this.canvas, {
      type: chartType,
      data: { labels, datasets },
      options: chartOptions,
      plugins
    });
  }

  public exportImage(format: 'png' | 'jpeg' = 'png'): string {
    if (!this.chartInstance) return '';
    return this.chartInstance.toBase64Image(format);
  }

  public destroy() {
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
  }

  private sortData(data: any[], options: ChartRenderOptions) {
    if (options.sortBy === 'none') return;

    data.sort((a, b) => {
      const valA = a[options.xAxisCol];
      const valB = b[options.xAxisCol];
      const yA = parseFloat(a[options.yAxisCols[0]]) || 0;
      const yB = parseFloat(b[options.yAxisCols[0]]) || 0;

      if (options.sortBy === 'label-asc') return String(valA).localeCompare(String(valB));
      if (options.sortBy === 'label-desc') return String(valB).localeCompare(String(valA));
      if (options.sortBy === 'value-asc') return yA - yB;
      if (options.sortBy === 'value-desc') return yB - yA;
      return 0;
    });
  }

  private getBaseChartOptions(options: ChartRenderOptions): any {
    const isHorizontal = options.horizontalBars && (options.type === 'bar' || options.type === 'stackedBar');

    return {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: isHorizontal ? 'y' : 'x',
      animation: { duration: 750 },
      plugins: {
        title: {
          display: !!options.chartTitle,
          text: options.chartTitle,
          color: options.textColor,
          font: { size: 14, weight: 'bold' }
        },
        legend: {
          display: options.legendPosition !== 'hidden',
          position: options.legendPosition === 'hidden' ? 'top' : options.legendPosition,
          labels: {
            color: options.textColor,
            font: { size: 11 }
          }
        },
        datalabels: options.showDataLabels ? {
          color: options.textColor,
          font: { size: 10, weight: 'bold' },
          anchor: 'end',
          align: 'top',
          formatter: (value: number) => value.toLocaleString()
        } : false
      },
      scales: {
        x: {
          ticks: { color: options.textColor, font: { size: 10 } },
          grid: { display: options.showGridX, color: 'rgba(128, 128, 128, 0.2)' }
        },
        y: {
          type: options.useLogScale ? 'logarithmic' : 'linear',
          ticks: { color: options.textColor, font: { size: 10 } },
          grid: { display: options.showGridY, color: 'rgba(128, 128, 128, 0.2)' },
          grace: options.showDataLabels ? '10%' : '0%'
        }
      }
    };
  }

  private buildBarDatasets(data: any[], labels: string[], datasets: any[], options: ChartRenderOptions) {
    const ctx = this.canvas.getContext('2d');
    const isHorizontal = options.horizontalBars && (options.type === 'bar' || options.type === 'stackedBar');

    options.yAxisCols.forEach(col => {
      const colorIdx = options.numericCols.indexOf(col);
      const customColor = options.seriesColors?.get(col);
      const bgColor = customColor || DEFAULT_COLORS[colorIdx % DEFAULT_COLORS.length];
      const border = customColor ? darkenColor(customColor) : BORDER_COLORS[colorIdx % BORDER_COLORS.length];

      datasets.push({
        label: col,
        data: data.map(row => parseFloat(row[col]) || 0),
        backgroundColor: ctx ? createGradient(ctx, colorIdx, customColor, !isHorizontal) : bgColor,
        borderColor: border,
        borderWidth: 2,
        borderRadius: 6,
        borderSkipped: false,
      });
    });
  }

  private buildLineDatasets(data: any[], labels: string[], datasets: any[], options: ChartRenderOptions) {
    const lineDash = options.lineStyle === 'dashed' ? [8, 4] : options.lineStyle === 'dotted' ? [2, 2] : [];

    options.yAxisCols.forEach(col => {
      const colorIdx = options.numericCols.indexOf(col);
      const lineColor = options.seriesColors?.get(col) || BORDER_COLORS[colorIdx % BORDER_COLORS.length];

      datasets.push({
        label: col,
        data: data.map(row => parseFloat(row[col]) || 0),
        borderColor: lineColor,
        backgroundColor: 'transparent',
        borderWidth: 3,
        borderDash: lineDash,
        tension: options.curveTension,
        pointRadius: 4,
        pointHoverRadius: 7,
        pointStyle: options.pointStyle,
        pointBackgroundColor: lineColor,
        pointBorderColor: 'rgba(255, 255, 255, 0.9)',
        pointBorderWidth: 2,
      });
    });
  }

  private buildAreaDatasets(data: any[], labels: string[], datasets: any[], options: ChartRenderOptions) {
    const ctx = this.canvas.getContext('2d');

    options.yAxisCols.forEach(col => {
      const colorIdx = options.numericCols.indexOf(col);
      const customColor = options.seriesColors?.get(col);
      const lineColor = customColor ? darkenColor(customColor) : BORDER_COLORS[colorIdx % BORDER_COLORS.length];
      const fillColor = customColor || DEFAULT_COLORS[colorIdx % DEFAULT_COLORS.length];

      const bgGradient = ctx ? (() => {
        const grad = ctx.createLinearGradient(0, 0, 0, 400);
        grad.addColorStop(0, fillColor);
        grad.addColorStop(1, fillColor.replace(/0\.\d+\)$/, '0.05)'));
        return grad;
      })() : fillColor;

      datasets.push({
        label: col,
        data: data.map(row => parseFloat(row[col]) || 0),
        borderColor: lineColor,
        backgroundColor: bgGradient,
        fill: true,
        borderWidth: 3,
        tension: options.curveTension,
        pointRadius: 0,
        pointHoverRadius: 6,
      });
    });
  }

  private buildPieDatasets(data: any[], labels: string[], datasets: any[], options: ChartRenderOptions, chartOptions: any) {
    // Aggregate Data Logic
    const aggregatedData = new Map<string, { value: number; count: number }>();
    const isXAxisDate = isDateColumn(options.xAxisCol);

    data.forEach(row => {
      const rawValue = row[options.xAxisCol];
      const sliceLabel = isXAxisDate && rawValue
        ? formatDate(rawValue, options.dateFormat || 'YYYY-MM-DD')
        : String(rawValue ?? 'Unknown');

      const existing = aggregatedData.get(sliceLabel) || { value: 0, count: 0 };

      if (options.selectedPieValueCol) {
        existing.value += parseFloat(row[options.selectedPieValueCol]) || 0;
      }
      existing.count += 1;
      aggregatedData.set(sliceLabel, existing);
    });

    // Filter hidden slices and prepare dataset
    const visibleData: { label: string; value: number; color: string; border: string }[] = [];
    let colorIndex = 0;

    aggregatedData.forEach((val, label) => {
      if (options.hiddenSlices && options.hiddenSlices.has(label)) {
        colorIndex++;
        return;
      }

      const value = options.selectedPieValueCol ? val.value : val.count;
      const color = options.sliceColors?.get(label) || DEFAULT_COLORS[colorIndex % DEFAULT_COLORS.length];

      visibleData.push({
        label,
        value,
        color,
        border: darkenColor(color)
      });
      colorIndex++;
    });

    // Update labels array for Pie (since it aggregates)
    labels.length = 0;
    labels.push(...visibleData.map(d => d.label));

    const total = visibleData.reduce((acc, curr) => acc + curr.value, 0);

    datasets.push({
      data: visibleData.map(d => d.value),
      backgroundColor: visibleData.map(d => d.color),
      borderColor: visibleData.map(d => d.border),
      borderWidth: 2,
      hoverOffset: 8
    });

    // Modify Options for Pie
    delete chartOptions.scales; // Pies don't have axis scales

    if (options.type === 'doughnut') {
      chartOptions.cutout = '60%';
    }

    // Custom Legend for Pie
    if (options.showLabels) {
      chartOptions.plugins.legend.display = true;
      chartOptions.plugins.legend.position = 'right';
      chartOptions.plugins.legend.labels.generateLabels = (chart: any) => {
        const d = chart.data;
        if (d.labels.length && d.datasets.length) {
          return d.labels.map((label: string, i: number) => {
            const val = d.datasets[0].data[i] as number;
            const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0';
            return {
              text: `${label}: ${pct}%`,
              fillStyle: d.datasets[0].backgroundColor[i],
              strokeStyle: d.datasets[0].borderColor[i],
              hidden: false,
              index: i,
              fontColor: options.textColor
            };
          });
        }
        return [];
      };
    }

    // Tooltip Callback for percentage
    chartOptions.plugins.tooltip = {
      callbacks: {
        label: (context: any) => {
          const value = context.raw;
          const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
          return ` ${context.label}: ${value.toLocaleString()} (${percentage}%)`;
        }
      }
    };
  }

  private createDataLabelsPlugin(options: ChartRenderOptions): any {
    return {
      id: 'customDataLabels',
      afterDatasetsDraw: (chart: Chart) => {
        if (!options.showDataLabels) return;

        const ctx = chart.ctx;
        const totalPoints = chart.data.labels?.length || 0;
        if (totalPoints > 50) return; // Optimize

        const skipInterval = totalPoints > 30 ? 3 : totalPoints > 15 ? 2 : 1;

        chart.data.datasets.forEach((dataset, i) => {
          const meta = chart.getDatasetMeta(i);
          if (!meta.hidden) {
            meta.data.forEach((element: any, index) => {
              if (index % skipInterval !== 0) return;

              const value = dataset.data[index];
              if (value === null || value === undefined) return;

              const borderColor = Array.isArray(dataset.borderColor)
                ? dataset.borderColor[index]
                : dataset.borderColor || options.textColor;

              const position = element.tooltipPosition();
              const type = (chart.config as any).type;
              const yOffset = type === 'bar' ? -5 : -10;

              ctx.save();
              ctx.fillStyle = borderColor as string;
              ctx.font = 'bold 10px sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';

              ctx.fillText(
                typeof value === 'number' ? value.toLocaleString() : String(value),
                position.x,
                position.y + yOffset
              );
              ctx.restore();
            });
          }
        });
      }
    };
  }

  private createBlurPlugin(options: ChartRenderOptions): any {
    return {
      id: 'blurEffect',
      beforeDatasetsDraw: (chart: any) => {
        if (!options.blurEffect) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 5;
        ctx.shadowOffsetY = 5;
      },
      afterDatasetsDraw: (chart: any) => {
        if (!options.blurEffect) return;
        chart.ctx.restore();
      },
      beforeDatasetDraw: (chart: any, args: any) => {
        if (!options.blurEffect) return;
        const ctx = chart.ctx;
        const dataset = chart.data.datasets[args.index];
        if (dataset) {
          const color = dataset.borderColor || dataset.backgroundColor;
          ctx.shadowColor = Array.isArray(color) ? color[0] : (color as string);
        }
      }
    };
  }
}
