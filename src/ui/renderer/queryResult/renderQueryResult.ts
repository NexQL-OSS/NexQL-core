import type { ActivationFunction } from 'vscode-notebook-renderer';
import type { ChartRenderer } from '../../../renderer/components/chart/ChartRenderer';
import {
  createExportButton,
  positionExportDropdown,
  setExportToolbarButtonLabel,
  EXPORT_MENU_Z_INDEX,
} from '../../../renderer/features/export';
import { TableRenderer } from '../../../renderer/components/table/TableRenderer';
import { createErrorPanel } from '../../../renderer/components/ErrorPanel';
import {
  createAiMenuButton,
  createActionsMenuButton,
  type AiMenuOptions,
  type ActionsMenuOptions,
  type RowToolsOptions,
} from '../../../renderer/components/ActionBar';
import {
  applyResultRowToolStyle,
  applyResultViewTabStyle,
  attachResultRowToolInteractions,
  attachResultViewTabHover,
  fillToolbarButtonContent,
} from '../../../renderer/components/ResultToolbarUi';
import { createResultIdentityBar } from '../../../renderer/components/ResultIdentityBar';
import { createInlineBanner } from '../../../renderer/components/InlineBanner';
import {
  createResultFooter,
  formatResultExecutionStats,
} from '../../../renderer/components/ResultFooter';
import { createTransactionBanner } from '../../../renderer/components/TransactionBanner';
import { buildQueryPreview } from '../../../renderer/utils/queryPreview';
import {
  addResultToHistory,
  getResultHistory,
  renderTabStrip,
} from '../../../renderer/components/ResultTabStrip';
import { renderTransposeTable } from '../../../renderer/components/TransposeView';
import {
  BYTEA_DISPLAY_DEFAULT,
  type ByteaDisplayFormat,
  type NoticeLogEntry,
  type QueryResults,
  type FilterState,
  type SortState,
  type TableRenderOptions,
} from '../../../common/types';
import {
  normalizeNoticesPayload,
  renderNoticesPanel,
} from '../../../renderer/components/notices/NoticesPanel';
import { BRAND_ACCENT, RENDERER_ELEVATION_2, RENDERER_GLASS_BG, RENDERER_GLASS_BLUR } from '../rendererConstants';
import {
  buildChatResultsSampleJson,
  buildPivotOptimizeUserMessage,
  CHAT_SEND_SAMPLE_ROW_CAP,
  startButtonLoading,
  ensureAmberGutterStyle,
  clearTransactionUI,
} from './utils';
import { parseCellKey } from './editHelpers';
import { createRenderReviewChangesView, syncReviewTabButtonUi } from './reviewChanges';

type NotebookRendererContext = Parameters<ActivationFunction>[0];

/** Track ChartRenderer instances per output element (lazy-loaded with chart tab). */
const chartInstances = new WeakMap<HTMLElement, ChartRenderer>();
const tableInstances = new WeakMap<HTMLElement, TableRenderer>();

const LARGE_RESULTS_CACHE_MAX_ENTRIES = 8;
const LARGE_RESULT_TRANSFER_TIMEOUT_MS = 10_000;

const largeResultsCache = new Map<string, any[]>();
interface LargeResultPendingEntry {
  resolves: Array<(rows: any[]) => void>;
  rejects: Array<(error: Error) => void>;
  timeoutId: ReturnType<typeof setTimeout>;
}
const largeResultsPendingResolves = new Map<string, LargeResultPendingEntry>();
/** Tracks which resultId belongs to each output element so re-renders can evict stale SAB data. */
const largeResultIdByElement = new WeakMap<HTMLElement, string>();
let isGlobalMessageListenerRegistered = false;

function releaseLargeResult(resultId: string): void {
  largeResultsCache.delete(resultId);
  const pending = largeResultsPendingResolves.get(resultId);
  if (pending) {
    clearTimeout(pending.timeoutId);
    largeResultsPendingResolves.delete(resultId);
  }
}

function touchLargeResultCache(resultId: string, rows: any[]): void {
  if (largeResultsCache.has(resultId)) {
    largeResultsCache.delete(resultId);
  }
  largeResultsCache.set(resultId, rows);
  while (largeResultsCache.size > LARGE_RESULTS_CACHE_MAX_ENTRIES) {
    const oldest = largeResultsCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    releaseLargeResult(oldest);
  }
}

function bindLargeResultToElement(element: HTMLElement, resultId: string): void {
  const previousId = largeResultIdByElement.get(element);
  if (previousId && previousId !== resultId) {
    releaseLargeResult(previousId);
  }
  largeResultIdByElement.set(element, resultId);
}

function resolveLargeResultPending(resultId: string, rows: any[]): void {
  const pending = largeResultsPendingResolves.get(resultId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeoutId);
  for (const resolve of pending.resolves) {
    resolve(rows);
  }
  largeResultsPendingResolves.delete(resultId);
}

function rejectLargeResultPending(resultId: string, reason: Error): void {
  const pending = largeResultsPendingResolves.get(resultId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeoutId);
  for (const reject of pending.rejects) {
    reject(reason);
  }
  largeResultsPendingResolves.delete(resultId);
}

function registerLargeResultPending(
  resultId: string,
  onResolve: (rows: any[]) => void,
  onReject: (error: Error) => void,
): void {
  const existing = largeResultsPendingResolves.get(resultId);
  if (existing) {
    existing.resolves.push(onResolve);
    existing.rejects.push(onReject);
    return;
  }
  const timeoutId = setTimeout(() => {
    rejectLargeResultPending(
      resultId,
      new Error(`Timed out waiting for large result payload after ${LARGE_RESULT_TRANSFER_TIMEOUT_MS}ms`),
    );
  }, LARGE_RESULT_TRANSFER_TIMEOUT_MS);
  largeResultsPendingResolves.set(resultId, {
    resolves: [onResolve],
    rejects: [onReject],
    timeoutId,
  });
}

const LARGE_RESULT_ROW_COUNT_FALLBACK = '>50,000';

/** Safe row-count label for UI copy; avoids calling toLocaleString on nullish/non-numeric values. */
function formatRowCountForDisplay(
  rowCount: number | null | undefined,
  fallback: string,
): string {
  if (rowCount == null || typeof rowCount !== 'number' || !Number.isFinite(rowCount)) {
    return fallback;
  }
  return rowCount.toLocaleString();
}

