/**
 * TopBar component for the Notebook top-level action bar.
 * Renders a flex container with notebook-level action buttons and a right-aligned connection pill.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

export interface TopBarOptions {
  connectionName: string;
  host: string;
  database: string;
  isConnected: boolean;
  onRunAll: () => void;
  onClearOutputs: () => void;
  onAddCodeCell: () => void;
  onAddMarkdownCell: () => void;
}

/**
 * Creates a TopBar element with action buttons and a connection pill.
 */
export function createTopBar(options: TopBarOptions, postMessage: (msg: any) => void): HTMLElement {
  ensureTopBarStyle();

  const bar = document.createElement('div');
  bar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-widget-border);
    font-family: var(--vscode-font-family);
    font-size: 12px;
  `;

  // Action buttons (left side)
  bar.appendChild(createTopBarButton('▶ Run All', options.onRunAll));
  bar.appendChild(createTopBarButton('✕ Clear Outputs', options.onClearOutputs));
  bar.appendChild(createSeparator());
  bar.appendChild(createTopBarButton('+ Code Cell', options.onAddCodeCell));
  bar.appendChild(createTopBarButton('+ Markdown Cell', options.onAddMarkdownCell));

  // Connection pill (right-aligned via margin-left: auto)
  const pill = createConnectionPill(options, postMessage);
  bar.appendChild(pill);

  return bar;
}

function createConnectionPill(options: TopBarOptions, postMessage: (msg: any) => void): HTMLElement {
  const pill = document.createElement('button');
  pill.style.cssText = `
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    border-radius: 10px;
    cursor: pointer;
    border: 1px solid ${options.isConnected ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-editorError-foreground)'};
    background: ${options.isConnected
      ? 'color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, var(--vscode-editor-background))'
      : 'color-mix(in srgb, var(--vscode-editorError-foreground) 12%, var(--vscode-editor-background))'};
    color: var(--vscode-editor-foreground);
    transition: opacity 0.15s;
    white-space: nowrap;
  `;

  // Status dot
  const dot = document.createElement('span');
  dot.style.cssText = `
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    background: ${options.isConnected ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-editorError-foreground)'};
    flex-shrink: 0;
  `;
  if (!options.isConnected) {
    dot.className = 'topbar-dot-disconnected';
  }

  const label = document.createElement('span');
  if (options.isConnected) {
    label.textContent = `${options.connectionName} · ${options.database}`;
    pill.title = `Host: ${options.host}\nDatabase: ${options.database}`;
  } else {
    label.textContent = 'Not connected';
    pill.title = 'No active connection';
  }

  pill.appendChild(dot);
  pill.appendChild(label);

  pill.onmouseover = () => { pill.style.opacity = '0.8'; };
  pill.onmouseout = () => { pill.style.opacity = '1'; };
  pill.onclick = () => {
    postMessage({ type: 'showConnectionInfo' });
  };

  return pill;
}

function createTopBarButton(label: string, onClick: () => void): HTMLElement {
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
  btn.onmouseover = () => { btn.style.background = 'var(--vscode-button-secondaryHoverBackground)'; };
  btn.onmouseout = () => { btn.style.background = 'var(--vscode-button-secondaryBackground)'; };
  btn.onclick = () => onClick();
  return btn;
}

function createSeparator(): HTMLElement {
  const sep = document.createElement('div');
  sep.style.cssText = `
    border-left: 1px solid var(--vscode-panel-border);
    align-self: stretch;
    margin: 2px 2px;
  `;
  return sep;
}

function ensureTopBarStyle(): void {
  const STYLE_ID = 'topbar-disconnected-style';
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes topbar-blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
    .topbar-dot-disconnected {
      animation: topbar-blink 1.4s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}
