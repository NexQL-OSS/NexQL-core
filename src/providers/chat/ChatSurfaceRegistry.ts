/**
 * Tracks every live SQL Assistant webview (sidebar + N editor tabs) and
 * decides, deterministically, which one an attach/focus operation should
 * target — or whether to broadcast state to all of them.
 *
 * Replaces the old `_activeWebview` field on ChatViewProvider, which was
 * reassigned on every inbound message from ANY surface and made targeting
 * nondeterministic across sidebar + tab panels (see plan doc). Focus is
 * updated ONLY on view-state changes, never on message receipt.
 */
import * as vscode from 'vscode';

export type ChatSurfaceKind = 'sidebar' | 'panel';

export interface ChatSurface {
  id: number;
  kind: ChatSurfaceKind;
  webview: vscode.Webview;
  ready: Promise<void>;
  visible: boolean;
  lastFocusedAt: number;
}

const READY_TIMEOUT_MS = 5000;

let nextId = 1;

export class ChatSurfaceRegistry {
  private _surfaces: ChatSurface[] = [];
  private _resolveReady = new Map<number, () => void>();

  /** Register a newly created webview. Call once per sidebar resolve / panel creation. */
  register(webview: vscode.Webview, kind: ChatSurfaceKind): ChatSurface {
    const id = nextId++;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this._resolveReady.set(id, resolveReady);

    const surface: ChatSurface = {
      id,
      kind,
      webview,
      ready,
      visible: kind === 'sidebar', // sidebar views start "visible enough" to target; corrected on first visibility event
      lastFocusedAt: Date.now(),
    };
    this._surfaces.push(surface);
    return surface;
  }

  unregister(webview: vscode.Webview): void {
    const idx = this._surfaces.findIndex((s) => s.webview === webview);
    if (idx >= 0) {
      const [removed] = this._surfaces.splice(idx, 1);
      this._resolveReady.delete(removed.id);
    }
  }

  /** Mark a surface ready after it posts `{type:'webviewReady'}`. Idempotent. */
  markReady(webview: vscode.Webview): void {
    const surface = this._surfaces.find((s) => s.webview === webview);
    if (!surface) return;
    const resolve = this._resolveReady.get(surface.id);
    if (resolve) {
      resolve();
      this._resolveReady.delete(surface.id);
    }
  }

  /** Update visibility + focus timestamp. Call from onDidChangeVisibility / onDidChangeViewState only. */
  setVisible(webview: vscode.Webview, visible: boolean): void {
    const surface = this._surfaces.find((s) => s.webview === webview);
    if (!surface) return;
    surface.visible = visible;
    if (visible) {
      surface.lastFocusedAt = Date.now();
    }
  }

  /** Post a message to every live surface — used for state sync (history, messages, typing, etc). */
  broadcast(message: unknown): void {
    for (const surface of this._surfaces) {
      surface.webview.postMessage(message);
    }
  }

  private _mostRecentVisible(): ChatSurface | undefined {
    const visible = this._surfaces.filter((s) => s.visible);
    if (visible.length === 0) return undefined;
    return visible.reduce((a, b) => (b.lastFocusedAt > a.lastFocusedAt ? b : a));
  }

  /**
   * True if a chat surface is already visible to the user, without revealing/focusing
   * anything. Used by external entry points (e.g. the MCP server) that must decide
   * between an inline approval card and a modal — an external agent's tool call
   * shouldn't yank focus onto the sidebar just to ask a question.
   */
  hasVisibleSurface(): boolean {
    return this._mostRecentVisible() !== undefined;
  }

  /**
   * Resolve a target surface for attach/focus operations. If a surface is already
   * visible, use it. Otherwise reveal the sidebar via `focusCommand` and wait for
   * it to register + become ready. Never implicitly opens a new editor tab.
   */
  async resolveOrReveal(focusCommand: string): Promise<vscode.Webview | undefined> {
    const alreadyVisible = this._mostRecentVisible();
    if (alreadyVisible) {
      await this._awaitReady(alreadyVisible);
      return alreadyVisible.webview;
    }

    await vscode.commands.executeCommand(focusCommand);

    const sidebarReady = await this._waitForSidebar();
    return sidebarReady?.webview;
  }

  private async _awaitReady(surface: ChatSurface): Promise<void> {
    await Promise.race([surface.ready, this._timeout()]);
  }

  private _timeout(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT_MS));
  }

  private async _waitForSidebar(): Promise<ChatSurface | undefined> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    // The sidebar surface may already be registered (view previously resolved) — just needs revealing.
    while (Date.now() < deadline) {
      const sidebar = this._surfaces.find((s) => s.kind === 'sidebar');
      if (sidebar) {
        await this._awaitReady(sidebar);
        return sidebar;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }
}
