/**
 * ActionBar component for the Result Panel table data view.
 * Renders a split bar with data actions on the left and AI actions on the right,
 * separated by a visible vertical divider.
 */

export interface ActionBarOptions {
  onSelectAll: () => void;
  onCopy: () => void;
  onImport: () => void;
  onExport: (exportBtn: HTMLElement) => void;
  onSendToChat: () => void;
  onAnalyzeWithAI: () => void;
  onOptimize: () => void;
}

/**
 * Creates an action bar element with data actions (left) and AI actions (right).
 * Layout: [ Select All | Copy | Import | Export ] | [ Send to Chat | Analyze with AI | Optimize ]
 */
export function createActionBar(options: ActionBarOptions): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    gap: 8px;
    font-family: var(--vscode-font-family);
  `;

  // Left group: data actions
  const leftGroup = document.createElement('div');
  leftGroup.style.cssText = `
    display: flex;
    align-items: center;
    gap: 4px;
  `;
  leftGroup.appendChild(createButton('☐ Select All', options.onSelectAll));
  leftGroup.appendChild(createButton('⎘ Copy', options.onCopy));
  leftGroup.appendChild(createButton('⬆ Import', options.onImport));

  // Export button — passed to onExport so the dropdown can anchor to it
  const exportBtn = createButton('↓ Export', () => {});
  exportBtn.style.position = 'relative';
  exportBtn.onclick = () => options.onExport(exportBtn);
  leftGroup.appendChild(exportBtn);

  // Vertical divider
  const divider = document.createElement('div');
  divider.style.cssText = `
    border-left: 1px solid var(--vscode-panel-border);
    align-self: stretch;
    margin: 2px 4px;
  `;

  // Right group: AI actions
  const rightGroup = document.createElement('div');
  rightGroup.style.cssText = `
    display: flex;
    align-items: center;
    gap: 4px;
  `;
  rightGroup.appendChild(createButton('✦ Send to Chat', options.onSendToChat));
  rightGroup.appendChild(createButton('◎ Analyze with AI', options.onAnalyzeWithAI));
  rightGroup.appendChild(createButton('⚡ Optimize', options.onOptimize));

  container.appendChild(leftGroup);
  container.appendChild(divider);
  container.appendChild(rightGroup);

  return container;
}

function createButton(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText = `
    padding: 3px 8px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  `;
  btn.onmouseover = () => {
    btn.style.background = 'var(--vscode-button-secondaryHoverBackground)';
  };
  btn.onmouseout = () => {
    btn.style.background = 'var(--vscode-button-secondaryBackground)';
  };
  btn.onclick = () => onClick();
  return btn;
}