export function renderPostgresNotebookResult(
  context: NotebookRendererContext,
  data: { mime: string; json: () => unknown },
  element: HTMLElement,
): void {
      if (!isGlobalMessageListenerRegistered) {
        isGlobalMessageListenerRegistered = true;
        context.onDidReceiveMessage?.((message: any) => {
          if (message.type === 'largeResultRows' && message.resultId && message.sharedBuffer) {
            const sab = message.sharedBuffer;
            const view = new Uint8Array(sab);
            const decoder = new TextDecoder();
            const jsonStr = decoder.decode(view);
            try {
              const parsedRows = JSON.parse(jsonStr);
              touchLargeResultCache(message.resultId, parsedRows);
              resolveLargeResultPending(message.resultId, parsedRows);
            } catch (e) {
              console.error('Failed to parse large result SharedArrayBuffer rows:', e);
              rejectLargeResultPending(
                message.resultId,
                new Error('Failed to decode large result payload from renderer message'),
              );
            }
          }
        });
      }

      const json = data.json() as Partial<QueryResults> & { error?: string } | null;

      if (!json) {
        element.innerText = 'No data';
        return;
      }

      const {
        columns = [],
        rows,
        rowCount,
        command,
        query,
        notices,
        executionTime,
        tableInfo,
        columnTypes,
        backendPid,
        breadcrumb,
        autoLimitApplied,
        autoLimitValue,
      } = json;
      const exportQuery: string | undefined =
        typeof json.exportQuery === 'string' && json.exportQuery.trim().length > 0
          ? json.exportQuery
          : query;

      let slideMeta: QueryResults['slidingWindow'] = json.slidingWindow;

      const byteaDisplayFormat: ByteaDisplayFormat =
        json.byteaDisplayFormat === 'postgresql' ||
        json.byteaDisplayFormat === 'json' ||
        json.byteaDisplayFormat === 'hex0x'
          ? json.byteaDisplayFormat
          : BYTEA_DISPLAY_DEFAULT;

      const noticeItems = normalizeNoticesPayload(notices);

      const sourceCellIndex =
        typeof json.sourceCellIndex === 'number' && json.sourceCellIndex >= 0
          ? json.sourceCellIndex
          : -1;

      // Transaction state from payload
      const transactionState: { isActive: boolean; statementCount: number } | undefined =
        json.transactionState;
      const pendingCommit: boolean = !!json.pendingCommit;

      // Data Management
      const renderMain = (resolvedRows: any[]) => {
        let originalRows: any[] = resolvedRows ? JSON.parse(JSON.stringify(resolvedRows)) : [];
        let currentRows: any[] = resolvedRows ? JSON.parse(JSON.stringify(resolvedRows)) : [];
        let slideBufferedStartRow = slideMeta?.windowStartRow ?? 1;
        let slideHasMoreBefore = slideMeta?.hasMoreBefore ?? false;
        let slideHasMoreAfter = slideMeta?.hasMoreAfter ?? false;
        let localFilterState: FilterState = { globalQuery: '', clauses: [] };
        let localSortState: SortState = { column: null, direction: 'none' };
        const selectedIndices = new Set<number>();
        const modifiedCells = new Map<string, { originalValue: any; newValue: any }>();
        const rowsMarkedForDeletion = new Set<number>();

      // FK lookup pending callbacks — keyed by requestId
      const fkCallbacks = new Map<string, (rows: any[], cols: string[]) => void>();

      const buildTableRenderOptions = (): TableRenderOptions => ({
        columns,
        rows: currentRows,
        originalRows,
        columnTypes,
        tableInfo,
        foreignKeys: tableInfo?.foreignKeys,
        initialSelectedIndices: selectedIndices,
        modifiedCells,
        rowsMarkedForDeletion,
        byteaDisplayFormat,
        ...(slideMeta?.sessionId ? { rowNumberBaseline: slideBufferedStartRow } : {}),
      });

      const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;
      const escapeSqlLiteral = (value: string): string => value.replace(/'/g, "''");
      const hasActiveLocalFilter = (): boolean =>
        localFilterState.globalQuery.trim().length > 0 || localFilterState.clauses.length > 0;
      const hasActiveLocalSort = (): boolean =>
        !!localSortState.column && localSortState.direction !== 'none';
      const buildDerivedQueryFromLocalScope = (): string | undefined => {
        const base = (exportQuery || query || '').trim();
        if (!base) return undefined;
        const baseNoSemicolon = base.replace(/;\s*$/, '');
        const alias = 'nexql_src';
        const globalParts: string[] = [];
        const whereParts: string[] = [];

        const appendLikeCondition = (column: string, mode: 'contains' | 'startsWith' | 'endsWith', raw: string) => {
          const v = escapeSqlLiteral(raw);
          const pattern = mode === 'contains' ? `%${v}%` : mode === 'startsWith' ? `${v}%` : `%${v}`;
          whereParts.push(`CAST(${alias}.${quoteIdentifier(column)} AS text) ILIKE '${pattern}'`);
        };

        const globalQuery = localFilterState.globalQuery.trim();
        if (globalQuery) {
          const pat = `%${escapeSqlLiteral(globalQuery)}%`;
          for (const c of columns) {
            globalParts.push(`CAST(${alias}.${quoteIdentifier(c)} AS text) ILIKE '${pat}'`);
          }
          if (globalParts.length > 0) {
            whereParts.push(`(${globalParts.join(' OR ')})`);
          }
        }

        for (const clause of localFilterState.clauses) {
          if (!columns.includes(clause.column)) continue;
          const value = clause.value ?? '';
          if (clause.operator === 'equals') {
            whereParts.push(
              `CAST(${alias}.${quoteIdentifier(clause.column)} AS text) = '${escapeSqlLiteral(value)}'`,
            );
          } else if (clause.operator === 'contains') {
            appendLikeCondition(clause.column, 'contains', value);
          } else if (clause.operator === 'startsWith') {
            appendLikeCondition(clause.column, 'startsWith', value);
          } else if (clause.operator === 'endsWith') {
            appendLikeCondition(clause.column, 'endsWith', value);
          }
        }

        const hasWhere = whereParts.length > 0;
        const sortColumn =
          localSortState.column && columns.includes(localSortState.column)
            ? localSortState.column
            : null;
        const hasSort = !!sortColumn && localSortState.direction !== 'none';

        if (!hasWhere && !hasSort) {
          return undefined;
        }

        const whereSql = hasWhere ? `\nWHERE ${whereParts.join('\n  AND ')}` : '';
        const orderSql = hasSort
          ? `\nORDER BY ${alias}.${quoteIdentifier(sortColumn!)} ${localSortState.direction.toUpperCase()}`
          : '';

        return `SELECT *\nFROM (\n${baseNoSemicolon}\n) AS ${alias}${whereSql}${orderSql};`;
      };

      const buildFullDatasetRerunQuery = (): string | undefined => {
        const scoped = buildDerivedQueryFromLocalScope();
        if (scoped) {
          return scoped;
        }
        const base = (exportQuery || query || '').trim();
        if (!base) {
          return undefined;
        }
        return base.endsWith(';') ? base : `${base};`;
      };

      const runFullDatasetRerun = (source: string): void => {
        const rerunQuery = buildFullDatasetRerunQuery();
        if (!rerunQuery) {
          context.postMessage?.({
            type: 'showErrorMessage',
            message: 'No query available to rerun for full dataset.',
          });
          return;
        }
        context.postMessage?.({
          type: 'runDerivedQuery',
          query: rerunQuery,
          source,
          fullDataset: true,
          sourceCellIndex,
        });
      };

      const refreshStreamingScopeNotice = (): void => {
        mainContainer.querySelector('[data-streaming-scope-hint="true"]')?.remove();
        if (!slideMeta?.sessionId) return;
        const activeFilter = hasActiveLocalFilter();
        const activeSort = hasActiveLocalSort();
        if (!activeFilter && !activeSort) return;

        const scopeBits: string[] = [];
        if (activeFilter) scopeBits.push('filter');
        if (activeSort) scopeBits.push('sort');
        const msg = `Streaming mode: ${scopeBits.join(' + ')} is applied to loaded rows only.`;

        const hint = createInlineBanner({
          severity: 'warning',
          message: msg,
          actionLabel: 'Apply to full dataset',
          onAction: () => {
            const derived = buildDerivedQueryFromLocalScope();
            if (!derived) {
              context.postMessage?.({
                type: 'showErrorMessage',
                message: 'No active local filter/sort to apply.',
              });
              return;
            }
            context.postMessage?.({
              type: 'runDerivedQuery',
              query: derived,
              source: 'streaming-local-scope',
              fullDataset: true,
              sourceCellIndex,
            });
          },
          dismissible: false,
        });
        hint.setAttribute('data-streaming-scope-hint', 'true');
        mainContainer.appendChild(hint);
      };

      // Result history for tab strip — persists across re-renders in same output element
      const historyEntry = {
        columns,
        rows: currentRows,
        columnTypes,
        tableInfo,
        command,
        rowCount,
        executionTime,
        query,
        notices: noticeItems.length ? [...noticeItems] : undefined,
        timestamp: Date.now(),
        byteaDisplayFormat,
      };
      const resultHistory = addResultToHistory(element, historyEntry);

      // Main Container
      const mainContainer = document.createElement('div');
      mainContainer.style.cssText = `
        font-family: var(--vscode-font-family), "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 13px;
        color: var(--vscode-editor-foreground);
        border: 1px solid var(--vscode-widget-border);
        border-top: 2px solid ${BRAND_ACCENT};
        border-radius: 6px;
        overflow: hidden;
        margin-bottom: 8px;
        box-shadow: ${RENDERER_ELEVATION_2};
        background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background));
        background-image: radial-gradient(ellipse 80% 50% at 100% 0%, color-mix(in srgb, ${BRAND_ACCENT} 6%, transparent), transparent 60%);
      `;

      const contentContainer = document.createElement('div');
      contentContainer.style.cssText = 'display: flex; flex-direction: column; height: 100%;';

      let switchTab: (mode: string) => void = () => {};
      let showOverflowMenu: (anchorEl: HTMLElement) => void = () => {};

      let isExpanded = true;

      const updateIdentityStats = (): void => {
        const el = mainContainer.querySelector('[data-result-stats]') as HTMLElement | null;
        if (!el) return;
        let text: string;
        if (slideMeta) {
          const lastRow = slideMeta.windowStartRow + Math.max(currentRows.length, 1) - 1;
          if (typeof slideMeta.totalRows === 'number') {
            text = `${slideMeta.windowStartRow.toLocaleString()}–${lastRow.toLocaleString()} of ${slideMeta.totalRows.toLocaleString()} · window ${slideMeta.windowSize.toLocaleString()} · streaming`;
          } else {
            text = `${slideMeta.windowStartRow.toLocaleString()}–${lastRow.toLocaleString()} · window ${slideMeta.windowSize.toLocaleString()} · streaming`;
            // Add diagnostic info for why total is unknown
            if ((slideMeta as any).countAttempted) {
              if ((slideMeta as any).countError) {
                text += ` (total count failed: ${(slideMeta as any).countError.substring(0, 50)})`;
              } else {
                text += ' (total row count in progress)';
              }
            }
          }
          if (executionTime !== undefined) {
            const ms = Math.round(executionTime * 1000);
            text += ms >= 1000 ? ` · ${executionTime.toFixed(2)}s` : ` · ${ms}ms`;
          }
        } else {
          text = formatResultExecutionStats(currentRows.length, executionTime);
        }
        el.textContent = text;
        el.style.display = text.trim() ? 'inline-block' : 'none';
      };

      const identityBar = createResultIdentityBar({
        queryPreview: buildQueryPreview(query, (command || 'QUERY').toUpperCase()),
        queryFull: query,
        command,
        statsLine: json.error
          ? undefined
          : slideMeta
            ? (() => {
                const lastRow = slideMeta.windowStartRow + Math.max(rows?.length ?? 0, 1) - 1;
                let t: string;
                if (typeof slideMeta.totalRows === 'number') {
                  t = `${slideMeta.windowStartRow.toLocaleString()}–${lastRow.toLocaleString()} of ${slideMeta.totalRows.toLocaleString()} · window ${slideMeta.windowSize.toLocaleString()} · streaming`;
                } else {
                  t = `${slideMeta.windowStartRow.toLocaleString()}–${lastRow.toLocaleString()} · window ${slideMeta.windowSize.toLocaleString()} · streaming`;
                  // Add diagnostic info for why total is unknown
                  if ((slideMeta as any).countAttempted) {
                    if ((slideMeta as any).countError) {
                      t += ` (total count failed: ${(slideMeta as any).countError.substring(0, 50)})`;
                    } else {
                      t += ' (total row count in progress)';
                    }
                  }
                }
                if (executionTime !== undefined) {
                  const ms = Math.round(executionTime * 1000);
                  t += ms >= 1000 ? ` · ${executionTime.toFixed(2)}s` : ` · ${ms}ms`;
                }
                return t;
              })()
            : formatResultExecutionStats(currentRows.length, executionTime),
        isCollapsed: false,
        onToggleCollapse: () => {
          isExpanded = !isExpanded;
          contentContainer.style.display = isExpanded ? 'flex' : 'none';
          const ch = identityBar.querySelector('[data-chevron]');
          if (ch) {
            ch.textContent = isExpanded ? '▼' : '▶';
          }
        },
        onOverflow: (anchorEl) => showOverflowMenu(anchorEl),
        onExpand: () =>
          context.postMessage?.({
            type: 'notebookOutputToolbar',
            action: 'expand',
            cellIndex: sourceCellIndex,
          }),
      });
      mainContainer.appendChild(identityBar);

      if (autoLimitApplied) {
        const limitMsg =
          autoLimitValue !== undefined
            ? `Auto-LIMIT applied: showing ${formatRowCountForDisplay(rowCount, '?')} rows (limit ${autoLimitValue})`
            : 'A row limit was appended to this SELECT.';
        mainContainer.appendChild(createInlineBanner({ severity: 'info', message: limitMsg }));
      }

      if (slideMeta?.sessionId && json.showSlidingCursorBanner === true && !json.error) {
        mainContainer.appendChild(
          createInlineBanner({
            severity: 'warning',
            message:
              'Server-side cursor: one window loaded. Scroll edges to paginate, or run on full dataset for accurate analysis/export (may impact local performance).',
            actionLabel: 'Run on full dataset',
            onAction: () => runFullDatasetRerun('streaming-table-full-dataset'),
            onDismiss: () => context.postMessage?.({ type: 'cursorStreamBannerDismiss' }),
            onMuteForever: () => context.postMessage?.({ type: 'cursorStreamBannerMute' }),
          }),
        );
      }

      if (json.performanceAnalysis?.isDegraded || json.slowQuery) {
        const degraded = Boolean(json.performanceAnalysis?.isDegraded);
        const perfMsg = degraded
          ? json.performanceAnalysis!.analysis
          : 'Slow query detected. Consider reviewing indexes and filters.';
        mainContainer.appendChild(
          createInlineBanner({ severity: degraded ? 'warning' : 'info', message: perfMsg }),
        );
      }

      if (noticeItems.length > 0) {
        mainContainer.appendChild(
          createInlineBanner({
            severity: 'warning',
            message: `${noticeItems.length} notice${noticeItems.length !== 1 ? 's' : ''} from PostgreSQL`,
            actionLabel: 'View',
            onAction: () => switchTab('notices'),
          }),
        );
      }

      if (pendingCommit) {
        mainContainer.appendChild(
          createInlineBanner({
            severity: 'info',
            message:
              'This result was produced inside an open transaction — changes are not durable until COMMIT.',
            dismissible: false,
          }),
        );
      }

      mainContainer.appendChild(contentContainer);

      // Error Section
      if (json.error) {
        const errorPanel = createErrorPanel({
          errorCode: json.errorCode,
          errorMessage: json.error,
          explanation: json.errorExplanation,
          onExplainError: () => {
            context.postMessage?.({ type: 'explainError', error: json.error, query: json.query });
          },
          onFixWithAI: () => {
            context.postMessage?.({ type: 'fixQuery', error: json.error, query: json.query });
          },
          onRetry: () => {
            // Client-side retry: re-execute the cell by posting retryCell to the kernel
            context.postMessage?.({ type: 'retryCell', query: json.query });
          },
        });
        contentContainer.appendChild(errorPanel);
      }

      // Build the hidden export button to reuse its existing dropdown flow
      const exportBtn = createExportButton(columns, currentRows, tableInfo, context, query);
      exportBtn.style.display = 'none';

      const gridPrefRequestId = `gcp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      let skipGridCommitConfirm = false;
      if (!json.error) {
        context.postMessage?.({
          type: 'gridCommitPreference',
          action: 'get',
          requestId: gridPrefRequestId,
        });
      }

      /** Export dropdown for footer row tools + kernel export flows */
      const openResultExportMenu = (anchorBtn: HTMLElement): void => {
        const existing = document.querySelector('.export-dropdown');
        if (existing) {
          existing.remove();
          return;
        }

        const menu = document.createElement('div');
        menu.className = 'export-dropdown';
        menu.style.cssText =
          `position:fixed;background:var(--vscode-menu-background);border:1px solid var(--vscode-menu-border);box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:${EXPORT_MENU_Z_INDEX};min-width:160px;border-radius:3px;padding:4px 0;visibility:hidden;`;

        const addItem = (label: string, onClick: () => void) => {
          const item = document.createElement('div');
          item.textContent = label;
          item.style.cssText =
            'padding:6px 12px;cursor:pointer;color:var(--vscode-menu-foreground);font-size:12px;';
          item.onmouseenter = () => {
            item.style.background = 'var(--vscode-menu-selectionBackground)';
            item.style.color = 'var(--vscode-menu-selectionForeground)';
          };
          item.onmouseleave = () => {
            item.style.background = 'transparent';
            item.style.color = 'var(--vscode-menu-foreground)';
          };
          item.onclick = (e) => {
            e.stopPropagation();
            onClick();
            menu.remove();
          };
          menu.appendChild(item);
        };

        const postExport = (
          format: 'csv' | 'json' | 'markdown' | 'clipboard' | 'sqlinsert',
        ): void => {
          context.postMessage?.({
            type: 'export_request',
            format,
            query: exportQuery,
            columns,
            rows: currentRows, // fallback only if full query export fails
            tableInfo,
          });
        };

        addItem('Save as CSV', () => postExport('csv'));
        addItem('Save as JSON', () => postExport('json'));
        addItem('Save as Markdown', () => postExport('markdown'));
        addItem('Copy to Clipboard', () => {
          postExport('clipboard');
          setExportToolbarButtonLabel(anchorBtn as HTMLButtonElement, 'Working...');
          setTimeout(() => {
            setExportToolbarButtonLabel(anchorBtn as HTMLButtonElement, 'Export');
          }, 2000);
        });
        if (tableInfo) {
          addItem('Copy SQL INSERT', () => {
            postExport('sqlinsert');
            setExportToolbarButtonLabel(anchorBtn as HTMLButtonElement, 'Working...');
            setTimeout(() => {
              setExportToolbarButtonLabel(anchorBtn as HTMLButtonElement, 'Export');
            }, 2000);
          });
        }

        document.body.appendChild(menu);

        positionExportDropdown(menu, anchorBtn);
        menu.style.visibility = 'visible';
        setTimeout(() => {
          const close = () => {
            menu.remove();
            document.removeEventListener('click', close);
          };
          document.addEventListener('click', close);
        }, 0);
      };

      const aiMenuCallbacks: AiMenuOptions = {
        onSendToChat: () => {
          const resultsJson = buildChatResultsSampleJson(
            columns,
            currentRows,
            CHAT_SEND_SAMPLE_ROW_CAP,
          );
          context.postMessage?.({
            type: 'sendToChat',
            data: {
              query: json.query || '',
              ...(resultsJson ? { results: resultsJson, totalRowCount: currentRows.length } : {}),
            },
          });
        },
        onAnalyzeWithAI: () => {
          const escapeCSV = (val: any): string => {
            if (val === null || val === undefined) return '';
            const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          };
          const csvHeader = columns.map((c: string) => `"${c.replace(/"/g, '""')}"`).join(',');
          const csvRows = currentRows.map((r: any) =>
            columns.map((c: string) => escapeCSV(r[c])).join(','),
          );
          const dataCsv = [csvHeader, ...csvRows].join('\n');
          context.postMessage?.({
            type: 'analyzeData',
            data: dataCsv,
            query: json.query || '',
            rowCount: currentRows.length,
          });
        },
        onOptimize: () => {
          context.postMessage?.({
            type: 'optimizeQuery',
            query: json.query,
            executionTime: json.executionTime,
          });
        },
      };

      // Save Changes Logic — review panel wired after TableRenderer

      let reviewTabBtn: HTMLButtonElement | null = null;

      /** Active view — used so the footer hides Delete when not on the table tab */
      let currentMode: string = 'table';

      let syncReviewTabButton: () => void = () => {};

      let stopPendingSaveLoading: (() => void) | undefined;

      let refreshResultFooter: () => void = () => {};

      function syncPendingChangesUi(): void {
        syncReviewTabButton();
        refreshResultFooter();
      }

      function runPerformSaveCommit(): void {
        console.log('Renderer: Commit / save invoked');
        console.log('Renderer: Modified cells size:', modifiedCells.size);
        console.log('Renderer: Rows marked for deletion:', rowsMarkedForDeletion.size);

        const updates: any[] = [];
        modifiedCells.forEach((diff, key) => {
          const parsed = parseCellKey(key);
          if (!parsed) return;
          const { rowIndex, colName } = parsed;

          console.log(`Renderer: Processing diff for row ${rowIndex}, col ${colName}`);

          if (tableInfo?.primaryKeys) {
            const pkValues: Record<string, any> = {};
            tableInfo.primaryKeys.forEach((pk: string) => {
              pkValues[pk] = originalRows[rowIndex][pk];
            });
            updates.push({
              keys: pkValues,
              column: colName,
              value: diff.newValue,
              originalValue: diff.originalValue,
            });
          } else {
            console.warn('Renderer: No primary keys found in tableInfo', tableInfo);
          }
        });

        const deletions: any[] = [];
        rowsMarkedForDeletion.forEach((rowIndex) => {
          if (tableInfo?.primaryKeys) {
            const pkValues: Record<string, any> = {};
            tableInfo.primaryKeys.forEach((pk: string) => {
              pkValues[pk] = originalRows[rowIndex][pk];
            });
            deletions.push({
              keys: pkValues,
              row: originalRows[rowIndex],
            });
          }
        });

        console.log('Renderer: Updates prepared:', updates);
        console.log('Renderer: Deletions prepared:', deletions);

        if (updates.length > 0 || deletions.length > 0) {
          console.log('Renderer: Posting saveChanges message');
          stopPendingSaveLoading?.();
          stopPendingSaveLoading = undefined;
          const commitBtn = contentContainer.querySelector(
            '[data-pg-result-commit]',
          ) as HTMLButtonElement | null;
          stopPendingSaveLoading = commitBtn
            ? startButtonLoading(commitBtn, 'Saving...')
            : undefined;
          context.postMessage?.({
            type: 'saveChanges',
            updates,
            deletions,
            tableInfo,
          });
        } else {
          const reason = !tableInfo?.primaryKeys
            ? 'No primary keys found for this table.'
            : 'Unknown error preparing updates.';
          console.warn(`Renderer: Save failed. ${reason}`);
          context.postMessage?.({
            type: 'showErrorMessage',
            message: `Cannot save changes: ${reason} (Primary keys are required to identify rows)`,
          });
        }
      }

      /** Tracks whether the commit button is in the "Confirm?" armed state. */
      let commitArmed = false;
      let commitArmTimer: ReturnType<typeof setTimeout> | undefined;

      function resetCommitArm(): void {
        commitArmed = false;
        if (commitArmTimer !== undefined) {
          clearTimeout(commitArmTimer);
          commitArmTimer = undefined;
        }
        // Reset the commit button appearance back to normal
        const commitBtn = contentContainer.querySelector<HTMLButtonElement>(
          '[data-pg-result-commit]',
        );
        if (commitBtn) {
          const dirty = modifiedCells.size + rowsMarkedForDeletion.size;
          commitBtn.textContent = `Commit (${dirty})`;
          commitBtn.style.background = 'color-mix(in srgb, #f59e0b 15%, transparent)';
          commitBtn.style.color = '#f59e0b';
          commitBtn.style.borderColor = 'color-mix(in srgb, #f59e0b 40%, transparent)';
        }
      }

      function performSave(): void {
        const dirty = modifiedCells.size + rowsMarkedForDeletion.size;
        if (dirty <= 0) {
          return;
        }
        if (skipGridCommitConfirm) {
          runPerformSaveCommit();
          return;
        }

        if (commitArmed) {
          // Second click — actually commit
          resetCommitArm();
          runPerformSaveCommit();
          return;
        }

        // First click — arm the button: turn red with "Confirm?" text
        commitArmed = true;
        const commitBtn = contentContainer.querySelector<HTMLButtonElement>(
          '[data-pg-result-commit]',
        );
        if (commitBtn) {
          const CONFIRM_RED = '#ef4444';
          commitBtn.textContent = `Confirm? (${dirty})`;
          commitBtn.style.background = `color-mix(in srgb, ${CONFIRM_RED} 18%, transparent)`;
          commitBtn.style.color = CONFIRM_RED;
          commitBtn.style.borderColor = `color-mix(in srgb, ${CONFIRM_RED} 50%, transparent)`;
        }

        // Auto-reset after 4 seconds
        commitArmTimer = setTimeout(resetCommitArm, 4000);

        // Reset if user clicks anywhere else
        const onClickElsewhere = (e: MouseEvent) => {
          if (commitBtn && !commitBtn.contains(e.target as Node)) {
            resetCommitArm();
            document.removeEventListener('click', onClickElsewhere, true);
          }
        };
        document.addEventListener('click', onClickElsewhere, true);
      }

      let applyCursorResponse: ((message: any) => void) | undefined;

      function markSelectedRowsForDeletion(): void {
        if (selectedIndices.size === 0) return;
        selectedIndices.forEach((index) => {
          rowsMarkedForDeletion.add(index);
        });
        selectedIndices.clear();
        syncPendingChangesUi();
        tableRenderer.render(buildTableRenderOptions());
        updateActionsVisibility();
      }

      // Listen for messages from extension host
      context.onDidReceiveMessage?.((message: any) => {
        if (
          message.type === 'gridCommitPreferenceResponse' &&
          message.requestId === gridPrefRequestId &&
          message.skipConfirm === true
        ) {
          skipGridCommitConfirm = true;
          return;
        }

        // FK lookup response — resolve the waiting dropdown callback
        if (message.type === 'fkLookupResponse') {
          const cb = fkCallbacks.get(message.requestId);
          if (cb) {
            cb(message.rows || [], message.columns || []);
            fkCallbacks.delete(message.requestId);
          }
          return;
        }

        if (message.type === 'resultCursorResponse') {
          applyCursorResponse?.(message);
          return;
        }

        // In-grid insert row result
        if (message.type === 'insertSuccess') {
          tableRenderer.replaceInsertRow(message.tempId, message.actualRow);
          return;
        }
        if (message.type === 'insertFailed') {
          tableRenderer.markInsertFailed(message.tempId, message.error || 'Insert failed');
          return;
        }

        if (message.type === 'saveSuccess') {
          console.log(
            'Renderer: Received saveSuccess, clearing modified cells and removing deleted rows',
          );

          stopPendingSaveLoading?.();
          stopPendingSaveLoading = undefined;

          // Update originalRows with edited values before removing any rows.
          // The renderer now tracks edits by stable source index, so applying
          // edits first keeps those indices aligned for the remaining rows.
          modifiedCells.forEach((diff, key) => {
            const parsed = parseCellKey(key);
            if (!parsed) return;
            const { rowIndex, colName } = parsed;
            if (rowIndex >= 0 && rowIndex < originalRows.length) {
              originalRows[rowIndex][colName] = diff.newValue;
            }
          });

          // Remove deleted rows from arrays (in reverse order to maintain indices)
          const deletedIndices = Array.from(rowsMarkedForDeletion).sort((a, b) => b - a);
          deletedIndices.forEach((index) => {
            currentRows.splice(index, 1);
            originalRows.splice(index, 1);
          });

          // Clear all pending changes
          modifiedCells.clear();
          rowsMarkedForDeletion.clear();

          syncPendingChangesUi();

          // Re-render table to remove highlights and deleted rows
          if (tableRenderer) {
            tableRenderer.render(buildTableRenderOptions());
          }
        }

        if (message.type === 'saveFailed') {
          stopPendingSaveLoading?.();
          stopPendingSaveLoading = undefined;
        }

        if (message.type === 'explainJsonConverted' && typeof message.explainPlan !== 'undefined') {
          json.explainPlan = message.explainPlan;
          if (typeof message.query === 'string' && message.query.trim().length > 0) {
            json.query = message.query;
          }
          switchTab('explain');
          return;
        }
      });

      /** Last Table / Chart / Analyst view when browsing notices etc. */
      let lastPrimaryMode: 'table' | 'chart' | 'analyst' = 'table';

      // Secondary band: left = Table / Chart / … + optional View Plan; right = Export chart + AI (after chart init)
      const secondaryTabsOuter = document.createElement('div');
      secondaryTabsOuter.style.cssText =
        'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);';

      const secondaryTabsLeft = document.createElement('div');
      secondaryTabsLeft.style.cssText =
        'display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1;min-width:0;';

      const secondaryTabsRight = document.createElement('div');
      secondaryTabsRight.style.cssText =
        'display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:auto;';

      const isExplainQuery =
        json.explainPlan ||
        (query && /^\s*EXPLAIN/i.test(query)) ||
        command === 'EXPLAIN' ||
        (columns.length === 1 && columns[0] === 'QUERY PLAN');

      if (json.explainPlan && isExplainQuery) {
        context.postMessage?.({
          type: 'syncPlanStudioFromRun',
          plan: json.explainPlan,
          query,
          sourceCellIndex,
          performanceAnalysis: json.performanceAnalysis,
        });
      }

      if (isExplainQuery) {
        const explainPlanBtn = document.createElement('button');
        explainPlanBtn.type = 'button';
        fillToolbarButtonContent(explainPlanBtn, 'explain', 'View Plan');
        applyResultRowToolStyle(explainPlanBtn);
        attachResultRowToolInteractions(explainPlanBtn);
        explainPlanBtn.title = json.explainPlan
          ? 'Open EXPLAIN ANALYZE plan view'
          : 'Convert to JSON format and open visual plan view';

        explainPlanBtn.onclick = () => {
          if (json.explainPlan) {
            switchTab('explain');
          } else {
            console.log('Converting EXPLAIN to JSON, query:', query);
            if (!query) {
              alert('Cannot convert EXPLAIN plan: query not available');
              return;
            }
            context.postMessage?.({
              type: 'convertExplainToJson',
              query: query,
              sourceCellIndex,
            });
          }
        };
        secondaryTabsLeft.appendChild(explainPlanBtn);
      }

      const tableViewBtn = document.createElement('button');
      tableViewBtn.type = 'button';
      fillToolbarButtonContent(tableViewBtn, 'table', 'Table');
      tableViewBtn.onclick = () => switchTab('table');
      attachResultViewTabHover(tableViewBtn);

      const chartViewBtn = document.createElement('button');
      chartViewBtn.type = 'button';
      fillToolbarButtonContent(chartViewBtn, 'chart', 'Chart');
      chartViewBtn.onclick = () => switchTab('chart');
      attachResultViewTabHover(chartViewBtn);

      const analystViewBtn = document.createElement('button');
      analystViewBtn.type = 'button';
      fillToolbarButtonContent(analystViewBtn, 'analyst', 'Analyst');
      analystViewBtn.onclick = () => switchTab('analyst');
      attachResultViewTabHover(analystViewBtn);

      const syncPrimaryButtons = () => {
        applyResultViewTabStyle(tableViewBtn, lastPrimaryMode === 'table');
        applyResultViewTabStyle(chartViewBtn, lastPrimaryMode === 'chart');
        applyResultViewTabStyle(analystViewBtn, lastPrimaryMode === 'analyst');
      };
      syncPrimaryButtons();

      const noticesBtn = document.createElement('button');
      noticesBtn.type = 'button';
      const noticesLabel =
        noticeItems.length > 0 ? `Notices (${noticeItems.length})` : 'Notices';
      fillToolbarButtonContent(noticesBtn, 'notices', noticesLabel);
      noticesBtn.onclick = () => switchTab('notices');
      applyResultViewTabStyle(noticesBtn, false);
      attachResultViewTabHover(noticesBtn);

      const transposeBtn = document.createElement('button');
      transposeBtn.type = 'button';
      fillToolbarButtonContent(transposeBtn, 'transpose', 'Transpose');
      transposeBtn.onclick = () => {
        if (currentMode === 'transpose') {
          switchTab(lastPrimaryMode || 'table');
        } else {
          switchTab('transpose');
        }
      };
      applyResultViewTabStyle(transposeBtn, false);
      attachResultViewTabHover(transposeBtn);

      reviewTabBtn = document.createElement('button');
      reviewTabBtn.type = 'button';
      reviewTabBtn.onclick = () => switchTab('review');

      let explainTabBtn: HTMLButtonElement | null = null;
      if (isExplainQuery) {
        explainTabBtn = document.createElement('button');
        explainTabBtn.type = 'button';
        fillToolbarButtonContent(explainTabBtn, 'explain', 'Explain Plan');
        explainTabBtn.onclick = () => switchTab('explain');
        applyResultViewTabStyle(explainTabBtn, false);
        attachResultViewTabHover(explainTabBtn);
      }

      const REVIEW_AMBER = '#f59e0b';
      syncReviewTabButton = () => {
        syncReviewTabButtonUi(reviewTabBtn, {
          modifiedCells,
          rowsMarkedForDeletion,
          currentMode,
        });
      };

      reviewTabBtn.addEventListener('mouseenter', () => {
        if (!reviewTabBtn || currentMode === 'review') return;
        const pending = modifiedCells.size + rowsMarkedForDeletion.size;
        reviewTabBtn.style.background = pending > 0
          ? `color-mix(in srgb, ${REVIEW_AMBER} 16%, color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 48%, transparent))`
          : 'color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 55%, transparent)';
      });
      reviewTabBtn.addEventListener('mouseleave', () => syncReviewTabButton());

      secondaryTabsLeft.appendChild(tableViewBtn);
      secondaryTabsLeft.appendChild(chartViewBtn);
      secondaryTabsLeft.appendChild(analystViewBtn);
      secondaryTabsLeft.appendChild(noticesBtn);
      secondaryTabsLeft.appendChild(transposeBtn);
      secondaryTabsLeft.appendChild(reviewTabBtn);
      if (explainTabBtn) secondaryTabsLeft.appendChild(explainTabBtn);

      secondaryTabsOuter.appendChild(secondaryTabsLeft);
      secondaryTabsOuter.appendChild(secondaryTabsRight);

      if (!json.error) {
        contentContainer.appendChild(secondaryTabsOuter);
      }

      syncReviewTabButton();

      // Views Containers
      const viewContainer = document.createElement('div');
      viewContainer.style.cssText =
        'flex: 1; overflow: hidden; display: flex; flex-direction: column; position: relative; max-height: 500px;';
      if (!json.error) {
        contentContainer.appendChild(viewContainer);
      }

      // TABLE RENDERER
      const tableRenderer = new TableRenderer(viewContainer, {
        onSelectionChange: (indices) => {
          selectedIndices.clear();
          indices.forEach((i) => selectedIndices.add(i));
          updateActionsVisibility();
        },
        onDataChange: (_rowIndex, _col, _newVal, _originalVal) => {
          syncPendingChangesUi();
          updateActionsVisibility();
          if (currentMode === 'review') {
            switchTab('review');
          }
        },
        onInsertRow: (values, tempId) => {
          context.postMessage?.({ type: 'insertRow', tableInfo, values, tempId });
        },
        onFkLookup: (requestId, fkSchema, fkTable, fkColumn, searchText, callback) => {
          fkCallbacks.set(requestId, callback);
          context.postMessage?.({
            type: 'fkLookup',
            requestId,
            fkSchema,
            fkTable,
            fkColumn,
            searchText,
            limit: 50,
          });
        },
        onSortChange: (column, direction) => {
          localSortState = { column, direction };
          refreshStreamingScopeNotice();
        },
        onFilterChange: (state) => {
          localFilterState = {
            globalQuery: state.globalQuery || '',
            clauses: state.clauses.map((c) => ({ ...c })),
          };
          refreshStreamingScopeNotice();
        },
      });

      // Store for cleanup on disposal
      tableInstances.set(element, tableRenderer);

      const renderReviewChangesView = createRenderReviewChangesView({
        columns,
        originalRows,
        tableInfo,
        modifiedCells,
        rowsMarkedForDeletion,
        tableRenderer,
        buildTableRenderOptions,
        syncPendingChangesUi,
        switchTab: (mode: string) => switchTab(mode),
      });

      let slideFetchBusy = false;
      let pendingSlideRequestId = '';
      let pendingSlideTargetStart: number | undefined;
      let suppressSlideScrollUntil = 0;
      let slideScrollCleanup: (() => void) | undefined;
      const DEFAULT_ROW_HEIGHT_PX = 30;
      const getSlideWindowSize = (): number =>
        Math.max(10, slideMeta?.windowSize ?? 100);
      const getMaxBufferedRows = (): number => getSlideWindowSize() * 3;
      const estimateDataRowHeight = (): number => {
        const row = tableRenderer
          .getScrollContainer()
          .querySelector('tr[data-source-index]') as HTMLElement | null;
        if (!row) {
          return DEFAULT_ROW_HEIGHT_PX;
        }
        return Math.max(16, row.offsetHeight || DEFAULT_ROW_HEIGHT_PX);
      };
      const syncSlideMetaFromBuffer = (): void => {
        if (!slideMeta?.sessionId) {
          return;
        }
        slideMeta = {
          sessionId: slideMeta.sessionId,
          windowStartRow: slideBufferedStartRow,
          windowSize: getSlideWindowSize(),
          hasMoreBefore: slideHasMoreBefore,
          hasMoreAfter: slideHasMoreAfter,
          totalRows: slideMeta.totalRows,
        };
      };

      const attachSlideScroll = (): void => {
        slideScrollCleanup?.();
        slideScrollCleanup = undefined;
        if (!slideMeta?.sessionId) {
          return;
        }
        const root = tableRenderer.getScrollContainer();
        let ticking = false;
        const EDGE_PX = 72;
        const onScroll = (): void => {
          if (!slideMeta?.sessionId || slideFetchBusy) {
            return;
          }
          if (Date.now() < suppressSlideScrollUntil) {
            return;
          }
          if (ticking) {
            return;
          }
          ticking = true;
          requestAnimationFrame(() => {
            ticking = false;
            if (!slideMeta?.sessionId || slideFetchBusy) {
              return;
            }
            const distBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
            const distTop = root.scrollTop;
            let nextStart: number | undefined;
            if (slideHasMoreAfter && distBottom < EDGE_PX) {
              nextStart = slideBufferedStartRow + currentRows.length;
            } else if (slideHasMoreBefore && distTop < EDGE_PX) {
              nextStart = Math.max(1, slideBufferedStartRow - getSlideWindowSize());
            }
            if (nextStart === undefined || nextStart === slideBufferedStartRow) {
              return;
            }
            slideFetchBusy = true;
            pendingSlideTargetStart = nextStart;
            pendingSlideRequestId = `slide-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
            context.postMessage?.({
              type: 'resultCursorFetch',
              sessionId: slideMeta.sessionId,
              pageStartRow: nextStart,
              requestId: pendingSlideRequestId,
            });
          });
        };
        root.addEventListener('scroll', onScroll, { passive: true });
        slideScrollCleanup = (): void => {
          root.removeEventListener('scroll', onScroll);
        };
      };

      applyCursorResponse = (message: any): void => {
        if (pendingSlideRequestId && message.requestId !== pendingSlideRequestId) {
          return;
        }
        const previousWindowStart = slideBufferedStartRow;
        const requestedStart = pendingSlideTargetStart;
        const rootBefore = tableRenderer.getScrollContainer();
        const prevScrollTop = rootBefore.scrollTop;
        const rowHeight = estimateDataRowHeight();
        let scrollAdjustPx = 0;
        slideFetchBusy = false;
        pendingSlideRequestId = '';
        pendingSlideTargetStart = undefined;
        if (message.error) {
          slideScrollCleanup?.();
          slideScrollCleanup = undefined;
          slideMeta = undefined;
          mainContainer.insertBefore(
            createInlineBanner({ severity: 'warning', message: String(message.error) }),
            contentContainer,
          );
          refreshStreamingScopeNotice();
          return;
        }
        const incomingRows = message.rows ? JSON.parse(JSON.stringify(message.rows)) : [];
        const incomingOriginalRows = JSON.parse(JSON.stringify(incomingRows));
        const movedForward =
          typeof requestedStart === 'number' && requestedStart > previousWindowStart;
        const movedBackward =
          typeof requestedStart === 'number' && requestedStart < previousWindowStart;

        if (!slideMeta?.sessionId || !requestedStart) {
          currentRows = incomingRows;
          originalRows = incomingOriginalRows;
          slideBufferedStartRow = message.slidingWindow?.windowStartRow ?? slideBufferedStartRow;
        } else if (movedForward) {
          currentRows = [...currentRows, ...incomingRows];
          originalRows = [...originalRows, ...incomingOriginalRows];
        } else if (movedBackward) {
          currentRows = [...incomingRows, ...currentRows];
          originalRows = [...incomingOriginalRows, ...originalRows];
          slideBufferedStartRow = requestedStart;
          scrollAdjustPx += incomingRows.length * rowHeight;
        } else {
          currentRows = incomingRows;
          originalRows = incomingOriginalRows;
          slideBufferedStartRow = requestedStart;
        }

        const maxBufferedRows = getMaxBufferedRows();
        if (currentRows.length > maxBufferedRows) {
          const overflow = currentRows.length - maxBufferedRows;
          if (movedForward) {
            currentRows = currentRows.slice(overflow);
            originalRows = originalRows.slice(overflow);
            slideBufferedStartRow += overflow;
            scrollAdjustPx -= overflow * rowHeight;
          } else if (movedBackward) {
            currentRows = currentRows.slice(0, currentRows.length - overflow);
            originalRows = originalRows.slice(0, originalRows.length - overflow);
          } else {
            currentRows = currentRows.slice(0, maxBufferedRows);
            originalRows = originalRows.slice(0, maxBufferedRows);
          }
        }

        if (message.slidingWindow) {
          if (movedForward) {
            slideHasMoreAfter = message.slidingWindow.hasMoreAfter;
          } else if (movedBackward) {
            slideHasMoreBefore = message.slidingWindow.hasMoreBefore;
          } else {
            slideHasMoreBefore = message.slidingWindow.hasMoreBefore;
            slideHasMoreAfter = message.slidingWindow.hasMoreAfter;
          }
          if (typeof message.slidingWindow.totalRows === 'number') {
            // preserve known total rows on incoming window updates
            slideMeta = {
              ...(slideMeta ?? {}),
              totalRows: message.slidingWindow.totalRows,
            } as any;
          }
          if (slideBufferedStartRow > 1) {
            slideHasMoreBefore = true;
          }
          syncSlideMetaFromBuffer();
        }
        refreshStreamingScopeNotice();
        selectedIndices.clear();
        modifiedCells.clear();
        rowsMarkedForDeletion.clear();
        if (currentMode === 'table') {
          tableRenderer.render(buildTableRenderOptions());
        }
        updateIdentityStats();
        refreshResultFooter();
        suppressSlideScrollUntil = Date.now() + 120;
        requestAnimationFrame(() => {
          const root = tableRenderer.getScrollContainer();
          const nextScrollTop = Math.max(0, prevScrollTop + scrollAdjustPx);
          root.scrollTop = nextScrollTop;
        });
      };

      const rowToolHandlers: RowToolsOptions = {
        onSelectAll: () => {
          if (selectedIndices.size === currentRows.length && currentRows.length > 0) {
            selectedIndices.clear();
          } else {
            currentRows.forEach((_: any, i: number) => selectedIndices.add(i));
          }
          tableRenderer.updateSelection(selectedIndices);
          refreshResultFooter();
        },
        onCopy: () => {
          const rowsToCopy =
            selectedIndices.size > 0
              ? Array.from(selectedIndices).map((i) => currentRows[i])
              : currentRows;
          const escapeCSV = (val: any): string => {
            if (val === null || val === undefined) return '';
            const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          };
          const csv = [
            columns.map((c: string) => `"${c.replace(/"/g, '""')}"`).join(','),
            ...rowsToCopy.map((r: any) => columns.map((c: string) => escapeCSV(r[c])).join(',')),
          ].join('\n');
          navigator.clipboard?.writeText(csv);
        },
        onImport: () => {
          void import('../../../renderer/features/import').then(({ showImportModal }) => {
            showImportModal(columns, tableInfo, context);
          });
        },
        onExport: openResultExportMenu,
      };

      refreshResultFooter = () => {
        if (json.error) return;
        contentContainer.querySelector('[data-result-footer="true"]')?.remove();
        const dirty = modifiedCells.size + rowsMarkedForDeletion.size;
        const tableView = currentMode === 'table';
        const sel = tableView ? selectedIndices.size : 0;
        contentContainer.appendChild(
          createResultFooter({
            rowTools:
              columns.length > 0
                ? {
                    ...rowToolHandlers,
                    allRowsSelected:
                      tableView &&
                      currentRows.length > 0 &&
                      selectedIndices.size === currentRows.length,
                  }
                : undefined,
            onAddRow: tableInfo
              ? () => {
                  switchTab('table');
                  requestAnimationFrame(() => tableRenderer.triggerAddRow());
                }
              : undefined,
            dirtyCount: dirty,
            onCommit: dirty > 0 ? performSave : undefined,
            deleteSelectionCount: sel,
            onDeleteSelected: sel > 0 && tableView ? markSelectedRowsForDeletion : undefined,
            deleteUnavailableReason:
              sel > 0 && !tableInfo?.primaryKeys
                ? 'Warning: No primary keys detected. Deletion may fail.'
                : undefined,
            onRevert:
              dirty > 0
                ? () => {
                    tableRenderer.revertAllPendingChanges();
                    syncPendingChangesUi();
                  }
                : undefined,
          }),
        );
        updateIdentityStats();
      };

      /** Lazily populated when Chart tab is opened (see `lazy/chartTab`). */
      let chartRenderer: ChartRenderer | undefined;
      let lazyViewGeneration = 0;

      const exportChartBtn = document.createElement('button');
      exportChartBtn.type = 'button';
      fillToolbarButtonContent(exportChartBtn, 'chart', 'Export Chart');
      applyResultRowToolStyle(exportChartBtn);
      attachResultRowToolInteractions(exportChartBtn);
      exportChartBtn.style.display = 'none'; // Hidden by default
      exportChartBtn.onclick = () => {
        const dataUrl = chartRenderer?.exportImage('png');
        if (dataUrl) {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = `chart-${new Date().toISOString()}.png`;
          a.click();
        }
      };
      const actionsMenuCallbacks: ActionsMenuOptions = {
        onSendToChat: () => {
          aiMenuCallbacks.onSendToChat();
        },
        onSaveQuery: () => {
          context.postMessage?.({
            type: 'notebookOutputToolbar',
            action: 'saveQuery',
            cellIndex: sourceCellIndex,
          });
        },
        onRunFullDataset: () => {
          runFullDatasetRerun('result-actions-full-dataset');
        },
        onExplainAnalyze: () => {
          context.postMessage?.({
            type: 'notebookOutputToolbar',
            action: 'explainAnalyze',
            cellIndex: sourceCellIndex,
          });
        },
      };

      secondaryTabsRight.appendChild(exportChartBtn);
      secondaryTabsRight.appendChild(createAiMenuButton(aiMenuCallbacks));
      secondaryTabsRight.appendChild(createActionsMenuButton(actionsMenuCallbacks));

      const updateActionsVisibility = () => {
        if (currentMode === 'chart') {
          exportChartBtn.style.display = 'inline-block';
        } else {
          exportChartBtn.style.display = 'none';
        }
        refreshResultFooter();
      };

      // Switch Tab Logic

      const setSecondaryActive = (mode: string | null) => {
        applyResultViewTabStyle(noticesBtn, mode === 'notices');
        applyResultViewTabStyle(transposeBtn, mode === 'transpose');
        if (explainTabBtn) applyResultViewTabStyle(explainTabBtn, mode === 'explain');
        syncReviewTabButton();
      };

      switchTab = (mode: string) => {
        currentMode = mode;
        viewContainer.innerHTML = '';
        lazyViewGeneration += 1;
        const viewGen = lazyViewGeneration;

        if (mode === 'table' || mode === 'chart' || mode === 'analyst') {
          lastPrimaryMode = mode;
          syncPrimaryButtons();
          setSecondaryActive(null);
        } else {
          syncPrimaryButtons();
          setSecondaryActive(mode);
        }

        if (mode === 'table') {
          updateActionsVisibility();
          tableRenderer.render(buildTableRenderOptions());
          attachSlideScroll();
        } else if (mode === 'notices') {
          updateActionsVisibility();
          viewContainer.appendChild(
            renderNoticesPanel(noticeItems, {
              onAskAssistant: () => {
                context.postMessage?.({
                  type: 'sendToChat',
                  data: {
                    query: query || '',
                    notices: noticeItems,
                  },
                });
              },
            }),
          );
        } else if (mode === 'transpose') {
          updateActionsVisibility();
          const transposeEl = renderTransposeTable(
            columns,
            currentRows,
            columnTypes,
            byteaDisplayFormat,
          );
          viewContainer.appendChild(transposeEl);
        } else if (mode === 'review') {
          updateActionsVisibility();
          viewContainer.appendChild(renderReviewChangesView());
        } else if (mode === 'explain') {
          updateActionsVisibility();

          const explainWrapper = document.createElement('div');
          explainWrapper.style.cssText =
            'flex: 1; overflow: auto; height: 100%; display: flex; flex-direction: column;';
          viewContainer.appendChild(explainWrapper);

          void import('../lazy/explainTab').then(({ mountExplainTab }) => {
            if (viewGen !== lazyViewGeneration) {
              return;
            }
            void mountExplainTab(
              explainWrapper,
              json.explainPlan,
              query,
              {
                sourceCellIndex,
                performanceAnalysis: json.performanceAnalysis,
              },
              (msg) => context.postMessage?.(msg),
            );
          });
        } else if (mode === 'analyst') {
          updateActionsVisibility();
          void import('../lazy/analystTab').then(({ mountAnalystTab }) => {
            if (viewGen !== lazyViewGeneration) {
              return;
            }
            void mountAnalystTab(viewContainer, {
              columns,
              rows: currentRows,
              columnTypes,
              isStreaming: !!slideMeta?.sessionId,
              buildPivotOptimizeUserMessage,
              buildFullDatasetRerunQuery,
              exportQuery,
              query,
              postMessage: (msg) => context.postMessage?.(msg),
              sourceCellIndex,
            });
          });
        } else {
          // chart — lazy chunk loads Chart.js + controls
          updateActionsVisibility();
          const loading = document.createElement('div');
          loading.style.cssText =
            'padding:12px;color:var(--vscode-descriptionForeground);font-size:12px;';
          loading.textContent = 'Loading chart…';
          viewContainer.appendChild(loading);

          void import('../lazy/chartTab').then(({ mountChartTab }) => {
            if (viewGen !== lazyViewGeneration) {
              return;
            }
            viewContainer.innerHTML = '';
            const { chartRenderer: cr } = mountChartTab(viewContainer, {
              columns,
              rows: currentRows,
            });
            chartRenderer = cr;
            chartInstances.set(element, cr);
          });
        }
        refreshResultFooter();
      };

      showOverflowMenu = (anchorEl: HTMLElement) => {
        const existing = document.querySelector('.result-overflow-menu');
        if (existing) {
          existing.remove();
          return;
        }

        const menu = document.createElement('div');
        menu.className = 'result-overflow-menu';
        menu.style.cssText =
          'position:fixed;background:var(--vscode-menu-background);border:1px solid var(--vscode-menu-border);box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:1000;min-width:170px;border-radius:4px;padding:3px 0;';

        const addItem = (label: string, onClick: () => void) => {
          const item = document.createElement('div');
          item.textContent = label;
          item.style.cssText =
            'padding:6px 14px;cursor:pointer;color:var(--vscode-menu-foreground);font-size:12px;font-family:var(--vscode-font-family);';
          item.onmouseenter = () => {
            item.style.background = 'var(--vscode-menu-selectionBackground)';
            item.style.color = 'var(--vscode-menu-selectionForeground)';
          };
          item.onmouseleave = () => {
            item.style.background = 'transparent';
            item.style.color = 'var(--vscode-menu-foreground)';
          };
          item.onclick = (e) => {
            e.stopPropagation();
            onClick();
            menu.remove();
          };
          menu.appendChild(item);
        };

        addItem('⇄ Transpose', () => {
          if (currentMode === 'transpose') {
            switchTab(lastPrimaryMode || 'table');
          } else {
            switchTab('transpose');
          }
        });
        if (noticeItems.length > 0) {
          addItem(`Notices (${noticeItems.length})`, () => switchTab('notices'));
        }
        if (isExplainQuery) {
          addItem('Explain Plan', () => switchTab('explain'));
          if (json.explainPlan) {
            addItem('Open Plan Studio', () =>
              context.postMessage?.({
                type: 'openPlanStudio',
                plan: json.explainPlan,
                query,
                sourceCellIndex,
                performanceAnalysis: json.performanceAnalysis,
              }),
            );
          } else {
            addItem('Open Plan Studio', () =>
              context.postMessage?.({
                type: 'convertExplainToJson',
                query,
                sourceCellIndex,
                openInPlanStudio: true,
              }),
            );
          }
        }
        if (breadcrumb?.connectionName) {
          addItem('Switch connection…', () =>
            context.postMessage?.({
              type: 'showConnectionSwitcher',
              connectionId: breadcrumb.connectionId,
            }),
          );
        }
        if (breadcrumb?.database) {
          addItem('Switch database…', () =>
            context.postMessage?.({
              type: 'showDatabaseSwitcher',
              connectionId: breadcrumb.connectionId,
              currentDatabase: breadcrumb.database,
            }),
          );
        }

        document.body.appendChild(menu);
        const rect = anchorEl.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        const mw = 200;
        menu.style.left = `${Math.max(8, Math.min(rect.right - mw, window.innerWidth - mw - 8))}px`;

        setTimeout(() => {
          const close = () => {
            menu.remove();
            document.removeEventListener('click', close);
          };
          document.addEventListener('click', close);
        }, 0);
      };

      // Initial Render
      if (columns.length > 0) {
        switchTab('table');
      } else if (noticeItems.length > 0) {
        switchTab('notices');
      } else {
        const filler = document.createElement('div');
        filler.style.cssText =
          'padding:12px;color:var(--vscode-descriptionForeground);font-size:12px;';
        filler.textContent =
          (rowCount ?? 0) === 0 && (currentRows?.length ?? 0) === 0
            ? 'Query returned no data'
            : 'Unable to display this result (no column metadata). Re-run the query after updating the extension.';
        viewContainer.appendChild(filler);
      }

      // Result history tab strip — rendered above mainContainer when >1 result exists
      const tabStripEl = renderTabStrip(element, resultHistory, 0, (selectedIndex) => {
        // Re-render with a previous result's data
        const entry = getResultHistory(element)[selectedIndex];
        if (!entry) return;
        element.innerHTML = '';
        // Re-trigger renderOutputItem with the historical data by re-building the output
        // For now: show history entry as a read-only view
        const histContainer = document.createElement('div');
        histContainer.style.cssText =
          'padding:6px 12px;font-size:11px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-widget-border);background:var(--vscode-editor-background);';
        histContainer.textContent = `Showing result from ${new Date(entry.timestamp).toLocaleTimeString()} — ${(entry.rowCount ?? entry.rows?.length ?? 0).toLocaleString()} rows`;
        element.appendChild(histContainer);

        const histTableContainer = document.createElement('div');
        histTableContainer.style.cssText = 'max-height:400px;overflow:auto;';
        const histRenderer = new TableRenderer(histTableContainer, {});
        histRenderer.render({
          columns: entry.columns,
          rows: entry.rows || [],
          originalRows: entry.rows || [],
          columnTypes: entry.columnTypes,
          tableInfo: entry.tableInfo,
          byteaDisplayFormat: entry.byteaDisplayFormat ?? BYTEA_DISPLAY_DEFAULT,
        });
        element.appendChild(histTableContainer);
      });
      if (tabStripEl) element.appendChild(tabStripEl);

      const outputRoot = document.createElement('div');
      outputRoot.style.cssText = 'position:relative;display:flex;flex-direction:column;';

      outputRoot.appendChild(mainContainer);
      element.appendChild(outputRoot);

      // Transaction state: show banner and amber gutter
      ensureAmberGutterStyle();
      if (transactionState?.isActive) {
        mainContainer.classList.add('amber-gutter');

        // Only add one banner per document (remove stale ones first)
        const existingBanner = document.querySelector('[data-transaction-banner="true"]');
        if (!existingBanner) {
          const banner = createTransactionBanner({
            statementCount: transactionState.statementCount,
            onCommit: () => {
              context.postMessage?.({ type: 'commitTransaction' });
            },
            onRollback: () => {
              context.postMessage?.({ type: 'rollbackTransaction' });
            },
          });
          // Insert banner before the first output container in the element's parent
          const outputHost = element.parentElement || element;
          outputHost.insertBefore(banner, outputHost.firstChild);
        }
      } else {
        // Transaction closed — clear all transaction UI
        clearTransactionUI();
      }
    };

    const resultId: string | undefined = (json as any).resultId;
    if (resultId) {
      bindLargeResultToElement(element, resultId);
      if (largeResultsCache.has(resultId)) {
        const cachedRows = largeResultsCache.get(resultId)!;
        touchLargeResultCache(resultId, cachedRows);
        renderMain(cachedRows);
      } else {
        // Show gorgeous premium loading spinner
        const loader = document.createElement('div');
        loader.className = 'large-result-loader';
        loader.style.padding = '24px';
        loader.style.margin = '12px 0';
        loader.style.textAlign = 'center';
        loader.style.background = 'var(--vscode-editorWidget-background, #252526)';
        loader.style.border = '1px solid var(--vscode-widget-border, #444)';
        loader.style.borderRadius = '6px';
        loader.style.color = 'var(--vscode-editor-foreground)';
        loader.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
        loader.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;">
            <div class="loader-spinner" style="
              width: 28px;
              height: 28px;
              border: 3px solid rgba(0, 120, 212, 0.15);
              border-top-color: #0078d4;
              border-radius: 50%;
              animation: spin 0.8s linear infinite;
            "></div>
            <div style="font-size: 13px; font-weight: 500; letter-spacing: 0.02em;">
              Transferring ${formatRowCountForDisplay(rowCount, LARGE_RESULT_ROW_COUNT_FALLBACK)} rows via zero-copy SAB...
            </div>
          </div>
          <style>
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        `;
        element.appendChild(loader);

        registerLargeResultPending(
          resultId,
          (resolvedRows) => {
            element.innerHTML = '';
            renderMain(resolvedRows);
          },
          (error) => {
            element.innerHTML = '';
            const errorPanel = document.createElement('div');
            errorPanel.style.cssText =
              'padding:14px 16px;margin:12px 0;border:1px solid var(--vscode-widget-border,#444);border-left:3px solid var(--vscode-errorForeground,#f14c4c);border-radius:6px;background:var(--vscode-editorWidget-background,#252526);color:var(--vscode-editor-foreground);';
            errorPanel.textContent =
              `Large result transfer failed: ${error.message}. Please re-run the query.`;
            element.appendChild(errorPanel);
          },
        );
      }
    } else {
      renderMain(rows || []);
    }
}
