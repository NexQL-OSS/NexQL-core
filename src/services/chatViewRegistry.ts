import type { IChatViewProvider } from '../pro/api';

/**
 * Holds the active chat view provider so features can reach the SQL Assistant
 * without importing extension.ts (which imports them back — a require cycle).
 * Set during activation; undefined in builds without the chat feature.
 * Uses the core-owned IChatViewProvider interface — never imports the concrete class.
 */
let chatViewProvider: IChatViewProvider | undefined;
let aiServiceInstance: any | undefined;

export function setChatViewProvider(provider: IChatViewProvider | undefined): void {
  chatViewProvider = provider;
}

export function getChatViewProvider(): IChatViewProvider | undefined {
  return chatViewProvider;
}

export function setAiService(service: any): void {
  aiServiceInstance = service;
}

export function getAiService(): any {
  return aiServiceInstance;
}
