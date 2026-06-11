import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('OpenCode');
  }
  return channel;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function appendOpencodeLog(message: string, stream: 'info' | 'stdout' | 'stderr' = 'info'): void {
  const prefix = stream === 'info' ? '' : `[${stream}] `;
  for (const line of stripAnsi(message).split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }
    getChannel().appendLine(`${timestamp()} ${prefix}${trimmed}`);
  }
}

export function showOpencodeLog(preserveFocus = true): void {
  getChannel().show(preserveFocus);
}

export function summarizeOpencodeJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    const type = typeof event.type === 'string' ? event.type : undefined;
    if (type === 'text' && typeof event.text === 'string') {
      return event.text;
    }
    const part = event.part as Record<string, unknown> | undefined;
    if (part?.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }
    if (type) {
      const detail =
        typeof event.name === 'string'
          ? event.name
          : typeof event.tool === 'string'
            ? event.tool
            : typeof event.status === 'string'
              ? event.status
              : '';
      return detail ? `[${type}] ${detail}` : `[${type}]`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
