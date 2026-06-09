import * as vscode from 'vscode';

/**
 * Lightweight diagnostic logging for the extension host.
 *
 * Replaces scattered `console.log` / `console.warn` calls that previously dumped
 * SQL, schema, and AI payloads straight to the Developer Tools console (a noise
 * and privacy concern). Verbose output is gated behind the
 * `postgresExplorer.debug` setting; warnings always land in a dedicated output
 * channel instead of the shared devtools console.
 */

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('NexQL Debug');
  }
  return channel;
}

function isDebugEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration().get<boolean>('postgresExplorer.debug', false);
  } catch {
    return false;
  }
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') {
        return a;
      }
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/** Verbose diagnostic line; written only when `postgresExplorer.debug` is enabled. */
export function debugLog(...args: unknown[]): void {
  if (!isDebugEnabled()) {
    return;
  }
  getChannel().appendLine(format(args));
}

/** Warning worth keeping; always written to the NexQL Debug output channel. */
export function debugWarn(...args: unknown[]): void {
  getChannel().appendLine('[warn] ' + format(args));
}
