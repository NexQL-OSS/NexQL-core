import * as vscode from 'vscode';
import { NexqlCoreApi } from './api';

/**
 * activatePro stub for free builds.
 * This is a no-op fallback when Pro package is not loaded.
 */
export async function activatePro(
  coreApi: NexqlCoreApi,
  context: vscode.ExtensionContext,
): Promise<void> {
  // No-op fallback
  coreApi.outputChannel.appendLine('Pro features not activated (free build).');
}

/**
 * initializeSyncEngineEarly stub for free builds. The real implementation
 * (packages/pro) starts the Cloud Sync engine synchronously during
 * activation, ahead of the deferred activatePro — never called here since
 * extension.ts only reaches this behind an isProBuild() guard, but the
 * export must exist so both builds resolve the same @nexql/pro surface.
 */
export async function initializeSyncEngineEarly(
  _context: vscode.ExtensionContext,
  _outputChannel: vscode.OutputChannel,
  _syncStatusBar: unknown,
): Promise<{ onDidCompleteSync: vscode.Event<void>; dispose(): void } | undefined> {
  return undefined;
}
