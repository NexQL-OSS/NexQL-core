import * as vscode from 'vscode';
import { PGSTUDIO_SQL_AGENT_ID } from './opencodeHeadlessEnv';
import { appendOpencodeLog } from './opencodeLog';
import type { OpencodeRunOptions, OpencodeRunResult } from './opencodeRunner';
import { resolveOpencodeWorkingDirectory } from './resolveOpencodeWorkingDirectory';

function splitProviderModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash >= model.length - 1) {
    return undefined;
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

function extractTextFromMessagePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const record = payload as Record<string, unknown>;
  const parts = (record.parts || (record.data as Record<string, unknown> | undefined)?.parts) as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim();
}

/**
 * Prompt the warm opencode serve instance over HTTP.
 * Avoids `opencode run --attach`, which fails with "Session not found" when --dir
 * does not match the server's project directory.
 */
export async function runViaServeHttp(
  serveUrl: string,
  config: vscode.WorkspaceConfiguration,
  options: OpencodeRunOptions,
): Promise<OpencodeRunResult> {
  const base = serveUrl.replace(/\/$/, '');
  const workDir = options.cwd || resolveOpencodeWorkingDirectory(config);
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId: string | undefined;
  const cancelRegistration = options.cancellationToken?.onCancellationRequested(() => {
    controller.abort();
    if (sessionId) {
      void fetch(`${base}/session/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
    }
  });

  appendOpencodeLog(`HTTP prompt via ${base} (cwd ${workDir})`);
  if (options.model) {
    appendOpencodeLog(`Model: ${options.model}`);
  }

  try {
    const sessionRes = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'NexQL SQL Assistant' }),
      signal: controller.signal,
    });
    if (!sessionRes.ok) {
      const detail = await sessionRes.text();
      throw new Error(`OpenCode session create failed (${sessionRes.status}): ${detail}`);
    }
    const session = (await sessionRes.json()) as { id?: string };
    sessionId = session.id;
    if (!sessionId) {
      throw new Error('OpenCode server returned a session without an id.');
    }
    appendOpencodeLog(`Session ${sessionId} created`);

    const modelParts = options.model ? splitProviderModel(options.model) : undefined;
    const messageBody: Record<string, unknown> = {
      parts: [{ type: 'text', text: options.prompt }],
      agent: PGSTUDIO_SQL_AGENT_ID,
    };
    if (modelParts) {
      messageBody.model = modelParts;
    }

    const messageRes = await fetch(`${base}/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messageBody),
      signal: controller.signal,
    });
    if (!messageRes.ok) {
      const detail = await messageRes.text();
      throw new Error(`OpenCode message failed (${messageRes.status}): ${detail}`);
    }

    const payload = await messageRes.json();
    const text = extractTextFromMessagePayload(payload);
    if (!text) {
      throw new Error('OpenCode server returned an empty response.');
    }

    appendOpencodeLog(`Response received (${text.length} chars)`);
    return { text, transport: 'cli', usage: `OpenCode HTTP ${base}` };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('AI request cancelled.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    cancelRegistration?.dispose();
  }
}
