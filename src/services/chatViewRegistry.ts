import type { IChatViewProvider } from '../pro/api';

/**
 * Holds the active chat view provider so features can reach the SQL Assistant
 * without importing extension.ts (which imports them back — a require cycle).
 * Set during activation; undefined in builds without the chat feature.
 * Uses the core-owned IChatViewProvider interface — never imports the concrete class.
 */
let chatViewProvider: IChatViewProvider | undefined;
let aiServiceInstance: any | undefined;
let resolveChatViewReady: ((provider: IChatViewProvider | undefined) => void) | undefined;
let chatViewReady: Promise<IChatViewProvider | undefined> | undefined;

function ensureReadyPromise(): Promise<IChatViewProvider | undefined> {
  if (!chatViewReady) {
    chatViewReady = new Promise((resolve) => {
      resolveChatViewReady = resolve;
    });
  }
  return chatViewReady;
}

export function setChatViewProvider(provider: IChatViewProvider | undefined): void {
  chatViewProvider = provider;
  if (provider) {
    ensureReadyPromise();
    resolveChatViewReady?.(provider);
  }
}

export function getChatViewProvider(): IChatViewProvider | undefined {
  return chatViewProvider;
}

/**
 * Resolves once the pro activation has set the provider (or immediately if
 * already set). Used by the synchronous webview shell in extension.ts so the
 * chat view registered at activation time can wait for the deferred
 * activatePro to finish. Resolves undefined after `timeoutMs`.
 */
export function whenChatViewProvider(timeoutMs = 15000): Promise<IChatViewProvider | undefined> {
  if (chatViewProvider) {
    return Promise.resolve(chatViewProvider);
  }
  return Promise.race([
    ensureReadyPromise(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
}

export function setAiService(service: any): void {
  aiServiceInstance = service;
}

export function getAiService(): any {
  return aiServiceInstance;
}
