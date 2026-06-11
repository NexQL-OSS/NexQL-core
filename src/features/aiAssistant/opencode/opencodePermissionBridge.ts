import { appendOpencodeLog } from './opencodeLog';

type PermissionReply = 'once' | 'always' | 'reject';

interface PermissionRequest {
  id?: string;
  requestID?: string;
  sessionID?: string;
  permission?: string;
  patterns?: string[];
}

/**
 * Auto-approves OpenCode permission prompts while PgStudio waits on a headless run.
 * Needed because `opencode serve` + `--attach` handles permissions on the server side.
 */
export class OpencodePermissionBridge {
  private abortController: AbortController | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly approved = new Set<string>();

  start(serveUrl: string): void {
    this.stop();
    this.abortController = new AbortController();
    void this.consumeEventStream(serveUrl, this.abortController.signal);
    void this.flushPendingPermissions(serveUrl);
    this.pollTimer = setInterval(() => {
      void this.flushPendingPermissions(serveUrl);
    }, 750);
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async consumeEventStream(serveUrl: string, signal: AbortSignal): Promise<void> {
    const base = serveUrl.replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/event`, {
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      if (!response.ok || !response.body) {
        appendOpencodeLog(`Permission bridge: event stream unavailable (${response.status})`, 'stderr');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          this.handleSseChunk(serveUrl, chunk);
        }
      }
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      appendOpencodeLog(`Permission bridge stream ended: ${message}`, 'stderr');
    }
  }

  private handleSseChunk(serveUrl: string, chunk: string): void {
    const dataLines = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) {
      return;
    }

    const payload = dataLines.join('\n');
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      const type = typeof event.type === 'string' ? event.type : '';
      if (!type.includes('permission')) {
        return;
      }
      const properties = (event.properties || event) as PermissionRequest;
      const requestId = properties.requestID || properties.id;
      if (!requestId) {
        return;
      }
      void this.approve(serveUrl, requestId, properties);
    } catch {
      // ignore malformed SSE payloads
    }
  }

  private async flushPendingPermissions(serveUrl: string): Promise<void> {
    const base = serveUrl.replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/permission`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        return;
      }
      const pending = (await response.json()) as PermissionRequest[] | PermissionRequest;
      const list = Array.isArray(pending) ? pending : [pending];
      for (const item of list) {
        const requestId = item?.requestID || item?.id;
        if (requestId) {
          await this.approve(serveUrl, requestId, item);
        }
      }
    } catch {
      // server may not expose /permission on older builds
    }
  }

  private async approve(
    serveUrl: string,
    requestId: string,
    details: PermissionRequest,
  ): Promise<void> {
    if (this.approved.has(requestId)) {
      return;
    }
    this.approved.add(requestId);

    const base = serveUrl.replace(/\/$/, '');
    const label = [details.permission, ...(details.patterns || [])].filter(Boolean).join(' · ');
    appendOpencodeLog(`Auto-approving permission${label ? `: ${label}` : ''} (${requestId})`);

    const replies: PermissionReply[] = ['always', 'once'];
    for (const reply of replies) {
      const ok = await this.postReply(base, requestId, reply);
      if (ok) {
        return;
      }
    }

    // Legacy endpoint fallback
    if (details.sessionID) {
      await this.postLegacyReply(base, details.sessionID, requestId);
    }
  }

  private async postReply(
    base: string,
    requestId: string,
    response: PermissionReply,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${base}/permission/${encodeURIComponent(requestId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async postLegacyReply(
    base: string,
    sessionId: string,
    permissionId: string,
  ): Promise<void> {
    try {
      await fetch(
        `${base}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: 'always' }),
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch {
      // ignore
    }
  }
}
