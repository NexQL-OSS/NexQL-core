/**
 * Singleton, ONLY external entry point for attaching context to the SQL
 * Assistant. Every call site (tree view @, result grid buttons, EXPLAIN tab,
 * analyst tab, migration generator, index advisor, backup tools) should call
 * `AssistantGateway.getInstance().invoke(...)` instead of reaching into
 * ChatViewProvider or `require('../extension')` directly — that circular-require
 * hack is exactly what this class exists to remove.
 */
import * as vscode from 'vscode';
import type { DbObject, FileAttachment } from '../../common/chatTypes';
import { AssistantInvocation, ContextItem } from './contextItems';
import { buildDraft } from './promptFraming';

export interface AttachInvocationPayload {
  draftText: string;
  attachments: FileAttachment[];
  /** dbObject items, resolved with schema `details` already fetched. */
  mentions: DbObject[];
  autoSend: boolean;
}

/** Implemented by ChatViewProvider; registered once at activation. */
export interface ChatProviderBridge {
  /** Resolve the surface to target: visible surface, or reveal the sidebar. Never opens a new editor tab. */
  resolveOrRevealSurface(): Promise<vscode.Webview | undefined>;
  resolveDbObjectSchema(obj: DbObject): Promise<string>;
  setInvocationConnectionContext(connectionId?: string, database?: string): void;
  postAttachInvocation(webview: vscode.Webview, payload: AttachInvocationPayload): void;
  /** True if a chat surface is visible without revealing/focusing anything (Phase 4: MCP approval routing). */
  hasVisibleChatSurface(): boolean;
  /** Post a message to every live chat surface (Phase 4: MCP approval cards, labeled for external agents). */
  broadcastToChatSurfaces(message: unknown): void;
}

function isDbObjectItem(item: ContextItem): item is Extract<ContextItem, { kind: 'dbObject' }> {
  return item.kind === 'dbObject';
}

export class AssistantGateway {
  private static _instance: AssistantGateway | undefined;
  private _provider?: ChatProviderBridge;

  static getInstance(): AssistantGateway {
    if (!AssistantGateway._instance) {
      AssistantGateway._instance = new AssistantGateway();
    }
    return AssistantGateway._instance;
  }

  private constructor() {}

  registerChatProvider(provider: ChatProviderBridge): void {
    this._provider = provider;
  }

  /** True if a chat surface is already visible — never reveals/focuses. */
  hasVisibleChatSurface(): boolean {
    return this._provider?.hasVisibleChatSurface() ?? false;
  }

  /** Reveal (or reuse a visible) chat surface — same policy as `invoke()`'s targeting. */
  async revealChatSurface(): Promise<vscode.Webview | undefined> {
    return this._provider?.resolveOrRevealSurface();
  }

  /** Broadcast a message to every live chat surface. */
  broadcastToChatSurfaces(message: unknown): void {
    this._provider?.broadcastToChatSurfaces(message);
  }

  async invoke(inv: AssistantInvocation): Promise<void> {
    const provider = this._provider;
    if (!provider) {
      throw new Error('SQL Assistant is not available yet — no chat provider registered.');
    }

    if (inv.connection && (inv.connection.connectionId || inv.connection.database)) {
      provider.setInvocationConnectionContext(inv.connection.connectionId, inv.connection.database);
    }

    const webview = await provider.resolveOrRevealSurface();
    if (!webview) {
      void vscode.window.showWarningMessage('Could not open SQL Assistant.');
      return;
    }

    const { draftText, attachments } = buildDraft(inv);

    const dbObjectItems = inv.items.filter(isDbObjectItem);
    const mentions = await Promise.all(
      dbObjectItems.map(async (item) => ({
        ...item.object,
        details: await provider.resolveDbObjectSchema(item.object),
      }))
    );

    provider.postAttachInvocation(webview, {
      draftText,
      attachments,
      mentions,
      autoSend: inv.send === 'auto',
    });
  }
}
