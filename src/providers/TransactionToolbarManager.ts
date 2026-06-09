import * as vscode from 'vscode';
import { getTransactionManager } from '../services/TransactionManager';
import { createTransactionToolbar, updateToolbarState } from './TransactionUI';
import { debugLog } from '../common/logger';

/**
 * Manages transaction toolbar injection and lifecycle for notebooks
 */
export class TransactionToolbarManager {
  private static instance: TransactionToolbarManager;
  private toolbarsByNotebook = new Map<string, { element: HTMLElement; updateInterval: NodeJS.Timeout }>();

  private constructor() {}

  static getInstance(): TransactionToolbarManager {
    if (!TransactionToolbarManager.instance) {
      TransactionToolbarManager.instance = new TransactionToolbarManager();
    }
    return TransactionToolbarManager.instance;
  }

  /**
   * Create top-level notebook toolbar with transaction controls
   */
  createNotebookToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'transaction-toolbar-container';
    toolbar.style.cssText = `
      padding: 10px 12px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-widget-border);
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
      user-select: none;
      position: sticky;
      top: 0;
      z-index: 10;
    `;

    const toolbarContent = createTransactionToolbar();
    toolbar.innerHTML = toolbarContent;

    // Wire up button handlers
    this.wireUpToolbarButtons(toolbar);

    return toolbar;
  }

  /**
   * Create per-cell transaction toolbar
   */
  createCellToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'transaction-cell-toolbar';
    toolbar.style.cssText = `
      padding: 8px 12px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 3px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      margin-bottom: 8px;
    `;

    const toolbarContent = createTransactionToolbar();
    toolbar.innerHTML = toolbarContent;

    // Wire up button handlers
    this.wireUpToolbarButtons(toolbar);

    return toolbar;
  }

  /**
   * Wire up all button click handlers to send messages to kernel
   */
  private wireUpToolbarButtons(container: HTMLElement) {
    const buttons = {
      'btn-begin': 'transaction_begin',
      'btn-commit': 'transaction_commit',
      'btn-rollback': 'transaction_rollback',
      'btn-savepoint': 'savepoint_create',
    };

    Object.entries(buttons).forEach(([btnId, messageType]) => {
      const btn = container.querySelector(`#${btnId}`) as HTMLButtonElement;
      if (btn) {
        btn.addEventListener('click', () => {
          this.sendMessageToKernel(messageType, {});
        });
      }
    });

    // Isolation level selector
    const isolationSelect = container.querySelector('select') as HTMLSelectElement;
    if (isolationSelect) {
      isolationSelect.addEventListener('change', () => {
        this.sendMessageToKernel('set_isolation_level', {
          level: isolationSelect.value,
        });
      });
    }

    // Checkboxes
    const autoRollbackCheckbox = container.querySelector(
      'input[data-option="autoRollback"]'
    ) as HTMLInputElement;
    if (autoRollbackCheckbox) {
      autoRollbackCheckbox.addEventListener('change', () => {
        this.sendMessageToKernel('set_auto_rollback', {
          enabled: autoRollbackCheckbox.checked,
        });
      });
    }

    const readOnlyCheckbox = container.querySelector(
      'input[data-option="readOnly"]'
    ) as HTMLInputElement;
    if (readOnlyCheckbox) {
      readOnlyCheckbox.addEventListener('change', () => {
        this.sendMessageToKernel('set_read_only', {
          enabled: readOnlyCheckbox.checked,
        });
      });
    }
  }

  /**
   * Send message to notebook kernel
   */
  private sendMessageToKernel(type: string, payload: any) {
    const message = {
      type,
      ...payload,
    };

    debugLog('[TransactionToolbarManager] Sending message:', message);

    // Use VS Code API to send message to kernel
    (window as any).acquireVsCodeApi().postMessage({
      type: 'kernel_message',
      message,
    });
  }

  /**
   * Start monitoring transaction state and updating toolbar
   */
  monitorTransactionState(
    notebookUri: string,
    toolbar: HTMLElement,
    updateInterval: number = 500
  ) {
    const key = notebookUri;

    // Clear existing interval if any
    if (this.toolbarsByNotebook.has(key)) {
      clearInterval(this.toolbarsByNotebook.get(key)!.updateInterval);
    }

    const txManager = getTransactionManager();
    const interval = setInterval(() => {
      const state = txManager.getTransactionState(key);
      updateToolbarState(toolbar, state.isActive, state.isFailed, state.savepointCount);
    }, updateInterval);

    this.toolbarsByNotebook.set(key, { element: toolbar, updateInterval: interval });
  }

  /**
   * Stop monitoring transaction state
   */
  stopMonitoring(notebookUri: string) {
    const key = notebookUri;
    if (this.toolbarsByNotebook.has(key)) {
      const { updateInterval } = this.toolbarsByNotebook.get(key)!;
      clearInterval(updateInterval);
      this.toolbarsByNotebook.delete(key);
    }
  }

  /**
   * Clean up all toolbars
   */
  dispose() {
    this.toolbarsByNotebook.forEach(({ updateInterval }) => {
      clearInterval(updateInterval);
    });
    this.toolbarsByNotebook.clear();
  }
}

export function getTransactionToolbarManager(): TransactionToolbarManager {
  return TransactionToolbarManager.getInstance();
}
