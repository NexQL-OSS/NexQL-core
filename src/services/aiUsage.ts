// Shared accessor for the caller's monthly AI Chat Assistant allowance.
//
// The count is metered server-side (api/ai/chat) and read via GET-style POST to
// /api/ai/usage. Multiple surfaces show it — the status-bar tooltip (synchronous),
// the license quick-pick, and Settings → License — so we cache the last value and
// expose a throttled background refresh for the sync callers.

import * as vscode from 'vscode';

export interface AiUsage {
  used: number;
  limit: number;
  remaining: number;
  resetAt?: string;
}

let cached: AiUsage | null = null;
let lastFetch = 0;
let inFlight: Promise<AiUsage | null> | null = null;

/**
 * Remaining-quota ratio as a display percentage — raw token counts run into the
 * hundreds of thousands to millions, and "99.98% left" reads far easier than
 * "9,998,452/10,000,000 tokens left". The server (and `/api/ai/usage`) still track
 * and report the exact raw numbers; this is purely a display-side simplification.
 * Avoids showing "0%" for a small-but-nonzero remainder, which would misread as
 * fully exhausted.
 */
export function remainingPercentLabel(remaining: number, limit: number): string {
  if (!limit || limit <= 0) {
    return '0%';
  }
  const pct = (remaining / limit) * 100;
  if (pct <= 0) {
    return '0%';
  }
  if (pct < 0.1) {
    return '<0.1%';
  }
  if (pct >= 100) {
    return '100%';
  }
  // 2-decimal precision: at these token volumes (100k-10M), 1 decimal rounds a
  // barely-used quota (e.g. 99.98% remaining) up to a misleading flat "100%".
  return `${Math.round(pct * 100) / 100}%`;
}

/** Minimum spacing between background refreshes so tooltip re-renders don't spam the API. */
const MIN_REFRESH_MS = 15000;

/** Last known usage without a network round-trip (null until first successful fetch). */
export function getCachedAiUsage(): AiUsage | null {
  return cached;
}

import { refreshQuotaUI } from './QuotaService';

/** Force the next refresh to hit the network (call after a chat request completes). */
export function invalidateAiUsageCache(): void {
  cached = null;
  lastFetch = 0;
  void refreshQuotaUI();
}

/** Fetch current usage from the server, updating the cache. Returns null when unavailable. */
export async function fetchAiUsage(context: vscode.ExtensionContext): Promise<AiUsage | null> {
  try {
    const { AccountService } = await import('../features/sync/AccountService');
    const { httpRequest } = await import('../features/sync/providers/httpUtils');
    const { DEFAULT_SYNC_API_ENDPOINT } = await import('../features/sync/constants');

    const token = await AccountService.getInstance(context).ensureAiSession().catch(() => undefined);
    if (!token) {
      return null;
    }

    const res = await httpRequest(`${DEFAULT_SYNC_API_ENDPOINT.replace(/\/$/, '')}/ai/usage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    if (res.statusCode === 200) {
      const data = JSON.parse(res.body.toString());
      const limit = typeof data.limit === 'number' ? data.limit : 600_000;
      const usage: AiUsage = {
        used: typeof data.used === 'number' ? data.used : 0,
        limit,
        remaining: typeof data.remaining === 'number' ? data.remaining : limit,
        resetAt: typeof data.resetAt === 'string' ? data.resetAt : undefined,
      };
      cached = usage;
      lastFetch = Date.now();
      return usage;
    }
  } catch {
    // Silent — callers fall back to the cached value or a placeholder.
  }
  return null;
}

/**
 * Throttled fire-and-forget refresh for synchronous callers (status bar tooltip).
 * Invokes `onUpdate` only when a fetch actually lands, so the caller can re-render.
 */
export function refreshAiUsageInBackground(
  context: vscode.ExtensionContext,
  onUpdate?: (usage: AiUsage) => void,
): void {
  if (inFlight || Date.now() - lastFetch < MIN_REFRESH_MS) {
    return;
  }
  inFlight = fetchAiUsage(context).finally(() => {
    inFlight = null;
  });
  void inFlight.then((usage) => {
    if (usage && onUpdate) {
      onUpdate(usage);
    }
  });
}
