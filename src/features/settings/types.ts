import * as vscode from 'vscode';

/** Shared host-side context handed to every Settings Hub section handler. */
export interface SettingsHubHostContext {
  extensionContext: vscode.ExtensionContext;
  /** Post a `{ type: '<section>/<event>', ... }` message to the webview. */
  post(message: Record<string, unknown>): void;
}

/** Inbound webview message: `{ command: '<section>/<action>', ...payload }`. */
export interface SettingsHubMessage {
  command: string;
  [key: string]: unknown;
}

export interface SettingsSectionHandler {
  /** Section prefix this handler owns (e.g. `connections`). */
  readonly section: string;
  handle(action: string, message: SettingsHubMessage): Promise<void>;
}
