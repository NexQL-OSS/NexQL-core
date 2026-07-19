import { ChartRenderOptions } from '../../../common/types';
import { getNumericColumns } from '../../utils/formatting';

export interface ChartControlsProps {
  columns: string[];
  columnTypes?: Record<string, string>;
  rows: any[];
  onConfigChange: (config: ChartRenderOptions) => void;
}

/**
 * Numeric PostgreSQL type names used for Y-axis auto-detection.
 */
const NUMERIC_PG_TYPES = new Set([
  'int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'decimal',
  'money', 'real', 'double precision', 'bigint', 'integer', 'smallint'
]);

/**
 * Detect numeric columns using PostgreSQL column type metadata when available,
 * falling back to value-based heuristics.
 */
export function detectNumericColumns(
  columns: string[],
  rows: any[],
  columnTypes?: Record<string, string>
): string[] {
  if (columnTypes && Object.keys(columnTypes).length > 0) {
    const byType = columns.filter(col => {
      const t = (columnTypes[col] || '').toLowerCase().trim();
      return NUMERIC_PG_TYPES.has(t) || t.startsWith('int') || t.startsWith('float') || t.startsWith('numeric');
    });
    if (byType.length > 0) return byType;
  }
  // Fallback: value-based detection
  return getNumericColumns(columns, rows);
}

/**
 * Auto-detect X and Y axis columns:
 *   - Y-axis: numeric columns
 *   - X-axis: first non-numeric column (or first column if all are numeric)
 */
export function autoDetectAxes(
  columns: string[],
  rows: any[],
  columnTypes?: Record<string, string>
): { xAxis: string; yAxes: string[] } {
  const numericCols = detectNumericColumns(columns, rows, columnTypes);
  const numericSet = new Set(numericCols);

  const firstNonNumeric = columns.find(col => !numericSet.has(col));
  const xAxis = firstNonNumeric ?? columns[0] ?? '';
  const yAxes = numericCols.length > 0 ? [numericCols[0]] : [];

  return { xAxis, yAxes };
}

export class ChartControls {
  private container: HTMLElement;
  private props: ChartControlsProps;

  // State — only the five required controls
  private selectedChartType: string = 'bar';
  private selectedXAxis: string = '';
  private selectedYAxis: string[] = [];
  private useLogScale: boolean = false;
  private showLegend: boolean = true;

  constructor(container: HTMLElement, props: ChartControlsProps) {
    this.container = container;
    this.props = props;

    // Auto-detect axes on first render (Requirement 7.3)
    const { xAxis, yAxes } = autoDetectAxes(props.columns, props.rows, props.columnTypes);
    this.selectedXAxis = xAxis;
    this.selectedYAxis = yAxes;

    this.createUI();
    this.emitConfig();
  }

  /** Call when data changes to re-validate selections. */
  public updateProps(newProps: Partial<ChartControlsProps>) {
    this.props = { ...this.props, ...newProps };
    if (!this.props.columns.includes(this.selectedXAxis)) {
      const { xAxis, yAxes } = autoDetectAxes(this.props.columns, this.props.rows, this.props.columnTypes);
      this.selectedXAxis = xAxis;
      this.selectedYAxis = yAxes;
    }
  }

