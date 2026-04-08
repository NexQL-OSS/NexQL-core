import type { ActivationFunction } from 'vscode-notebook-renderer';
import { Chart, registerables } from 'chart.js';
import { createButton, createTab, createBreadcrumb, BreadcrumbSegment } from './renderer/components/ui';
import { createExportButton } from './renderer/features/export';
import { TableRenderer, TableEvents } from './renderer/components/table/TableRenderer';
import { ChartRenderer } from './renderer/components/chart/ChartRenderer';
import { ChartControls } from './renderer/components/chart/ChartControls';
import { ExplainVisualizer } from './renderer/components/ExplainVisualizer';
import { createErrorPanel } from './renderer/components/ErrorPanel';
import { createActionBar } from './renderer/components/ActionBar';
import { createTransactionBanner } from './renderer/components/TransactionBanner';
import { parseBreadcrumbFromSql } from './renderer/utils/sqlParsing';

// Register Chart.js components
Chart.register(...registerables);

// Track renderer instances and their containers per output element for cleanup
const chartInstances = new WeakMap<HTMLElement, ChartRenderer>();
const tableInstances = new WeakMap<HTMLElement, TableRenderer>();
const BRAND_ACCENT = 'var(--vscode-textLink-foreground)';
const BRAND_ACCENT_MUTED = 'color-mix(in srgb, var(--vscode-textLink-foreground) 20%, transparent)';

