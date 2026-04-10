/**
 * ErrorPanel component for displaying query execution errors.
 * Shows the raw PostgreSQL error, an optional plain-English explanation,
 * and three action buttons: Explain error, Fix with AI, and Retry.
 */

export interface ErrorPanelOptions {
  errorCode?: string;
  errorMessage: string;
  explanation?: string;
  cellId?: string;
  onExplainError: () => void;
  onFixWithAI: () => void;
  onRetry: () => void;
}

/**
 * Creates an error panel element for displaying query execution failures.
 */
export function createErrorPanel(options: ErrorPanelOptions): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText = `
    border-left: 3px solid var(--vscode-errorForeground);
    padding: 12px 16px;
    margin: 8px 0;
    background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.05));
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
  `;

  // Raw error in monospace
  const errorLine = document.createElement('div');
  const errorText = options.errorCode
    ? `ERROR ${options.errorCode}: ${options.errorMessage}`
    : options.errorMessage;
  errorLine.textContent = errorText;
  errorLine.style.cssText = `
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-errorForeground);
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 8px;
  `;
  container.appendChild(errorLine);

  // Plain-English explanation (omitted when undefined)
  if (options.explanation !== undefined) {
    const explanationEl = document.createElement('p');
    explanationEl.textContent = options.explanation;
    explanationEl.style.cssText = `
      margin: 0 0 12px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    `;
    container.appendChild(explanationEl);
  }

  // Action buttons row
  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = `
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  `;

  actionsRow.appendChild(createButton('◎ Explain error', options.onExplainError));
  actionsRow.appendChild(createButton('✦ Fix with AI', options.onFixWithAI));
  actionsRow.appendChild(createButton('↺ Retry', options.onRetry));

  container.appendChild(actionsRow);

  return container;
}

function createButton(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText = `
    padding: 4px 10px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    cursor: pointer;
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
