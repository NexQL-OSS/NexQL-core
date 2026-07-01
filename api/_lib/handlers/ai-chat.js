// POST /api/ai/chat — free/managed AI Gateway proxy with per-user monthly metering.
//
// Client never holds the gateway key: this handler authenticates the caller
// (free OAuth or paid license session), enforces the monthly cap for their tier,
// and proxies to Vercel AI Gateway using a server-side key. The response stays
// OpenAI-compatible SSE so the existing client parser (AiService._makeHttpRequest)
// works unchanged.

const https = require('https');
const { authenticateBearerRelaxed } = require('../sync-auth');
const { monthlyLimit, currentPeriod, nextResetIso, readUsage, incrementUsage } = require('../ai-db');

const GATEWAY_HOST = 'ai-gateway.vercel.sh';
const GATEWAY_PATH = '/v1/chat/completions';

// Curated, cheap models behind an "insider" alias per license tier. Client-supplied
// `model` is only ever one of these three alias keys — this allowlist is the only
// thing that ever reaches the gateway, so the free key can't be pointed at an
// arbitrary/expensive model. Real vendor/model strings never reach the client.
const TIER_RANK = { free: 0, sponsor: 1, singularity: 2 };
const DEFAULT_ALIAS = 'smart';

function fallbackList(envVar, defaults) {
  const raw = process.env[envVar];
  if (!raw) {
    return defaults;
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const MODEL_TIERS = {
  smart: {
    minTier: 'free',
    chain: [
      process.env.AI_MODEL_SMART || 'alibaba/qwen-3-235b',
      ...fallbackList('AI_MODEL_SMART_FALLBACK', ['mistral/ministral-3b', 'meta/llama-3.2-11b']),
    ],
  },
  engineer: {
    minTier: 'sponsor',
    chain: [
      process.env.AI_MODEL_ENGINEER || 'deepseek/deepseek-v3',
      ...fallbackList('AI_MODEL_ENGINEER_FALLBACK', ['mistral/codestral', 'mimo-v2.5-pro', 'openai/gpt-oss-120b']),
    ],
  },
  architect: {
    minTier: 'singularity',
    chain: [
      process.env.AI_MODEL_ARCHITECT || 'anthropic/claude-3.5-haiku',
      ...fallbackList('AI_MODEL_ARCHITECT_FALLBACK', ['minimax/minimax-m3', 'google/gemma-4-31b', 'openai/gpt-5.4-nano']),
    ],
  },
};

/** Resolve the client-supplied alias to a known tier entry, defaulting to Smart. */
function resolveAlias(requestedModel) {
  if (typeof requestedModel === 'string' && Object.prototype.hasOwnProperty.call(MODEL_TIERS, requestedModel)) {
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

/** POST one model attempt to the gateway; resolves once the upstream status line is known. */
function requestGateway(model, messages, temperature, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, temperature, stream: true });
    const req = https.request(
      {
        hostname: GATEWAY_HOST,
        path: GATEWAY_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
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

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.error('ai/chat: AI_GATEWAY_API_KEY is not configured');
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

  let used;
  try {
    used = await readUsage(auth.account_id, period);
  } catch (err) {
    console.error('ai/chat usage read:', err);
    return res.status(500).json({ error: 'Usage lookup failed' });
  }

  if (used >= limit) {
    return res.status(429).json({
      error: 'quota_exceeded',
      tier,
      limit,
      resetAt: nextResetIso(),
    });
  }

  const alias = resolveAlias((req.body || {}).model);
  const tierEntry = MODEL_TIERS[alias];
  if (TIER_RANK[tier] < TIER_RANK[tierEntry.minTier]) {
    return res.status(403).json({
      error: 'tier_required',
      alias,
      requiredTier: tierEntry.minTier,
    });
  }

  const messages = sanitizeMessages((req.body || {}).messages);
  const temperature = typeof req.body?.temperature === 'number' ? req.body.temperature : 0.7;

  let upstream;
  let lastErr;
  for (const model of tierEntry.chain) {
    try {
      const attempt = await requestGateway(model, messages, temperature, apiKey);
      if (attempt.res.statusCode === 200) {
        upstream = attempt;
        break;
      }
      const body = await readBody(attempt.res);
      lastErr = { status: attempt.res.statusCode, body };
      // 402 (credit exhausted) is a pool-wide condition — no point trying another model.
      if (attempt.res.statusCode === 402) {
        break;
      }
    } catch (err) {
      lastErr = { status: 0, body: err instanceof Error ? err.message : String(err) };
    }
  }

  if (!upstream) {
    console.error('ai/chat: gateway request failed', lastErr);
    if (lastErr && lastErr.status === 402) {
      return res.status(402).json({ error: 'pool_exhausted' });
    }
    return res.status(502).json({ error: 'gateway_unavailable' });
  }

  const wantStream = (req.body || {}).stream === true;

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    await new Promise((resolve) => {
      upstream.res.on('data', (chunk) => res.write(chunk));
      upstream.res.on('end', resolve);
      upstream.res.on('error', (err) => {
        console.error('ai/chat: gateway stream error', err);
        resolve();
      });
    });
    res.end();
  } else {
    // Caller didn't request SSE — buffer the upstream stream and reply with a
    // single OpenAI-compatible JSON object instead (matches how real providers
    // behave when `stream` is omitted, so AiService's non-streaming JSON.parse
    // path never sees raw "data: {...}" text).
    const content = await collectSseText(upstream.res);
    res.status(200).json({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    });
  }

  try {
    await incrementUsage(auth.account_id, period);
  } catch (err) {
    console.error('ai/chat: usage increment failed', err);
  }
};