  private createUI() {
    this.container.innerHTML = '';
    // Sidebar is exactly 140 px wide (Requirement 7.2)
    this.container.style.cssText = [
      'width: 140px',
      'min-width: 140px',
      'max-width: 140px',
      'display: flex',
      'flex-direction: column',
      'gap: 10px',
      'height: 100%',
      'overflow-y: auto',
      'padding: 8px',
      'box-sizing: border-box',
      'border-left: 1px solid var(--vscode-panel-border)',
      'background: var(--vscode-sideBar-background)',
    ].join('; ');

    const numericCols = detectNumericColumns(this.props.columns, this.props.rows, this.props.columnTypes);

    // ── 1. Chart Type ──────────────────────────────────────────────
    this.container.appendChild(this.makeLabel('Chart Type'));
    const typeSelect = this.makeSelect(
      [
        ['bar', 'Bar'],
        ['line', 'Line'],
        ['area', 'Area'],
        ['pie', 'Pie'],
        ['doughnut', 'Doughnut'],
        ['stackedBar', 'Stacked Bar'],
      ],
      this.selectedChartType
    );
    typeSelect.onchange = () => {
      this.selectedChartType = typeSelect.value;
      this.emitConfig(); // Requirement 7.4 — immediate re-render
    };
    this.container.appendChild(typeSelect);

    // ── 2. X-Axis ──────────────────────────────────────────────────
    this.container.appendChild(this.makeLabel('X-Axis'));
    const xSelect = this.makeSelect(
      this.props.columns.map(c => [c, c]),
      this.selectedXAxis
    );
    xSelect.onchange = () => {
      this.selectedXAxis = xSelect.value;
      this.emitConfig(); // Requirement 7.4
    };
    this.container.appendChild(xSelect);

    // ── 3. Y-Axis ──────────────────────────────────────────────────
    this.container.appendChild(this.makeLabel('Y-Axis'));
    const yOptions: [string, string][] = numericCols.length > 0
      ? numericCols.map(c => [c, c])
      : [];
    const ySelect = this.makeSelect(
      yOptions.length > 0 ? yOptions : [['', '(no numeric columns)']],
      this.selectedYAxis[0] ?? ''
    );
    if (yOptions.length === 0) {
      ySelect.disabled = true;
    }
    // A <select> with no matching selected option silently falls back to
    // showing its first entry — sync state to match so the emitted config
    // (and every subsequent render) reflects what the dropdown actually shows.
    this.selectedYAxis = ySelect.value ? [ySelect.value] : [];
    ySelect.onchange = () => {
      this.selectedYAxis = ySelect.value ? [ySelect.value] : [];
      this.emitConfig(); // Requirement 7.4
    };
    this.container.appendChild(ySelect);

    // ── 4. Log Scale toggle ────────────────────────────────────────
    const logRow = this.makeToggleRow('Log Scale', this.useLogScale, (checked) => {
      this.useLogScale = checked;
      this.emitConfig(); // Requirement 7.4 + 7.5
    });
    this.container.appendChild(logRow);

    // ── 5. Legend toggle ───────────────────────────────────────────
    const legendRow = this.makeToggleRow('Legend', this.showLegend, (checked) => {
      this.showLegend = checked;
      this.emitConfig(); // Requirement 7.4 + 7.6
    });
    this.container.appendChild(legendRow);
  }

  private makeLabel(text: string): HTMLElement {
    const label = document.createElement('div');
    label.textContent = text;
    label.style.cssText = 'font-size: 11px; font-weight: 600; opacity: 0.8; text-transform: uppercase; margin-top: 4px;';
    return label;
  }

  private makeSelect(options: [string, string][], selectedValue: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.style.cssText = [
      'width: 100%',
      'padding: 3px 4px',
      'border: 1px solid var(--vscode-input-border)',
      'background: var(--vscode-input-background)',
      'color: var(--vscode-input-foreground)',
      'border-radius: 3px',
      'font-size: 11px',
      'box-sizing: border-box',
    ].join('; ');
    options.forEach(([val, text]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if (val === selectedValue) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  private makeToggleRow(
    label: string,
    initialValue: boolean,
    onChange: (checked: boolean) => void
  ): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-top: 4px;';

    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'font-size: 11px; opacity: 0.8;';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = initialValue;
    cb.style.cssText = 'cursor: pointer;';
    cb.onchange = () => onChange(cb.checked);

    row.appendChild(lbl);
    row.appendChild(cb);
    return row;
  }

  private emitConfig() {
    const numericCols = detectNumericColumns(this.props.columns, this.props.rows, this.props.columnTypes);
    const config: ChartRenderOptions = {
      type: this.selectedChartType,
      xAxisCol: this.selectedXAxis,
      yAxisCols: this.selectedYAxis,
      numericCols,
      useLogScale: this.useLogScale,
      legendPosition: this.showLegend ? 'bottom' : 'hidden',
      showGridX: true,
      showGridY: true,
      showLabels: true,
      dateFormat: 'YYYY-MM-DD',
      textColor: '#ccc',
    };
    this.props.onConfigChange(config);
  }
}
