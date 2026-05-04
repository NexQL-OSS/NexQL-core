import {
  RESULT_TOOLBAR_ICON_CLASS,
  RESULT_TOOLBAR_LABEL_CLASS,
  applyResultViewTabStyle,
  resultToolbarSvg,
} from '../../../renderer/components/ResultToolbarUi';
import type { TableRenderer } from '../../../renderer/components/table/TableRenderer';
import type { TableRenderOptions } from '../../../common/types';
import {
  buildDeletionReviewRows,
  buildEditDiffRows,
  formatDiffValue,
} from './editHelpers';

export interface ReviewChangesDeps {
  columns: string[];
  originalRows: unknown[];
  tableInfo: { primaryKeys?: string[] } | undefined;
  modifiedCells: Map<string, { originalValue: unknown; newValue: unknown }>;
  rowsMarkedForDeletion: Set<number>;
  tableRenderer: TableRenderer;
  buildTableRenderOptions: () => TableRenderOptions;
  syncPendingChangesUi: () => void;
  switchTab: (mode: string) => void;
}

export function createRenderReviewChangesView(deps: ReviewChangesDeps): () => HTMLElement {
  return () => {
    const diffRows = buildEditDiffRows(
      deps.modifiedCells,
      deps.originalRows,
      deps.tableInfo,
    );
    const deletionRows = buildDeletionReviewRows(
      deps.rowsMarkedForDeletion,
      deps.originalRows,
      deps.tableInfo,
    );
    const pendingCount = deps.modifiedCells.size + deps.rowsMarkedForDeletion.size;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'height:100%;overflow:auto;display:flex;flex-direction:column;';

    const header = document.createElement('div');
    header.style.cssText =
      'padding:10px 12px;border-bottom:1px solid var(--vscode-widget-border);display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:10px;';

    const headerText = document.createElement('div');
    headerText.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;';

    const titleEl = document.createElement('div');
    titleEl.textContent = 'Review Changes';
    titleEl.style.cssText = 'font-size:13px;font-weight:700;';

    const subtitleEl = document.createElement('div');
    const editedRowCount = new Set(diffRows.map((r) => r.rowIndex)).size;
    const subParts: string[] = [];
    if (diffRows.length > 0) {
      subParts.push(
        `${editedRowCount} row${editedRowCount !== 1 ? 's' : ''}, ${diffRows.length} edited cell${diffRows.length !== 1 ? 's' : ''}`,
      );
    }
    if (deletionRows.length > 0) {
      subParts.push(
        `${deletionRows.length} row${deletionRows.length !== 1 ? 's' : ''} marked for deletion`,
      );
    }
    subtitleEl.textContent = subParts.length > 0 ? subParts.join(' · ') : 'No pending changes';
    subtitleEl.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);';

    headerText.appendChild(titleEl);
    headerText.appendChild(subtitleEl);
    header.appendChild(headerText);

    if (pendingCount > 0) {
      const revertReviewBtn = document.createElement('button');
      revertReviewBtn.type = 'button';
      revertReviewBtn.textContent = 'Revert all';
      revertReviewBtn.title = 'Discard all unstaged edits and staged deletions';
      revertReviewBtn.style.cssText = `
            flex-shrink:0;padding:4px 12px;font-size:11px;font-family:var(--vscode-font-family);
            cursor:pointer;border-radius:3px;font-weight:600;
            background:color-mix(in srgb,#22c55e 14%,transparent);
            color:#22c55e;
            border:1px solid color-mix(in srgb,#22c55e 38%,transparent);
          `;
      revertReviewBtn.onmouseover = () => {
        revertReviewBtn.style.background = 'color-mix(in srgb,#22c55e 22%,transparent)';
      };
      revertReviewBtn.onmouseout = () => {
        revertReviewBtn.style.background = 'color-mix(in srgb,#22c55e 14%,transparent)';
      };
      revertReviewBtn.onclick = () => {
        deps.tableRenderer.revertAllPendingChanges();
        deps.syncPendingChangesUi();
        deps.switchTab('table');
      };
      header.appendChild(revertReviewBtn);
    }

    wrap.appendChild(header);

    if (diffRows.length === 0 && deletionRows.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText =
        'padding:20px 16px;color:var(--vscode-descriptionForeground);font-size:12px;';
      empty.textContent = 'No pending edits or deletions to review.';
      wrap.appendChild(empty);
      return wrap;
    }

    const appendEditTable = () => {
      if (diffRows.length === 0) return;

      const sectionLabel = document.createElement('div');
      sectionLabel.textContent = 'Cell edits';
      sectionLabel.style.cssText =
        'padding:8px 12px 4px;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.04em;';
      wrap.appendChild(sectionLabel);

      const table = document.createElement('table');
      table.style.cssText =
        'width:100%;border-collapse:separate;border-spacing:0;font-size:12px;line-height:1.45;';

      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      ['Row', 'Column', 'Old Value', 'New Value'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        th.style.cssText =
          'position:sticky;top:0;z-index:1;text-align:left;padding:8px 10px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-widget-border);font-weight:600;';
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      diffRows.forEach((row, idx) => {
        const tr = document.createElement('tr');
        const stripe = idx % 2 === 0 ? 'transparent' : 'var(--vscode-keybindingTable-rowsBackground)';
        tr.style.background = stripe;

        const rowTd = document.createElement('td');
        rowTd.textContent = row.rowLabel;
        rowTd.style.cssText =
          'padding:7px 10px;border-bottom:1px solid var(--vscode-widget-border);font-family:var(--vscode-editor-font-family),monospace;white-space:nowrap;';

        const colTd = document.createElement('td');
        colTd.textContent = row.colName;
        colTd.style.cssText =
          'padding:7px 10px;border-bottom:1px solid var(--vscode-widget-border);font-family:var(--vscode-editor-font-family),monospace;';

        const oldTd = document.createElement('td');
        oldTd.textContent = row.oldValue;
        oldTd.style.cssText =
          'padding:7px 10px;border-bottom:1px solid var(--vscode-widget-border);font-family:var(--vscode-editor-font-family),monospace;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        oldTd.title = row.oldValue;

        const newTd = document.createElement('td');
        newTd.textContent = row.newValue;
        newTd.style.cssText =
          'padding:7px 10px;border-bottom:1px solid var(--vscode-widget-border);font-family:var(--vscode-editor-font-family),monospace;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:color-mix(in srgb, #f59e0b 12%, transparent);';
        newTd.title = row.newValue;

        tr.appendChild(rowTd);
        tr.appendChild(colTd);
        tr.appendChild(oldTd);
        tr.appendChild(newTd);
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
    };

    const appendDeletionCards = () => {
      if (deletionRows.length === 0) return;

      const sectionLabel = document.createElement('div');
      sectionLabel.textContent = 'Rows to delete';
      sectionLabel.style.cssText =
        'padding:12px 12px 4px;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.04em;';
      wrap.appendChild(sectionLabel);

      const divider = document.createElement('div');
      divider.style.cssText =
        'height:1px;margin:2px 12px 12px;background:color-mix(in srgb,var(--vscode-widget-border) 85%,transparent);';
      wrap.appendChild(divider);

      const cardsWrap = document.createElement('div');
      cardsWrap.style.cssText =
        'display:flex;flex-direction:column;gap:12px;padding:0 12px 16px;';

      deletionRows.forEach(({ rowIndex, rowLabel }) => {
        const rowData = deps.originalRows[rowIndex] as Record<string, unknown> | undefined;

        const card = document.createElement('article');
        card.style.cssText = `
              border:1px solid color-mix(in srgb, var(--vscode-widget-border) 70%, transparent);
              border-radius:8px;
              overflow:hidden;
              background:color-mix(in srgb, #dc2626 7%, var(--vscode-editor-background));
              box-shadow:0 1px 2px rgba(0,0,0,0.06);
            `;

        const head = document.createElement('header');
        head.style.cssText = `
              display:flex;
              align-items:center;
              justify-content:space-between;
              gap:12px;
              padding:8px 12px;
              border-bottom:1px solid color-mix(in srgb, var(--vscode-widget-border) 55%, transparent);
              background:color-mix(in srgb, #dc2626 11%, transparent);
            `;

        const title = document.createElement('div');
        title.style.cssText =
          'font-size:12px;font-weight:700;font-family:var(--vscode-editor-font-family),monospace;color:var(--vscode-editor-foreground);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        title.textContent = `Row ${rowLabel}`;

        const undoBtn = document.createElement('button');
        undoBtn.type = 'button';
        undoBtn.textContent = 'Undo';
        undoBtn.title = 'Remove this row from the deletion queue';
        undoBtn.style.cssText = `
              flex-shrink:0;padding:3px 10px;font-size:11px;font-family:var(--vscode-font-family);
              cursor:pointer;border-radius:4px;font-weight:600;
              background:transparent;color:var(--vscode-textLink-foreground);
              border:1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 38%, transparent);
            `;
        undoBtn.onmouseover = () => {
          undoBtn.style.background =
            'color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 55%, transparent)';
        };
        undoBtn.onmouseout = () => {
          undoBtn.style.background = 'transparent';
        };
        undoBtn.onclick = () => {
          deps.rowsMarkedForDeletion.delete(rowIndex);
          deps.syncPendingChangesUi();
          deps.tableRenderer.render(deps.buildTableRenderOptions());
          deps.switchTab('review');
        };

        head.appendChild(title);
        head.appendChild(undoBtn);

        const body = document.createElement('div');
        body.style.cssText =
          'padding:10px 12px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-start;';

        deps.columns.forEach((colName: string) => {
          const chip = document.createElement('span');
          chip.style.cssText =
            'display:inline-flex;align-items:baseline;gap:4px;font-size:11px;font-family:var(--vscode-editor-font-family),monospace;line-height:1.4;max-width:100%;word-break:break-word;';
          const k = document.createElement('span');
          k.style.cssText = 'color:var(--vscode-descriptionForeground);font-weight:600;flex-shrink:0;';
          k.textContent = `${colName}=`;
          const v = document.createElement('span');
          v.style.color = 'var(--vscode-editor-foreground)';
          v.textContent = formatDiffValue(rowData?.[colName]);
          chip.appendChild(k);
          chip.appendChild(v);
          body.appendChild(chip);
        });

        const foot = document.createElement('footer');
        foot.style.cssText =
          'padding:7px 12px 10px;font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;border-top:1px dashed color-mix(in srgb, var(--vscode-widget-border) 55%, transparent);';
        foot.textContent = '→ Will be removed when you commit.';

        card.appendChild(head);
        card.appendChild(body);
        card.appendChild(foot);
        cardsWrap.appendChild(card);
      });

      wrap.appendChild(cardsWrap);
    };

    appendEditTable();
    appendDeletionCards();
    return wrap;
  };
}

/** Sync Review tab button label, badge, and styles */
export function syncReviewTabButtonUi(
  reviewTabBtn: HTMLButtonElement | null,
  deps: {
    modifiedCells: Map<string, { originalValue: unknown; newValue: unknown }>;
    rowsMarkedForDeletion: Set<number>;
    currentMode: string;
  },
): void {
  const REVIEW_AMBER = '#f59e0b';
  if (!reviewTabBtn) return;
  const pending = deps.modifiedCells.size + deps.rowsMarkedForDeletion.size;
  const isActive = deps.currentMode === 'review';

  reviewTabBtn.replaceChildren();
  const ic = document.createElement('span');
  ic.className = RESULT_TOOLBAR_ICON_CLASS;
  ic.innerHTML = resultToolbarSvg('review');
  const title = document.createElement('span');
  title.className = RESULT_TOOLBAR_LABEL_CLASS;
  title.textContent = 'Review Changes';
  reviewTabBtn.appendChild(ic);
  reviewTabBtn.appendChild(title);

  if (pending > 0) {
    const badge = document.createElement('span');
    badge.textContent = String(pending);
    badge.title = `${pending} pending change(s)`;
    badge.style.cssText = `
            display:inline-block;
            margin-left:6px;
            min-width:18px;
            text-align:center;
            padding:0 6px;
            border-radius:999px;
            font-size:10px;
            font-weight:700;
            line-height:16px;
            vertical-align:middle;
            background:color-mix(in srgb, ${REVIEW_AMBER} 26%, transparent);
            color:${REVIEW_AMBER};
            border:1px solid color-mix(in srgb, ${REVIEW_AMBER} 48%, transparent);
          `;
    reviewTabBtn.appendChild(badge);
  }

  applyResultViewTabStyle(reviewTabBtn, isActive);
  if (pending > 0) {
    reviewTabBtn.style.background = isActive
      ? `color-mix(in srgb, ${REVIEW_AMBER} 18%, color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 88%, transparent))`
      : `color-mix(in srgb, ${REVIEW_AMBER} 14%, transparent)`;
    reviewTabBtn.style.borderColor = `color-mix(in srgb, ${REVIEW_AMBER} 42%, var(--vscode-widget-border))`;
  }
  if (!isActive) {
    reviewTabBtn.style.color = 'var(--vscode-editor-foreground)';
  }
}
