/**
 * TopBar component for the Notebook top-level action bar.
 * Renders a flex container with notebook-level action buttons and a right-aligned connection pill.
 */

import type { SentinelEnvironment } from '../../features/sentinel/types';

export interface TopBarOptions {
  connectionName: string;
  host: string;
  port?: number;
  database: string;
  username?: string;
  environment?: SentinelEnvironment;
  readOnlyMode?: boolean;
  isConnected: boolean;
  showContextStrip?: boolean;
  onRunAll: () => void;
  onClearOutputs: () => void;
  onAddCodeCell: () => void;
  onAddMarkdownCell: () => void;
}

const ENV_CHIP_STYLES: Record<SentinelEnvironment, { bg: string; border: string; text: string; label: string }> = {
  production: {
    bg: 'color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 55%, transparent)',
    border: 'var(--vscode-inputValidation-errorBorder)',
    text: 'var(--vscode-inputValidation-errorForeground)',
    label: 'PROD',
  },
  staging: {
    bg: 'color-mix(in srgb, var(--vscode-inputValidation-warningBackground) 55%, transparent)',
    border: 'var(--vscode-inputValidation-warningBorder)',
    text: 'var(--vscode-inputValidation-warningForeground)',
    label: 'STAGING',
  },
  development: {
    bg: 'color-mix(in srgb, var(--vscode-charts-blue) 22%, var(--vscode-editor-background))',
    border: 'var(--vscode-charts-blue)',
    text: 'var(--vscode-charts-blue)',
    label: 'DEV',
  },
};

/**
 * Creates a TopBar element with action buttons and a connection pill.
 */
export function createTopBar(options: TopBarOptions, postMessage: (msg: any) => void): HTMLElement {
  ensureTopBarStyle();

  const bar = document.createElement('div');
  bar.className = 'pgstudio-topbar';
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

  if (options.showContextStrip !== false && options.isConnected) {
    bar.appendChild(createContextStrip(options));
  }

  bar.appendChild(createTopBarButton('▶ Run All', options.onRunAll));
  bar.appendChild(createTopBarButton('✕ Clear Outputs', options.onClearOutputs));
  bar.appendChild(createSeparator());
  bar.appendChild(createTopBarButton('+ Code Cell', options.onAddCodeCell));
  bar.appendChild(createTopBarButton('+ Markdown Cell', options.onAddMarkdownCell));

  const pill = createConnectionPill(options, postMessage);
  bar.appendChild(pill);

  return bar;
}

function createContextStrip(options: TopBarOptions): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'pgstudio-sentinel-strip';
  strip.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    margin-right: 8px;
    padding: 2px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, transparent);
    border: 1px solid var(--vscode-widget-border);
    font-size: 11px;
    white-space: nowrap;
  `;

  if (options.environment) {
    const chip = createEnvChip(options.environment, !!options.readOnlyMode);
    strip.appendChild(chip);
  }

  const context = document.createElement('span');
  const userHost = options.username
    ? `${options.username}@${options.host}`
    : options.host;
  const portSuffix = options.port ? `:${options.port}` : '';
  context.textContent = `${options.connectionName} · ${options.database} · ${userHost}${portSuffix}`;
  context.style.color = 'var(--vscode-descriptionForeground)';
  strip.appendChild(context);

  return strip;
}

function createEnvChip(environment: SentinelEnvironment, readOnly: boolean): HTMLElement {
  const style = ENV_CHIP_STYLES[environment];
  const chip = document.createElement('span');
  chip.textContent = `${style.label}${readOnly ? ' RO' : ''}`;
  chip.style.cssText = `
    padding: 1px 7px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    background: ${style.bg};
    border: 1px solid ${style.border};
    color: ${style.text};
  `;
  return chip;
}

function createConnectionPill(options: TopBarOptions, postMessage: (msg: any) => void): HTMLElement {
  const pill = document.createElement('button');
  pill.type = 'button';
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
    const userPart = options.username ? ` · ${options.username}` : '';
    label.textContent = `${options.connectionName} · ${options.database}${userPart}`;
    pill.title = [
      options.environment ? `Environment: ${ENV_CHIP_STYLES[options.environment].label}` : '',
      `Host: ${options.host}${options.port ? `:${options.port}` : ''}`,
      options.username ? `User: ${options.username}` : '',
      `Database: ${options.database}`,
      options.readOnlyMode ? 'Read-only mode' : '',
    ].filter(Boolean).join('\n');
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
  btn.type = 'button';
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