// Inject amber-gutter CSS once
function ensureAmberGutterStyle(): void {
  const STYLE_ID = 'amber-gutter-style';
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .amber-gutter {
      border-left: 4px solid #ffb000 !important;
    }
  `;
  document.head.appendChild(style);
}

/** Remove all transaction banners and amber gutters from the document */
function clearTransactionUI(): void {
  document.querySelectorAll('[data-transaction-banner="true"]').forEach(el => el.remove());
  document.querySelectorAll('.amber-gutter').forEach(el => el.classList.remove('amber-gutter'));
}

export const activate: ActivationFunction = context => {
  return {
    renderOutputItem(data, element) {
      // Silently ignore the legacy TopBar header output (removed feature)
      if (data.mime === 'application/x-postgres-notebook-header+json') {
        element.innerHTML = '';
        return;
      }

      const json = data.json();

      if (!json) {
        element.innerText = 'No data';
        return;
      }

      const { columns = [], rows, rowCount, command, query, notices, executionTime, tableInfo, success, columnTypes, backendPid, breadcrumb } = json;

      // Transaction state from payload
      const transactionState: { isActive: boolean; statementCount: number } | undefined = json.transactionState;
      const pendingCommit: boolean = !!json.pendingCommit;

      // Data Management
      const originalRows: any[] = rows ? JSON.parse(JSON.stringify(rows)) : [];
      let currentRows: any[] = rows ? JSON.parse(JSON.stringify(rows)) : [];
      const selectedIndices = new Set<number>();
      const modifiedCells = new Map<string, { originalValue: any, newValue: any }>();
      const rowsMarkedForDeletion = new Set<number>();

      // Main Container
      const mainContainer = document.createElement('div');
      mainContainer.style.cssText = `
        font-family: var(--vscode-font-family), "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 13px;
        color: var(--vscode-editor-foreground);
        border: 1px solid var(--vscode-widget-border);
        border-top: 2px solid ${BRAND_ACCENT};
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 8px;
        box-shadow: 0 6px 14px rgba(0, 0, 0, 0.08);
      `;

      // Header
      const header = document.createElement('div');
      header.style.cssText = `
        padding: 6px 12px;
        border-bottom: 1px solid var(--vscode-widget-border);
        cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none;
        background: ${success ? 'color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, var(--vscode-editor-background))' : 'color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-sideBar-background))'};
      `;
      if (success) {
        header.style.borderLeft = '4px solid var(--vscode-testing-iconPassed)';
      }

      const chevron = document.createElement('span');
      chevron.textContent = '▼';
      chevron.style.cssText = 'font-size: 10px; transition: transform 0.2s; display: inline-block;';

      const title = document.createElement('span');
      title.textContent = command || 'QUERY';
      title.style.cssText = 'font-weight: 600; text-transform: uppercase;';

      const summary = document.createElement('span');
      summary.style.marginLeft = 'auto';
      summary.style.opacity = '0.7';
      summary.style.fontSize = '0.9em';

      let summaryText = '';
      if (rowCount !== undefined && rowCount !== null) summaryText += `${rowCount} rows`;
      if (notices?.length) summaryText += summaryText ? `, ${notices.length} messages` : `${notices.length} messages`;
      if (executionTime !== undefined) summaryText += summaryText ? `, ${executionTime.toFixed(3)}s` : `${executionTime.toFixed(3)}s`;
      if (!summaryText) summaryText = 'No results';
      summary.textContent = summaryText;

      header.appendChild(chevron);
      header.appendChild(title);
      header.appendChild(summary);

      // Pending commit badge — shown when result was produced inside an open transaction
      if (pendingCommit) {
        const pendingBadge = document.createElement('span');
        pendingBadge.textContent = 'pending commit';
        pendingBadge.style.cssText = `
          font-size: 10px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 10px;
          background: rgba(255, 176, 0, 0.25);
          color: #ffb000;
          border: 1px solid rgba(255, 176, 0, 0.5);
          margin-left: 8px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        `;
        header.appendChild(pendingBadge);
      }

      mainContainer.appendChild(header);

      // Performance Warning
      if (json.performanceAnalysis?.isDegraded || json.slowQuery) {
        const perfBanner = document.createElement('div');
        const degraded = Boolean(json.performanceAnalysis?.isDegraded);
        const warningText = degraded
          ? json.performanceAnalysis.analysis
          : 'This query crossed the slow-query threshold. Consider reviewing indexes and filters.';
        perfBanner.style.cssText = `
          padding: 6px 12px;
          background: ${degraded ? 'rgba(255, 165, 0, 0.15)' : BRAND_ACCENT_MUTED};
          border-bottom: 1px solid ${degraded ? 'rgba(255, 165, 0, 0.3)' : BRAND_ACCENT};
          color: var(--vscode-editorWarning-foreground);
          font-size: 11px;
          display: flex; align-items: center; gap: 6px;
        `;
        perfBanner.innerHTML = `<span style="font-size:14px">${degraded ? '⚠️' : '🐘'}</span> <span>${warningText}</span>`;
        mainContainer.appendChild(perfBanner);
      }

      // Breadcrumb Navigation
      if (breadcrumb) {
        // Auto-populate schema/table from SQL when not provided in the payload (12.1)
        let resolvedSchema = breadcrumb.schema;
        let resolvedTable = breadcrumb.object?.name;
        if ((!resolvedSchema || !resolvedTable) && query) {
          const parsed = parseBreadcrumbFromSql(query);
          if (!resolvedSchema && parsed.schema) {
            resolvedSchema = parsed.schema;
          }
          if (!resolvedTable && parsed.table) {
            resolvedTable = parsed.table;
          }
        }

        const segments: BreadcrumbSegment[] = [];

        if (breadcrumb.connectionName) {
          segments.push({ label: breadcrumb.connectionName, id: 'connection', type: 'connection' });
        }
        if (breadcrumb.database) {
          segments.push({ label: breadcrumb.database, id: 'database', type: 'database' });
        }
        if (resolvedSchema) {
          segments.push({
            label: resolvedSchema,
            id: 'schema',
            type: 'schema',
            onClick: () => {
              context.postMessage?.({ type: 'breadcrumbNavigate', segment: resolvedSchema, segmentType: 'schema' });
            }
          });
        }
        if (resolvedTable) {
          segments.push({
            label: resolvedTable,
            id: 'object',
            type: 'object',
            isLast: true
          });
        }

        // Mark last segment
        if (segments.length > 0) {
          segments[segments.length - 1].isLast = true;
        }

        const breadcrumbEl = createBreadcrumb(segments, {
          onConnectionDropdown: (anchorEl: HTMLElement) => {
            // Also emit breadcrumbNavigate for connection (12.2)
            context.postMessage?.({ type: 'breadcrumbNavigate', segment: breadcrumb.connectionName, segmentType: 'connection' });
            context.postMessage?.({
              type: 'showConnectionSwitcher',
              connectionId: breadcrumb.connectionId
            });
          },
          onDatabaseDropdown: (anchorEl: HTMLElement) => {
            // Also emit breadcrumbNavigate for database (12.2)
            context.postMessage?.({ type: 'breadcrumbNavigate', segment: breadcrumb.database, segmentType: 'database' });
            context.postMessage?.({
              type: 'showDatabaseSwitcher',
              connectionId: breadcrumb.connectionId,
              currentDatabase: breadcrumb.database
            });
          }
        });
        mainContainer.appendChild(breadcrumbEl);
      }

      // Content Container
      const contentContainer = document.createElement('div');
      contentContainer.style.cssText = 'display: flex; flex-direction: column; height: 100%;';
      mainContainer.appendChild(contentContainer);

      let isExpanded = true;
      header.onclick = () => {
        isExpanded = !isExpanded;
        contentContainer.style.display = isExpanded ? 'flex' : 'none';
        chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        header.style.borderBottom = isExpanded ? '1px solid var(--vscode-widget-border)' : 'none';
      };

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
          }
        });
        contentContainer.appendChild(errorPanel);
      }

      // Messages Section
      if (notices?.length) {
        const msgContainer = document.createElement('div');
        msgContainer.style.cssText = `
            padding: 8px 12px; background: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textBlockQuote-border); margin: 8px 12px 0 12px;
            font-family: var(--vscode-editor-font-family); white-space: pre-wrap; font-size: 12px;
          `;
        const msgTitle = document.createElement('div');
        msgTitle.textContent = 'Messages';
        msgTitle.style.cssText = 'font-weight: 600; margin-bottom: 4px; opacity: 0.8;';
        msgContainer.appendChild(msgTitle);

        notices.forEach((msg: string) => {
          const d = document.createElement('div');
          d.textContent = msg;
          d.style.marginBottom = '2px';
          msgContainer.appendChild(d);
        });
        contentContainer.appendChild(msgContainer);
      }

      // Build the hidden export button to reuse its existing dropdown flow
      const exportBtn = createExportButton(columns, currentRows, tableInfo, context, query);
      exportBtn.style.display = 'none';

      // Actions Bar — built with ActionBar component
      const actionsBar = createActionBar({
        onSelectAll: () => {
          // Toggle: if all rows are selected, deselect all; otherwise select all
          if (selectedIndices.size === currentRows.length && currentRows.length > 0) {
            selectedIndices.clear();
          } else {
            currentRows.forEach((_: any, i: number) => selectedIndices.add(i));
          }
          tableRenderer.updateSelection(selectedIndices);
          updateActionsVisibility();
        },
        onCopy: () => {
          // Copy selected rows (or all rows if none selected) to clipboard as CSV
          const rowsToCopy = selectedIndices.size > 0
            ? Array.from(selectedIndices).map(i => currentRows[i])
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
            ...rowsToCopy.map((r: any) => columns.map((c: string) => escapeCSV(r[c])).join(','))
          ].join('\n');
          navigator.clipboard?.writeText(csv);
        },
        onImport: () => {
          context.postMessage?.({ type: 'import_request', tableInfo, columns });
        },
        onExport: (anchorBtn: HTMLElement) => {
          // Remove existing dropdown if open (toggle)
          const existing = document.querySelector('.export-dropdown');
          if (existing) { existing.remove(); return; }

          const stringifyValue = (val: any): string => {
            if (val === null || val === undefined) return '';
            if (typeof val === 'object') return JSON.stringify(val);
            return String(val);
          };
          const getCSV = () => {
            const header = columns.map((c: string) => `"${c.replace(/"/g, '""')}"`).join(',');
            const body = currentRows.map((row: any) => columns.map((col: string) => {
              const str = stringifyValue(row[col]);
              return (str.includes(',') || str.includes('"') || str.includes('\n'))
                ? `"${str.replace(/"/g, '""')}"` : str;
            }).join(',')).join('\n');
            return `${header}\n${body}`;
          };
          const downloadFile = (content: string, filename: string, type: string) => {
            const blob = new Blob([content], { type });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
          };

          const menu = document.createElement('div');
          menu.className = 'export-dropdown';
          menu.style.cssText = 'position:absolute;top:100%;left:0;background:var(--vscode-menu-background);border:1px solid var(--vscode-menu-border);box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:100;min-width:160px;border-radius:3px;padding:4px 0;';

          const addItem = (label: string, onClick: () => void) => {
            const item = document.createElement('div');
            item.textContent = label;
            item.style.cssText = 'padding:6px 12px;cursor:pointer;color:var(--vscode-menu-foreground);font-size:12px;';
            item.onmouseenter = () => { item.style.background = 'var(--vscode-menu-selectionBackground)'; item.style.color = 'var(--vscode-menu-selectionForeground)'; };
            item.onmouseleave = () => { item.style.background = 'transparent'; item.style.color = 'var(--vscode-menu-foreground)'; };
            item.onclick = (e) => { e.stopPropagation(); onClick(); menu.remove(); };
            menu.appendChild(item);
          };

          addItem('Save as CSV', () => downloadFile(getCSV(), `export_${Date.now()}.csv`, 'text/csv'));
          addItem('Save as JSON', () => downloadFile(JSON.stringify(currentRows, null, 2), `export_${Date.now()}.json`, 'application/json'));
          addItem('Save as Markdown', () => {
            const header = `| ${columns.join(' | ')} |`;
            const sep = `| ${columns.map(() => '---').join(' | ')} |`;
            const body = currentRows.map((row: any) => `| ${columns.map((col: string) => {
              const v = row[col]; if (v === null || v === undefined) return 'NULL';
              return (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
            }).join(' | ')} |`).join('\n');
            downloadFile(`${header}\n${sep}\n${body}`, `export_${Date.now()}.md`, 'text/markdown');
          });
          addItem('Copy to Clipboard', () => {
            navigator.clipboard?.writeText(getCSV()).then(() => {
              anchorBtn.textContent = 'Copied!';
              setTimeout(() => { anchorBtn.textContent = '↓ Export'; }, 2000);
            });
          });
          if (tableInfo) {
            addItem('Copy SQL INSERT', () => {
              const tableName = `"${tableInfo.schema}"."${tableInfo.table}"`;
              const cols = columns.map((c: string) => `"${c}"`).join(', ');
              const inserts = currentRows.map((row: any) => {
                const vals = columns.map((col: string) => {
                  const v = row[col];
                  if (v === null || v === undefined) return 'NULL';
                  if (typeof v === 'number') return v;
                  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
                  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
                  return `'${s.replace(/'/g, "''")}'`;
                }).join(', ');
                return `INSERT INTO ${tableName} (${cols}) VALUES (${vals});`;
              }).join('\n');
              navigator.clipboard?.writeText(inserts);
            });
          }

          anchorBtn.appendChild(menu);
          setTimeout(() => {
            const close = () => { menu.remove(); document.removeEventListener('click', close); };
            document.addEventListener('click', close);
          }, 0);
        },
        onSendToChat: () => {
          const resultsJson = JSON.stringify({ columns, rows: currentRows });
          context.postMessage?.({
            type: 'sendToChat',
            data: {
              query: json.query || '',
              results: resultsJson,
              message: 'I ran this query and got these results. Please help me understand them.'
            }
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
          const csvRows = currentRows.map((r: any) => columns.map((c: string) => escapeCSV(r[c])).join(','));
          const dataCsv = [csvHeader, ...csvRows].join('\n');
          context.postMessage?.({
            type: 'analyzeData',
            data: dataCsv,
            query: json.query || '',
            rowCount: currentRows.length
          });
        },
        onOptimize: () => {
          context.postMessage?.({ type: 'optimizeQuery', query: json.query, executionTime: json.executionTime });
        }
      });

      // Capture left/right groups before appending extra elements
      const leftActions = actionsBar.firstElementChild as HTMLElement;
      const rightActions = actionsBar.children[2] as HTMLElement; // index 2: right group (0=left, 1=divider, 2=right)

      // Delete button — appended to leftActions, shown when rows are selected
      const deleteBtn = createButton('🗑️ Delete Selected', true);
      deleteBtn.style.cssText = 'display: none; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-left: 8px;';
      leftActions.appendChild(deleteBtn);

      // Detect if this is an EXPLAIN query (either JSON or text format)
      const isExplainQuery = json.explainPlan ||
        (query && /^\s*EXPLAIN/i.test(query)) ||
        command === 'EXPLAIN' ||
        (columns.length === 1 && columns[0] === 'QUERY PLAN');

      if (isExplainQuery) {
        const explainPlanBtn = createButton('🧭 View Plan', true);
        explainPlanBtn.title = json.explainPlan
          ? 'Open EXPLAIN ANALYZE plan view'
          : 'Convert to JSON format and open visual plan view';

        explainPlanBtn.onclick = () => {
          if (json.explainPlan) {
            if (explainTab) {
              switchTab('explain');
            } else {
              context.postMessage?.({
                type: 'showExplainPlan',
                plan: json.explainPlan,
                query: query || ''
              });
            }
          } else {
            console.log('Converting EXPLAIN to JSON, query:', query);
            if (!query) {
              alert('Cannot convert EXPLAIN plan: query not available');
              return;
            }
            context.postMessage?.({
              type: 'convertExplainToJson',
              query: query
            });
          }
        };
        rightActions.appendChild(explainPlanBtn);
      }

      if (!json.error) {
        contentContainer.appendChild(actionsBar);
      }

      // Save Changes Logic
      const saveBtn = createButton('Save Changes', true);
      saveBtn.style.marginRight = '8px';

      const updateSaveButtonVisibility = () => {
        // Show save button if there are edits OR deletions
        const hasChanges = modifiedCells.size > 0 || rowsMarkedForDeletion.size > 0;

        if (hasChanges) {
          if (!rightActions.contains(saveBtn)) rightActions.prepend(saveBtn);

          // Build button text with counts
          const parts = [];
          if (modifiedCells.size > 0) parts.push(`${modifiedCells.size} edit${modifiedCells.size !== 1 ? 's' : ''}`);
          if (rowsMarkedForDeletion.size > 0) parts.push(`${rowsMarkedForDeletion.size} deletion${rowsMarkedForDeletion.size !== 1 ? 's' : ''}`);
          saveBtn.innerText = `💾 Save Changes (${parts.join(', ')})`;
        } else {
          if (rightActions.contains(saveBtn)) rightActions.removeChild(saveBtn);
        }
      };

      saveBtn.onclick = () => {
        console.log('Renderer: Save button clicked');
        console.log('Renderer: Modified cells size:', modifiedCells.size);
        console.log('Renderer: Rows marked for deletion:', rowsMarkedForDeletion.size);

        const updates: any[] = [];
        modifiedCells.forEach((diff, key) => {
          const [rowIndexStr, colName] = key.split('-');
          const rowIndex = parseInt(rowIndexStr);

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
              originalValue: diff.originalValue
            });
          } else {
            console.warn('Renderer: No primary keys found in tableInfo', tableInfo);
          }
        });

        // Build deletions array
        const deletions: any[] = [];
        rowsMarkedForDeletion.forEach((rowIndex) => {
          if (tableInfo?.primaryKeys) {
            const pkValues: Record<string, any> = {};
            tableInfo.primaryKeys.forEach((pk: string) => {
              pkValues[pk] = originalRows[rowIndex][pk];
            });
            deletions.push({
              keys: pkValues,
              row: originalRows[rowIndex]  // Include full row for reference
            });
          }
        });

        console.log('Renderer: Updates prepared:', updates);
        console.log('Renderer: Deletions prepared:', deletions);

        if (updates.length > 0 || deletions.length > 0) {
          console.log('Renderer: Posting saveChanges message');
          context.postMessage?.({
            type: 'saveChanges',
            updates,
            deletions,
            tableInfo
          });
        } else {
          const reason = !tableInfo?.primaryKeys ? 'No primary keys found for this table.' : 'Unknown error preparing updates.';
          console.warn(`Renderer: Save failed. ${reason}`);

          // Inform user nicely
          context.postMessage?.({
            type: 'showErrorMessage',
            message: `Cannot save changes: ${reason} (Primary keys are required to identify rows)`
          });
        }
      };

      // Listen for messages from extension (e.g., saveSuccess)
      context.onDidReceiveMessage?.((message: any) => {
        if (message.type === 'saveSuccess') {
          console.log('Renderer: Received saveSuccess, clearing modified cells and removing deleted rows');

          // Remove deleted rows from arrays (in reverse order to maintain indices)
          const deletedIndices = Array.from(rowsMarkedForDeletion).sort((a, b) => b - a);
          deletedIndices.forEach(index => {
            currentRows.splice(index, 1);
            originalRows.splice(index, 1);
          });

          // Update originalRows with edited values
          modifiedCells.forEach((diff, key) => {
            const [rowIndexStr, colName] = key.split('-');
            const rowIndex = parseInt(rowIndexStr);
            if (rowIndex < originalRows.length) {  // Check bounds after deletions
              originalRows[rowIndex][colName] = diff.newValue;
            }
          });

          // Clear all pending changes
          modifiedCells.clear();
          rowsMarkedForDeletion.clear();

          // Update save button visibility
          updateSaveButtonVisibility();

          // Re-render table to remove highlights and deleted rows
          if (tableRenderer) {
            tableRenderer.render({
              columns,
              rows: currentRows,
              originalRows,
              columnTypes,
              tableInfo,
              initialSelectedIndices: selectedIndices,
              modifiedCells
            });
          }
        }
      });

      // Tabs
      const tabs = document.createElement('div');
      tabs.style.cssText = 'display: flex; padding: 0 12px; margin-top: 8px; border-bottom: 1px solid var(--vscode-panel-border);';

      const tableTab = createTab('Table', 'table', true, () => switchTab('table'));
      const chartTab = createTab('Chart', 'chart', false, () => switchTab('chart'));

      let explainTab: HTMLElement | null = null;
      if (json.explainPlan) {
        explainTab = createTab('Explain Plan', 'explain', false, () => switchTab('explain'));
      }

      tabs.appendChild(tableTab);
      tabs.appendChild(chartTab);
      if (explainTab) tabs.appendChild(explainTab);
      if (!json.error) {
        contentContainer.appendChild(tabs);
      }


      // Views Containers
      const viewContainer = document.createElement('div');
      viewContainer.style.cssText = 'flex: 1; overflow: hidden; display: flex; flex-direction: column; position: relative; max-height: 500px;';
      if (!json.error) {
        contentContainer.appendChild(viewContainer);
      }

      // TABLE RENDERER
      const tableRenderer = new TableRenderer(viewContainer, {
        onSelectionChange: (indices) => {
          console.log('[renderer_v2] onSelectionChange called, indices:', Array.from(indices));
          // Sync local state with TableRenderer's state
          selectedIndices.clear();
          indices.forEach(i => selectedIndices.add(i));
          console.log('[renderer_v2] local selectedIndices after sync:', selectedIndices.size);

          updateActionsVisibility();
        },
        onDataChange: (rowIndex, col, newVal, originalVal) => {
          updateSaveButtonVisibility();
          updateActionsVisibility();
        }
      });

      // Store for cleanup on disposal
      tableInstances.set(element, tableRenderer);

      // CHART RENDERER
      const chartCanvas = document.createElement('canvas');
      const chartRenderer = new ChartRenderer(chartCanvas);

      // Store for cleanup on disposal
      chartInstances.set(element, chartRenderer);

      const exportChartBtn = createButton('📷 Export Chart', true);
      exportChartBtn.style.display = 'none'; // Hidden by default
      exportChartBtn.onclick = () => {
        const dataUrl = chartRenderer.exportImage('png');
        if (dataUrl) {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = `chart-${new Date().toISOString()}.png`;
          a.click();
        }
      };
      leftActions.appendChild(exportChartBtn);

      const updateActionsVisibility = () => {
        if (currentMode === 'chart') {
          exportChartBtn.style.display = 'inline-block';
        } else {
          exportChartBtn.style.display = 'none';
        }

        // Update Select All Button Text and delete button
        if (currentMode === 'table') {
          if (selectedIndices.size > 0) {
            deleteBtn.style.display = 'inline-block';
            deleteBtn.innerText = `🗑️ Delete (${selectedIndices.size})`;
            if (!tableInfo?.primaryKeys) {
              deleteBtn.title = 'Warning: No Primary Keys detected. Deletion may fail.';
              deleteBtn.style.opacity = '0.7';
            } else {
              deleteBtn.title = 'Delete selected rows';
              deleteBtn.style.opacity = '1';
            }
          } else {
            deleteBtn.style.display = 'none';
          }
        }
      };

      deleteBtn.onclick = () => {
        console.log('[renderer_v2] Delete button clicked!');
        const selectedCount = selectedIndices.size;
        console.log('[renderer_v2] selectedCount:', selectedCount);
        if (selectedCount === 0) return;

        // Mark selected rows for deletion
        selectedIndices.forEach(index => {
          rowsMarkedForDeletion.add(index);
        });

        console.log('[renderer_v2] Rows marked for deletion:', Array.from(rowsMarkedForDeletion));

        // Clear selection
        selectedIndices.clear();

        // Update save button visibility
        updateSaveButtonVisibility();

        // Re-render table to show strikethrough on marked rows
        if (tableRenderer) {
          tableRenderer.render({
            columns,
            rows: currentRows,
            originalRows,
            columnTypes,
            tableInfo,
            initialSelectedIndices: selectedIndices,
            modifiedCells,
            rowsMarkedForDeletion  // Pass to renderer for styling
          });
        }

        // Update actions visibility
        updateActionsVisibility();
      };

      // Switch Tab Logic
      let currentMode = 'table';
      const switchTab = (mode: string) => {
        currentMode = mode;
        viewContainer.innerHTML = '';

        if (mode === 'table') {
          tableTab.style.borderBottom = '2px solid var(--vscode-focusBorder)';
          tableTab.style.opacity = '1';
          // Reset chart tab style
          chartTab.style.borderBottom = '2px solid transparent';
          chartTab.style.opacity = '0.6';
          // Show actions bar if needed
          updateActionsVisibility();

          tableRenderer.render({
            columns,
            rows: currentRows,
            originalRows,
            columnTypes,
            tableInfo,
            initialSelectedIndices: selectedIndices,
            modifiedCells
          });
        } else if (mode === 'explain') {
          // Explain Mode
          if (tableTab) { tableTab.style.borderBottom = '2px solid transparent'; tableTab.style.opacity = '0.6'; }
          if (chartTab) { chartTab.style.borderBottom = '2px solid transparent'; chartTab.style.opacity = '0.6'; }
          if (explainTab) { explainTab.style.borderBottom = '2px solid var(--vscode-focusBorder)'; explainTab.style.opacity = '1'; }

          updateActionsVisibility(); // Should probably hide most actions

          const explainWrapper = document.createElement('div');
          explainWrapper.style.cssText = 'flex: 1; overflow: auto; height: 100%; display: flex; flex-direction: column;';
          viewContainer.appendChild(explainWrapper);

          if (json.explainPlan) {
            try {
              new ExplainVisualizer(explainWrapper, json.explainPlan).render();
            } catch (e) {
              explainWrapper.textContent = 'Failed to render explain plan: ' + String(e);
            }
          } else {
            explainWrapper.textContent = 'No explain plan data available. Run EXPLAIN (ANALYZE, FORMAT JSON) to get a visual plan.';
          }

        } else {
          // Hide table specific styles
          tableTab.style.borderBottom = '2px solid transparent';
          tableTab.style.opacity = '0.6';
          if (explainTab) { explainTab.style.borderBottom = '2px solid transparent'; explainTab.style.opacity = '0.6'; }

          chartTab.style.borderBottom = '2px solid var(--vscode-focusBorder)';
          chartTab.style.opacity = '1';
          updateActionsVisibility();

          const chartWrapper = document.createElement('div');
          chartWrapper.style.cssText = 'flex: 1; display: flex; flex-direction: column; height: 100%; overflow: hidden;';

          const controlsContainer = document.createElement('div');
          controlsContainer.style.cssText = 'width: 140px; min-width: 140px; max-width: 140px; display: flex; flex-direction: column;';

          const canvasContainer = document.createElement('div');
          canvasContainer.style.cssText = 'flex: 1; padding: 8px; position: relative; min-height: 0;';
          canvasContainer.appendChild(chartCanvas);

          const innerContainer = document.createElement('div');
          innerContainer.style.cssText = 'display: flex; flex: 1; overflow: hidden; height: 100%;';
          innerContainer.appendChild(canvasContainer);
          innerContainer.appendChild(controlsContainer);
          chartWrapper.appendChild(innerContainer);

          viewContainer.appendChild(chartWrapper);

          new ChartControls(controlsContainer, {
            columns,
            rows: currentRows,
            onConfigChange: (config) => {
              chartRenderer.render(currentRows, config);
            }
          });
        }
      };

      // Initial Render
      if (columns.length > 0) {
        switchTab('table');
      } else {
        if (rowCount === 0) mainContainer.innerHTML += '<div style="padding:12px">Query returned no data</div>';
      }

      element.appendChild(mainContainer);

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
            }
          });
          // Insert banner before the first output container in the element's parent
          const outputHost = element.parentElement || element;
          outputHost.insertBefore(banner, outputHost.firstChild);
        }
      } else {
        // Transaction closed — clear all transaction UI
        clearTransactionUI();
      }
    }
  };
};
