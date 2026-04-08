/**
 * TransactionBanner component for displaying an open transaction state.
 * Renders an amber pulsing banner with statement count and Commit/Rollback buttons.
 */

export interface TransactionBannerOptions {
  statementCount: number;
  onCommit: () => void;
  onRollback: () => void;
}

// Inject the pulse-amber keyframe animation once into the document
function ensurePulseAmberStyle(): void {
  const STYLE_ID = 'transaction-banner-pulse-amber';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes pulse-amber {
      0%   { background-color: rgba(255, 176, 0, 0.18); }
      50%  { background-color: rgba(255, 176, 0, 0.32); }
      100% { background-color: rgba(255, 176, 0, 0.18); }
    }
    .transaction-banner-pulse {
      animation: pulse-amber 2s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Creates a TransactionBanner element.
 * Shows "Transaction open · {n} statements · not committed" with Commit and Rollback buttons.
 */
export function createTransactionBanner(options: TransactionBannerOptions): HTMLElement {
  ensurePulseAmberStyle();

  const banner = document.createElement('div');
  banner.className = 'transaction-banner-pulse';
  banner.dataset.transactionBanner = 'true';
  banner.style.cssText = `
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-left: 4px solid #ffb000;
    border-bottom: 1px solid rgba(255, 176, 0, 0.4);
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-editorWarning-foreground, #ffb000);
  `;

  // Text label
  const label = document.createElement('span');
  label.style.cssText = 'flex: 1; font-weight: 500;';
  label.textContent = `Transaction open · ${options.statementCount} statement${options.statementCount !== 1 ? 's' : ''} · not committed`;
  banner.appendChild(label);

  // Commit button
  banner.appendChild(createBannerButton('Commit', '#ffb000', options.onCommit));

  // Rollback button
  banner.appendChild(createBannerButton('Rollback', 'transparent', options.onRollback));

  return banner;
}

function createBannerButton(label: string, bgColor: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  const isFilled = bgColor !== 'transparent';
  btn.style.cssText = `
    padding: 3px 10px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    color: ${isFilled ? '#000' : 'var(--vscode-editorWarning-foreground, #ffb000)'};
    background: ${bgColor};
    border: 1px solid #ffb000;
    border-radius: 3px;
    cursor: pointer;
    font-weight: ${isFilled ? '600' : '400'};
    transition: opacity 0.15s;
  `;
  btn.onmouseover = () => { btn.style.opacity = '0.8'; };
  btn.onmouseout = () => { btn.style.opacity = '1'; };
  btn.onclick = () => onClick();
  return btn;
}
