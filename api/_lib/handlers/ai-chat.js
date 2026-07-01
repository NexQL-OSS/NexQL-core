// POST /api/ai/chat — free/managed AI Gateway proxy with per-user monthly metering.
//
// Client never holds the gateway key: this handler authenticates the caller
// (free OAuth or paid license session), enforces the monthly cap for their tier,
// and proxies to an upstream AI Gateway using a server-side key. Providers are tried
// in priority order — Vercel AI Gateway primary, Cloudflare AI Gateway failover — so
// when Vercel's monthly credit pool is spent (402) free users keep working. The
// response stays OpenAI-compatible SSE so the existing client parser
// (AiService._makeHttpRequest) works unchanged.

const https = require('https');
const { authenticateBearerRelaxed } = require('../sync-auth');
const {
  monthlyLimit,
  currentPeriod,
  nextResetIso,
  reserveUsage,
  refundUsage,
  pruneOldUsage,
  touchRate,
} = require('../ai-db');

// ── Cost guards ───────────────────────────────────────────────────────────────
// The managed key pays for every token, so a "request" must have a bounded cost.
// Output is capped per tier; input is capped by message count + total/per-message
// characters so a single free call can't smuggle a huge context and drain credits.
const TIER_MAX_TOKENS = { free: 1024, sponsor: 4096, singularity: 8192 };
const MAX_INPUT_MESSAGES = 40;
const MAX_INPUT_CHARS = 48000;   // ~12k tokens of total input across all messages
const MAX_MESSAGE_CHARS = 24000; // any single message is truncated to this

// ── Abuse guards ──────────────────────────────────────────────────────────────
// Coarse fixed-window throttles on top of the monthly cap (defence against bursts
// and scripted Sybil accounts). Tunable via env; 0 disables a given limit.
const RATE_WINDOW_SEC = Number(process.env.AI_RATE_WINDOW_SEC || 60);
const RATE_PER_ACCOUNT = Number(process.env.AI_RATE_PER_ACCOUNT || 20);
const RATE_PER_IP = Number(process.env.AI_RATE_PER_IP || 40);

function tierMaxTokens(tier) {
  return TIER_MAX_TOKENS[tier] ?? TIER_MAX_TOKENS.free;
}

