import { prefersReducedMotion } from '../../ui/theme/motion';
import { isProBuild } from '../../common/buildTier';
import { EXPORT_MENU_Z_INDEX, positionExportDropdown } from '../features/export';
import {
  RESULT_TOOLBAR_ICON_CLASS,
  RESULT_TOOLBAR_SPARKLE_PX,
  applyResultRowToolStyle,
  attachResultRowToolInteractions,
  fillRowToolButton,
  fillToolbarButtonContent,
  type ResultToolbarGlyph,
  resultToolbarSvg,
} from './ResultToolbarUi';

export interface ActionBarOptions {
  onSelectAll: () => void;
  onCopy: () => void;
  onImport: () => void;
  onExport: (exportBtn: HTMLElement) => void;
  onSendToChat: () => void;
  onAnalyzeWithAI: () => void;
  onOptimize: () => void;
}

export interface AiMenuOptions {
  onSendToChat: () => void;
  onAnalyzeWithAI: () => void;
  onOptimize: () => void;
}

export interface ActionsMenuOptions {
  onSendToChat: () => void;
  onSaveQuery: () => void;
  onRunFullDataset: () => void;
  onExplainAnalyze: () => void;
}

export interface ActionBarParts {
  container: HTMLElement;
  primaryTools: HTMLElement;
  rightGroup: HTMLElement;
}

const AI_MENU_STYLE_ID = 'pg-ai-menu-btn-styles';

const ROW_TOOL_COPY_FEEDBACK_MS = 2500;

function ensureAiMenuButtonStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(AI_MENU_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = AI_MENU_STYLE_ID;
  style.textContent = `
    @keyframes pg-ai-ring-shift {
      0%, 100% {
        box-shadow:
          0 0 0 1.5px color-mix(in srgb, var(--vscode-terminal-ansiCyan, #3b82f6) 55%, transparent),
          0 1px 0 color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
      }
      33% {
        box-shadow:
          0 0 0 1.5px color-mix(in srgb, var(--vscode-terminal-ansiYellow, #f59e0b) 60%, transparent),
          0 2px 10px color-mix(in srgb, var(--vscode-terminal-ansiMagenta, #ef4444) 22%, transparent);
      }
      66% {
        box-shadow:
          0 0 0 1.5px color-mix(in srgb, var(--vscode-textLink-foreground, #6366f1) 50%, transparent),
          0 1px 0 color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
      }
    }
    .pg-ai-menu-btn-wrap {
      display: inline-flex;
      align-items: center;
      position: relative;
      border: 1px solid color-mix(in srgb, var(--vscode-widget-border, var(--vscode-editor-foreground, #ccc)) 65%, transparent);
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 88%, transparent);
      transition: border-color 0.14s ease, background 0.14s ease, box-shadow 0.14s ease;
      box-sizing: border-box;
      padding: 1px;
    }
    .pg-ai-menu-btn-wrap:hover {
      background: color-mix(in srgb, var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.15)) 60%, transparent) !important;
      border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #007fd4)) !important;
    }
    .pg-ai-menu-btn--animated button {
      font-weight: 600;
      letter-spacing: 0.03em;
      background: transparent !important;
      box-shadow: none !important;
    }
    .pg-ai-menu-btn--animated {
      animation: pg-ai-ring-shift 14s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}

export type RowToolsOptions = Pick<ActionBarOptions, 'onSelectAll' | 'onCopy' | 'onImport' | 'onExport'> & {
  /** True when every row in the current result is selected. */
  allRowsSelected?: boolean;
};

function flashCopyRowToolSuccess(btn: HTMLButtonElement): void {
  type Btn = HTMLButtonElement & { _pgCopyFlashT?: ReturnType<typeof setTimeout> };
  const b = btn as Btn;
  if (b._pgCopyFlashT) clearTimeout(b._pgCopyFlashT);
  btn.dataset.pgRowToolFlash = 'copy';
  fillToolbarButtonContent(btn, 'copySuccess', 'Copied');
  btn.style.color = 'var(--vscode-testing-iconPassed, #3fb950)';
  btn.style.borderColor =
    'color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 45%, var(--vscode-widget-border))';
  b._pgCopyFlashT = setTimeout(() => {
    delete btn.dataset.pgRowToolFlash;
    b._pgCopyFlashT = undefined;
    fillToolbarButtonContent(btn, 'copy', 'Copy');
    applyResultRowToolStyle(btn);
  }, ROW_TOOL_COPY_FEEDBACK_MS);
}

/** All / Copy / Import / Export — used in the results footer (left). */
export function createRowTools(options: RowToolsOptions): HTMLElement {
  const primaryTools = document.createElement('div');
  primaryTools.style.cssText =
    'display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;';

  const selBtn = document.createElement('button');
  selBtn.type = 'button';
  const allOn = Boolean(options.allRowsSelected);
  fillRowToolButton(selBtn, allOn ? 'checkboxChecked' : 'checkboxEmpty', 'All');
  selBtn.title = 'Select all rows or clear selection';
  selBtn.onclick = () => options.onSelectAll();
  primaryTools.appendChild(selBtn);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  fillRowToolButton(copyBtn, 'copy', 'Copy');
  copyBtn.title = 'Copy results as CSV';
  copyBtn.onclick = () => {
    options.onCopy();
    flashCopyRowToolSuccess(copyBtn);
  };
  primaryTools.appendChild(copyBtn);

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  fillRowToolButton(importBtn, 'import', 'Import');
  importBtn.title = 'Import into table';
  importBtn.onclick = () => options.onImport();
  primaryTools.appendChild(importBtn);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  fillRowToolButton(exportBtn, 'export', 'Export');
  exportBtn.style.position = 'relative';
  exportBtn.onclick = () => options.onExport(exportBtn);
  primaryTools.appendChild(exportBtn);

  return primaryTools;
}

/** Prominent AI control with optional subtle gradient animation (respects reduced motion). */
export function createAiMenuButton(options: AiMenuOptions): HTMLElement {
  ensureAiMenuButtonStyles();

  const wrap = document.createElement('div');
  wrap.className = `pg-ai-menu-btn-wrap ${prefersReducedMotion() ? '' : 'pg-ai-menu-btn--animated'}`;

  const aiBtn = document.createElement('button');
  aiBtn.type = 'button';
  fillToolbarButtonContent(aiBtn, 'sparkles', 'Ask AI');
  const aiIc = aiBtn.querySelector(`.${RESULT_TOOLBAR_ICON_CLASS}`);
  if (aiIc) {
    aiIc.innerHTML = resultToolbarSvg('sparkles', RESULT_TOOLBAR_SPARKLE_PX);
  }
  aiBtn.style.cssText = `
    display:inline-flex;
    align-items:center;
    gap:8px;
    padding:6px 14px;
    font-size:11px;
    font-family:var(--vscode-font-family);
    font-weight:600;
    letter-spacing:0.03em;
    cursor:pointer;
    border-radius:999px;
    border:none;
    background:transparent;
    color:var(--vscode-editor-foreground);
    box-shadow:none;
    position:relative;
  `;

  let aiPopover: HTMLElement | null = null;
  const closeAiPopover = () => {
    aiPopover?.remove();
    aiPopover = null;
  };

  aiBtn.onclick = (e) => {
    e.stopPropagation();
    if (aiPopover) {
      closeAiPopover();
      return;
    }
    aiPopover = document.createElement('div');
    aiPopover.style.cssText = `
      position:fixed;
      visibility:hidden;
      background:var(--vscode-menu-background);
      border:1px solid var(--vscode-menu-border);
      box-shadow:0 4px 12px rgba(0,0,0,0.2);
      z-index:${EXPORT_MENU_Z_INDEX};
      min-width:200px;
      border-radius:6px;
      padding:4px 0;
    `;

    const addItem = (label: string, glyph: ResultToolbarGlyph, onClick: () => void) => {
      const item = document.createElement('div');
      item.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;color:var(--vscode-menu-foreground);font-size:12px;';
      const ic = document.createElement('span');
      ic.className = RESULT_TOOLBAR_ICON_CLASS;
      ic.style.flexShrink = '0';
      ic.style.opacity = '0.92';
      ic.innerHTML = resultToolbarSvg(glyph, 15);
      const tx = document.createElement('span');
      tx.textContent = label;
      tx.style.flex = '1';
      item.appendChild(ic);
      item.appendChild(tx);
      item.onmouseenter = () => {
        item.style.background = 'var(--vscode-menu-selectionBackground)';
        item.style.color = 'var(--vscode-menu-selectionForeground)';
      };
      item.onmouseleave = () => {
        item.style.background = 'transparent';
        item.style.color = 'var(--vscode-menu-foreground)';
      };
      item.onclick = (ev) => {
        ev.stopPropagation();
        onClick();
        closeAiPopover();
      };
      aiPopover!.appendChild(item);
    };

    addItem('Send to Chat', 'menuChat', options.onSendToChat);
    addItem('Analyze data', 'menuChart', options.onAnalyzeWithAI);
    addItem('Optimize query', 'menuBolt', options.onOptimize);

    document.body.appendChild(aiPopover);
    positionExportDropdown(aiPopover, aiBtn, 'below');
    aiPopover.style.visibility = 'visible';

    setTimeout(() => {
      const outsideClick = (ev: MouseEvent) => {
        const t = ev.target as Node;
        if (!aiBtn.contains(t) && !aiPopover?.contains(t)) {
          closeAiPopover();
          document.removeEventListener('click', outsideClick);
        }
      };
      document.addEventListener('click', outsideClick);
    }, 0);
  };

  wrap.appendChild(aiBtn);
  return wrap;
}

export function createActionsMenuButton(options: ActionsMenuOptions): HTMLElement {
  ensureAiMenuButtonStyles();

  const wrap = document.createElement('div');
  wrap.className = 'pg-ai-menu-btn-wrap';

  const actionsBtn = document.createElement('button');
  actionsBtn.type = 'button';
  fillToolbarButtonContent(actionsBtn, 'menuList', 'Actions');
  const ic = actionsBtn.querySelector(`.${RESULT_TOOLBAR_ICON_CLASS}`);
  if (ic) {
    ic.innerHTML = resultToolbarSvg('menuList', RESULT_TOOLBAR_SPARKLE_PX);
  }

  const chev = document.createElement('span');
  chev.className = RESULT_TOOLBAR_ICON_CLASS;
  chev.style.marginLeft = '6px';
  chev.style.opacity = '0.7';
  chev.style.display = 'inline-flex';
  chev.style.alignItems = 'center';
  chev.innerHTML = resultToolbarSvg('chevronDown', 10);
  actionsBtn.appendChild(chev);

  actionsBtn.style.cssText = `
    display:inline-flex;
    align-items:center;
    gap:6px;
    padding:6px 12px 6px 14px;
    font-size:11px;
    font-family:var(--vscode-font-family);
    font-weight:600;
    letter-spacing:0.03em;
    cursor:pointer;
    border-radius:999px;
    border:none;
    background:transparent;
    color:var(--vscode-editor-foreground);
    box-shadow:none;
    position:relative;
  `;

  let popover: HTMLElement | null = null;
  const closePopover = () => {
    popover?.remove();
    popover = null;
  };

  actionsBtn.onclick = (e) => {
    e.stopPropagation();
    if (popover) {
      closePopover();
      return;
    }
    popover = document.createElement('div');
    popover.style.cssText = `
      position:fixed;
      visibility:hidden;
      background:var(--vscode-menu-background);
      border:1px solid var(--vscode-menu-border);
      box-shadow:0 4px 12px rgba(0,0,0,0.2);
      z-index:${EXPORT_MENU_Z_INDEX};
      min-width:200px;
      border-radius:6px;
      padding:4px 0;
    `;

    const addItem = (label: string, glyph: ResultToolbarGlyph, onClick: () => void) => {
      const item = document.createElement('div');
      item.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;color:var(--vscode-menu-foreground);font-size:12px;';
      const icEl = document.createElement('span');
      icEl.className = RESULT_TOOLBAR_ICON_CLASS;
      icEl.style.flexShrink = '0';
      icEl.style.opacity = '0.92';
      icEl.innerHTML = resultToolbarSvg(glyph, 15);
      const tx = document.createElement('span');
      tx.textContent = label;
      tx.style.flex = '1';
      item.appendChild(icEl);
      item.appendChild(tx);
      item.onmouseenter = () => {
        item.style.background = 'var(--vscode-menu-selectionBackground)';
        item.style.color = 'var(--vscode-menu-selectionForeground)';
      };
      item.onmouseleave = () => {
        item.style.background = 'transparent';
        item.style.color = 'var(--vscode-menu-foreground)';
      };
      item.onclick = (ev) => {
        ev.stopPropagation();
        onClick();
        closePopover();
      };
      popover!.appendChild(item);
    };

    if (isProBuild()) {
      addItem('Send to Chat', 'menuChat', options.onSendToChat);
    }
    addItem('Save Query', 'save', options.onSaveQuery);
    addItem('Run for full dataset', 'table', options.onRunFullDataset);
    addItem('Explain analyze', 'explain', options.onExplainAnalyze);

    document.body.appendChild(popover);
    positionExportDropdown(popover, actionsBtn, 'below');
    popover.style.visibility = 'visible';

    setTimeout(() => {
      const outsideClick = (ev: MouseEvent) => {
        const t = ev.target as Node;
        if (!actionsBtn.contains(t) && !popover?.contains(t)) {
          closePopover();
          document.removeEventListener('click', outsideClick);
        }
      };
      document.addEventListener('click', outsideClick);
    }, 0);
  };

  wrap.appendChild(actionsBtn);
  return wrap;
}

/**
 * Row tools + AI only (tests / legacy). Table secondary band uses createAiMenuButton + footer row tools.
 */
export function createActionBar(options: ActionBarOptions): ActionBarParts {
  const container = document.createElement('div');
  container.style.cssText = `
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--vscode-widget-border);
    font-family: var(--vscode-font-family);
    min-height: 32px;
    flex-wrap: wrap;
  `;

  const primaryTools = createRowTools(options);

  const spacer = document.createElement('div');
  spacer.style.cssText = 'flex:1;min-width:12px;';

  const rightGroup = document.createElement('div');
  rightGroup.style.cssText =
    'display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;';

  rightGroup.appendChild(createAiMenuButton(options));

  container.appendChild(primaryTools);
  container.appendChild(spacer);
  container.appendChild(rightGroup);

  return {
    container,
    primaryTools,
    rightGroup,
  };
}
