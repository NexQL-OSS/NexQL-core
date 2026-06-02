import * as vscode from 'vscode';

/** Metadata for a panel slot being recycled out of the pool. */
export interface RecycledPanelInfo {
  viewType: string;
  key: string;
  panel: vscode.WebviewPanel;
}

interface PoolEntry {
  viewType: string;
  key: string;
  panel: vscode.WebviewPanel;
  lastAccessed: number;
  onDispose?: () => void;
  onRecycle?: (recycled: RecycledPanelInfo) => void;
}

/** Dispose the registry owner bound to a pooled webview panel. */
export function disposePooledOwner<T extends { _panel: vscode.WebviewPanel; dispose: (isRecycling?: boolean) => void }>(
  registry: Map<string, T>,
  panel: vscode.WebviewPanel,
  isRecycling: boolean,
): void {
  for (const [key, owner] of registry.entries()) {
    if (owner._panel === panel) {
      registry.delete(key);
      owner.dispose(isRecycling);
      return;
    }
  }
}

export interface WebviewPoolResult {
  panel: vscode.WebviewPanel;
  isNew: boolean;
  /**
   * Commits the panel into the pool. Call only after the owner instance is
   * constructed and registered — prevents recycle callbacks from running while
   * the owner reference is still undefined.
   */
  commit?: () => void;
}

export class WebviewPool {
  private static _instance: WebviewPool | undefined;
  private _entries: PoolEntry[] = [];
  private _panelEntryIndex = new WeakMap<vscode.WebviewPanel, PoolEntry>();
  private _maxCapacity = 10; // Max number of concurrent pooled panels

  private constructor() {}

  public static getInstance(): WebviewPool {
    if (!WebviewPool._instance) {
      WebviewPool._instance = new WebviewPool();
    }
    return WebviewPool._instance;
  }

  /**
   * Gets an existing panel by key, or creates/recycles a panel.
   */
  public getOrCreate(
    viewType: string,
    key: string,
    title: string,
    viewColumn: vscode.ViewColumn,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
    callbacks?: {
      onDispose?: () => void;
      onRecycle?: (recycled: RecycledPanelInfo) => void;
    }
  ): WebviewPoolResult {
    // Clean up any disposed panels first (safety check)
    this._entries = this._entries.filter(entry => {
      try {
        // Try accessing panel title as a simple check to see if it's disposed
        const _t = entry.panel.title;
        return true;
      } catch {
        return false;
      }
    });

    // 1. Look for existing panel with exact key and viewType
    const existing = this._entries.find(e => e.viewType === viewType && e.key === key);
    if (existing) {
      existing.lastAccessed = Date.now();
      // Update callbacks if provided
      if (callbacks) {
        existing.onDispose = callbacks.onDispose;
        existing.onRecycle = callbacks.onRecycle;
      }
      this._panelEntryIndex.set(existing.panel, existing);
      return { panel: existing.panel, isNew: false };
    }

    // 2. Check if we reached global capacity limit
    if (this._entries.length >= this._maxCapacity) {
      let recycleCandidate: PoolEntry | undefined;

      // Prefer recycling a panel that is not currently visible
      const hiddenPanels = this._entries.filter(e => !e.panel.visible);
      if (hiddenPanels.length > 0) {
        hiddenPanels.sort((a, b) => a.lastAccessed - b.lastAccessed);
        recycleCandidate = hiddenPanels[0];
      } else {
        // If all are visible, pick the oldest accessed one globally
        this._entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
        recycleCandidate = this._entries[0];
      }

      if (recycleCandidate) {
        // Recycle this candidate!
        const panel = recycleCandidate.panel;

        // Trigger recycle callback so the previous owner can clean up
        if (recycleCandidate.onRecycle) {
          try {
            recycleCandidate.onRecycle({
              viewType: recycleCandidate.viewType,
              key: recycleCandidate.key,
              panel: recycleCandidate.panel,
            });
          } catch (e) {
            console.error('Error during panel recycle cleanup:', e);
          }
        }

        // Update the panel properties
        panel.title = title;

        // Remove the old entry from our active entries
        this._entries = this._entries.filter(e => e !== recycleCandidate);

        // Create new entry for this panel (committed after owner is ready)
        const newEntry: PoolEntry = {
          viewType,
          key,
          panel,
          lastAccessed: Date.now(),
          onDispose: callbacks?.onDispose,
          onRecycle: callbacks?.onRecycle
        };
        // Attach the recycled panel to its new callbacks immediately so
        // dispose events between getOrCreate() and commit() still resolve
        // to the current owner instead of stale/no callbacks.
        this._panelEntryIndex.set(panel, newEntry);

        return {
          panel,
          isNew: false,
          commit: () => {
            if (!this._entries.includes(newEntry)) {
              this._entries.push(newEntry);
            }
          }
        };
      }
    }

    // 3. Create a brand new panel
    const panel = vscode.window.createWebviewPanel(
      viewType,
      title,
      viewColumn,
      options
    );

    const entry: PoolEntry = {
      viewType,
      key,
      panel,
      lastAccessed: Date.now(),
      onDispose: callbacks?.onDispose,
      onRecycle: callbacks?.onRecycle
    };
    this._panelEntryIndex.set(panel, entry);

    panel.onDidDispose(() => {
      // Resolve the current pool entry — recycled panels reuse the same panel object
      // but swap onDispose/onRecycle callbacks on a new PoolEntry.
      const currentEntry = this._panelEntryIndex.get(panel)
        ?? this._entries.find(e => e.panel === panel);
      if (currentEntry?.onDispose) {
        try {
          currentEntry.onDispose();
        } catch (e) {
          console.error('Error during panel dispose callback:', e);
        }
      }
      this._entries = this._entries.filter(e => e.panel !== panel);
      this._panelEntryIndex.delete(panel);
    });

    return {
      panel,
      isNew: true,
      commit: () => {
        this._entries.push(entry);
      }
    };
  }
}