/** Number of characters a message's content contributes (string or multipart array). */
function messageChars(content) {
  if (typeof content === 'string') {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((n, part) => n + (typeof part?.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
}

/** Truncate a string content to `MAX_MESSAGE_CHARS`; multipart arrays are left intact. */
function clampMessageContent(content) {
  if (typeof content === 'string' && content.length > MAX_MESSAGE_CHARS) {
    return content.slice(0, MAX_MESSAGE_CHARS) + '\n…(truncated)';
  }
  return content;
}

/**
 * Bound the input to keep a single call's cost sane: drop oldest non-system turns
 * over the message-count / total-character budget, and truncate any oversized
 * message. Leading system messages are always preserved.
 */
function clampMessages(messages) {
  const clamped = messages.map((m) => ({ role: m.role, content: clampMessageContent(m.content) }));

  const leadingSystem = [];
  let rest = clamped;
  while (rest.length && rest[0].role === 'system') {
    leadingSystem.push(rest[0]);
    rest = rest.slice(1);
  }

  // Trim oldest turns until within the message-count budget.
  const maxRest = Math.max(1, MAX_INPUT_MESSAGES - leadingSystem.length);
  if (rest.length > maxRest) {
    rest = rest.slice(rest.length - maxRest);
  }

  // Trim oldest turns until within the total-character budget (system stays).
  let total = [...leadingSystem, ...rest].reduce((n, m) => n + messageChars(m.content), 0);
  while (rest.length > 1 && total > MAX_INPUT_CHARS) {
    const removed = rest.shift();
    total -= messageChars(removed.content);
  }

  return [...leadingSystem, ...rest];
}

// Curated, cheap models behind an "insider" alias per license tier. Client-supplied
// `model` is only ever one of these three alias keys — this allowlist is the only
// thing that ever reaches a gateway, so the free key can't be pointed at an
// arbitrary/expensive model. Real vendor/model strings never reach the client.
const TIER_RANK = { free: 0, sponsor: 1, singularity: 2 };
const DEFAULT_ALIAS = 'smart';

// Minimum license tier required to use each alias. Provider-independent: the gate is
// applied to whichever upstream provider's model chain we end up dispatching to.
const ALIAS_MIN_TIER = { smart: 'free', engineer: 'sponsor', architect: 'singularity' };

function fallbackList(envVar, defaults) {
  const raw = process.env[envVar];
  if (!raw) {
    return defaults;
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Build a [primary, ...fallbacks] model chain from env with sane defaults. */
function modelChain(primaryEnv, primaryDefault, fallbackEnv, fallbackDefaults) {
  return [process.env[primaryEnv] || primaryDefault, ...fallbackList(fallbackEnv, fallbackDefaults)];
}

// Ordered upstream providers. Vercel AI Gateway is primary; Cloudflare AI Gateway is
// appended as failover only when fully configured. When a provider returns 402 (its
// credit pool is spent) the dispatch loop advances to the next provider instead of
// giving up — so free users keep working after Vercel's monthly credit runs out.
// Both speak the OpenAI-compatible /chat/completions (SSE) protocol, so the response
// shape is identical regardless of which provider served the request.
function buildProviders() {
  const providers = [];

  if (process.env.AI_GATEWAY_API_KEY) {
    providers.push({
      name: 'vercel',
      host: 'ai-gateway.vercel.sh',
      path: '/v1/chat/completions',
      apiKey: process.env.AI_GATEWAY_API_KEY,
      extraHeaders: {},
      tiers: {
        smart: modelChain('AI_MODEL_SMART', 'alibaba/qwen-3-235b', 'AI_MODEL_SMART_FALLBACK', ['mistral/ministral-3b', 'meta/llama-3.2-11b']),
        engineer: modelChain('AI_MODEL_ENGINEER', 'deepseek/deepseek-v3', 'AI_MODEL_ENGINEER_FALLBACK', ['mistral/codestral', 'mimo-v2.5-pro', 'openai/gpt-oss-120b']),
        architect: modelChain('AI_MODEL_ARCHITECT', 'anthropic/claude-3.5-haiku', 'AI_MODEL_ARCHITECT_FALLBACK', ['minimax/minimax-m3', 'google/gemma-4-31b', 'openai/gpt-5.4-nano']),
      },
    });
  }

  // Cloudflare AI Gateway failover: only enabled when account, gateway, and token
  // are all present. The OpenAI-compatible endpoint is path-based per account/gateway.
  const cfAccount = process.env.CF_ACCOUNT_ID;
  const cfGateway = process.env.CF_GATEWAY_ID;
  const cfToken = process.env.CF_AI_GATEWAY_TOKEN;
  if (cfAccount && cfGateway && cfToken) {
    const extraHeaders = {};
    // Authenticated CF gateways additionally require a cf-aig-authorization header.
    if (process.env.CF_AIG_AUTH) {
      extraHeaders['cf-aig-authorization'] = `Bearer ${process.env.CF_AIG_AUTH}`;
    }
    providers.push({
      name: 'cloudflare',
      host: 'gateway.ai.cloudflare.com',
      path: `/v1/${cfAccount}/${cfGateway}/compat/chat/completions`,
      apiKey: cfToken,
      extraHeaders,
      tiers: {
        smart: modelChain('CF_AI_MODEL_SMART', 'mistral/ministral-3b', 'CF_AI_MODEL_SMART_FALLBACK', ['workers-ai/@cf/meta/llama-3.1-8b-instruct']),
        engineer: modelChain('CF_AI_MODEL_ENGINEER', 'deepseek/deepseek-chat', 'CF_AI_MODEL_ENGINEER_FALLBACK', ['mistral/codestral-latest']),
        architect: modelChain('CF_AI_MODEL_ARCHITECT', 'anthropic/claude-3-5-haiku-20241022', 'CF_AI_MODEL_ARCHITECT_FALLBACK', ['openai/gpt-4o-mini']),
      },
    });
  }

  return providers;
}

const PROVIDERS = buildProviders();

/** Resolve the client-supplied alias to a known alias key, defaulting to Smart. */
function resolveAlias(requestedModel) {
  if (typeof requestedModel === 'string' && Object.prototype.hasOwnProperty.call(ALIAS_MIN_TIER, requestedModel)) {
    return requestedModel;
  }
  return DEFAULT_ALIAS;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .filter((m) => m && typeof m.role === 'string' && (typeof m.content === 'string' || Array.isArray(m.content)))
    .map((m) => ({ role: m.role, content: m.content }));
}

/** POST one model attempt to a provider's gateway; resolves once the upstream status line is known. */
function requestGateway(provider, model, messages, temperature, maxTokens) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true });
    const req = https.request(
      {
        hostname: provider.host,
        path: provider.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
          ...provider.extraHeaders,
        },
      },
      (res) => resolve({ res, req }),
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Buffer a non-200 gateway response body for logging/error-mapping. */
function readBody(res) {
  return new Promise((resolve) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve(data));
  });
}

/** Buffer an SSE gateway response and concatenate the streamed delta text into one string. */
function collectSseText(res) {
  return new Promise((resolve) => {
    let buffer = '';
    let text = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf('\n');
        if (line.startsWith('data:')) {
          const dataVal = line.slice(5).trim();
          if (dataVal === '[DONE]') {
            continue;
          }
          try {
            const parsed = JSON.parse(dataVal);
            text += parsed.choices?.[0]?.delta?.content || '';
          } catch {
            // ignore partial/meta lines
          }
        }
      }
    });
    res.on('end', () => resolve(text));
    res.on('error', () => resolve(text));
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (process.env.AI_FREE_ENABLED === 'false') {
    return res.status(503).json({ error: 'free_ai_disabled' });
  }

  if (PROVIDERS.length === 0) {
    console.error('ai/chat: no upstream provider configured (AI_GATEWAY_API_KEY / CF_* missing)');
    return res.status(503).json({ error: 'free_ai_disabled' });
  }

  let auth;
  try {
    auth = await authenticateBearerRelaxed(req);
  } catch (err) {
    console.error('ai/chat auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tier = auth.tier || 'free';
  const limit = monthlyLimit(tier);
  const period = currentPeriod();

  // Burst / Sybil throttle (per account, then per client IP) before we touch the
  // monthly counter or a provider. Best-effort: a store hiccup must not block chat.
  try {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || 'unknown';
    if (RATE_PER_ACCOUNT > 0) {
      const acct = await touchRate(`acct:${auth.account_id}`, RATE_PER_ACCOUNT, RATE_WINDOW_SEC);
      if (!acct.ok) {
        return res.status(429).json({ error: 'rate_limited', retryAfterSec: RATE_WINDOW_SEC });
      }
    }
    if (RATE_PER_IP > 0) {
      const perIp = await touchRate(`ip:${ip}`, RATE_PER_IP, RATE_WINDOW_SEC);
      if (!perIp.ok) {
        return res.status(429).json({ error: 'rate_limited', retryAfterSec: RATE_WINDOW_SEC });
      }
    }
  } catch (err) {
    console.error('ai/chat: rate check failed (allowing)', err);
  }

  const alias = resolveAlias((req.body || {}).model);
  const requiredTier = ALIAS_MIN_TIER[alias];
  if (TIER_RANK[tier] < TIER_RANK[requiredTier]) {
    return res.status(403).json({
      error: 'tier_required',
      alias,
      requiredTier,
    });
  }

  // Atomically reserve one request against the monthly cap *before* dispatching, so
  // concurrent calls can't race past a read-then-increment gate. Refunded below on
  // any dispatch failure / empty / client-abort so only delivered replies are billed.
  let reservation;
  try {
    reservation = await reserveUsage(auth.account_id, period, limit);
  } catch (err) {
    console.error('ai/chat: usage reserve failed', err);
    return res.status(500).json({ error: 'Usage lookup failed' });
  }
  if (!reservation.ok) {
    return res.status(429).json({
      error: 'quota_exceeded',
      tier,
      limit,
      resetAt: nextResetIso(),
    });
  }

  let released = false;
  const release = async (reason) => {
    if (released) {
      return;
    }
    released = true;
    try {
      await refundUsage(auth.account_id, period);
    } catch (err) {
      console.error(`ai/chat: refund failed (${reason})`, err);
    }
  };

  const messages = clampMessages(sanitizeMessages((req.body || {}).messages));
  const rawTemp = typeof req.body?.temperature === 'number' ? req.body.temperature : 0.7;
  const temperature = Math.max(0, Math.min(2, rawTemp));
  const maxTokens = tierMaxTokens(tier);

  // Dispatch: providers in priority order (Vercel → Cloudflare), each with its own
  // model fallback chain. A 402 exhausts that provider's credit pool, so we stop
  // trying its remaining models and advance to the next provider.
  let upstream;
  let lastErr;
  outer: for (const provider of PROVIDERS) {
    for (const model of provider.tiers[alias]) {
      try {
        const attempt = await requestGateway(provider, model, messages, temperature, maxTokens);
        if (attempt.res.statusCode === 200) {
          upstream = attempt;
          break outer;
        }
        const body = await readBody(attempt.res);
        lastErr = { status: attempt.res.statusCode, body, provider: provider.name };
        // 402 = this provider's credit pool is spent; skip its remaining models and
        // fail over to the next provider.
        if (attempt.res.statusCode === 402) {
          break;
        }
      } catch (err) {
        lastErr = { status: 0, body: err instanceof Error ? err.message : String(err), provider: provider.name };
      }
    }
  }

  if (!upstream) {
    await release('gateway_unavailable');
    console.error('ai/chat: gateway request failed', lastErr);
    if (lastErr && lastErr.status === 402) {
      return res.status(402).json({ error: 'pool_exhausted' });
    }
    return res.status(502).json({ error: 'gateway_unavailable' });
  }

  // Opportunistic retention (Neon only; low probability to avoid per-request cost).
  if (Math.random() < 0.02) {
    void pruneOldUsage().catch(() => {});
  }

  const wantStream = (req.body || {}).stream === true;

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let delivered = false;
    let clientAborted = false;
    let finished = false;
    // Client hung up mid-stream: abort the upstream request so the gateway stops
    // generating (and billing) tokens we can no longer deliver.
    const onClientClose = () => {
      if (finished) {
        return;
      }
      clientAborted = true;
      try { upstream.req.destroy(); } catch { /* already closed */ }
      try { upstream.res.destroy(); } catch { /* already closed */ }
    };
    res.on('close', onClientClose);

    await new Promise((resolve) => {
      upstream.res.on('data', (chunk) => {
        delivered = true;
        res.write(chunk);
      });
      upstream.res.on('end', () => {
        finished = true;
        resolve();
      });
      upstream.res.on('error', (err) => {
        if (!clientAborted) {
          console.error('ai/chat: gateway stream error', err);
        }
        resolve();
      });
    });
    res.off('close', onClientClose);
    // Only a delivered, non-aborted reply is billable.
    if (clientAborted || !delivered) {
      await release(clientAborted ? 'client_aborted' : 'empty_stream');
    }
    res.end();
  } else {
    // Caller didn't request SSE — buffer the upstream stream and reply with a
    // single OpenAI-compatible JSON object instead (matches how real providers
    // behave when `stream` is omitted, so AiService's non-streaming JSON.parse
    // path never sees raw "data: {...}" text).
    const content = await collectSseText(upstream.res);
    if (!content) {
      await release('empty_response');
    }
    res.status(200).json({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    });
  }
};
