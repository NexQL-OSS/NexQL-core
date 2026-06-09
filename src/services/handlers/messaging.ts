import * as vscode from 'vscode';
import { debugWarn } from '../../common/logger';

interface SafePostMessageOptions {
  contextLabel: string;
  notifyOnFailure?: boolean;
}

export interface HandlerResponseEnvelope<T = unknown> {
  ok: boolean;
  code: string;
  remediation?: string;
  data?: T;
  error?: string;
}

export function okResponse<T>(
  code: string,
  data?: T,
  remediation?: string,
): HandlerResponseEnvelope<T> {
  return { ok: true, code, data, ...(remediation ? { remediation } : {}) };
}

export function errorResponse(
  code: string,
  error: string,
  remediation?: string,
): HandlerResponseEnvelope {
  return { ok: false, code, error, ...(remediation ? { remediation } : {}) };
}

/**
 * Sends a message to the webview and guards against closed/disposed panels.
 * Returns true only when the message was delivered successfully.
 */
export async function safelyPostMessage(
  postMessage: ((message: any) => Thenable<boolean>) | undefined,
  message: any,
  options: SafePostMessageOptions,
): Promise<boolean> {
  if (!postMessage) {
    return false;
  }

  try {
    const delivered = await postMessage(message);
    if (!delivered) {
      debugWarn(`[${options.contextLabel}] postMessage returned false; webview may be closed.`);
      if (options.notifyOnFailure) {
        await vscode.window.showWarningMessage(
          `${options.contextLabel}: could not deliver update to the result view.`,
        );
      }
    }
    return delivered;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${options.contextLabel}] postMessage failed:`, err);
    if (options.notifyOnFailure) {
      await vscode.window.showWarningMessage(
        `${options.contextLabel}: failed to notify the result view (${errorMessage}).`,
      );
    }
    return false;
  }
}
