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
