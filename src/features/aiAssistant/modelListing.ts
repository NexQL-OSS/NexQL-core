import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import type { LicenseTier } from '../../services/LicenseService';
import { meetsTier } from '../../services/featureGates';

const GITHUB_MODELS_SCOPES: string[] = [];

/** Insider alias shown to the user; the real vendor/model is only known server-side. */
export interface NexqlFreeModelEntry {
  id: 'smart' | 'engineer' | 'architect';
  displayName: string;
  locked: boolean;
}

const NEXQL_FREE_MIN_TIER: Record<NexqlFreeModelEntry['id'], LicenseTier> = {
  smart: 'free',
  engineer: 'sponsor',
  architect: 'singularity',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The NexQL free proxy always exposes all three masked tiers (for upsell
 * visibility) but marks the ones above the caller's license tier as locked —
 * the server enforces the same gate on the actual request.
 */
export function listNexqlFreeModels(currentTier: LicenseTier): NexqlFreeModelEntry[] {
  return (Object.keys(NEXQL_FREE_MIN_TIER) as NexqlFreeModelEntry['id'][]).map((id) => {
    const locked = !meetsTier(currentTier, NEXQL_FREE_MIN_TIER[id]);
    return { id, displayName: `${capitalize(id)}${locked ? ' (Pro)' : ''}`, locked };
  });
}

export async function listOpenAIModels(apiKey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/models',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const chatModels = data.data
              .filter((m: { id: string }) => m.id.startsWith('gpt-'))
              .map((m: { id: string }) => m.id)
              .sort()
              .reverse();
            resolve(chatModels);
          } catch {
            reject(new Error('Failed to parse models response'));
          }
        } else {
          reject(new Error(`Failed to list models: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            let list: unknown[] = [];
            if (Array.isArray(data)) {
              list = data;
            } else if (Array.isArray(data.models)) {
              list = data.models;
            } else if (Array.isArray(data.data)) {
              list = data.data;
            } else {
              for (const k of Object.keys(data)) {
                if (Array.isArray((data as Record<string, unknown>)[k])) {
                  list = (data as Record<string, unknown[]>)[k];
                  break;
                }
              }
            }

            const models = list
              .map((m: unknown) => {
                if (typeof m === 'string') {
                  return m;
                }
                const row = m as { id?: string; name?: string; model?: string };
                return row.id || row.name || row.model;
              })
              .filter(Boolean)
              .sort() as string[];

            resolve(models);
          } catch {
            reject(new Error('Failed to parse Anthropic models response'));
          }
        } else {
          reject(new Error(`Failed to list Anthropic models: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models?key=${apiKey}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const models = data.models
              .filter((m: { supportedGenerationMethods?: string[] }) =>
                m.supportedGenerationMethods?.includes('generateContent'),
              )
              .map((m: { name: string }) => m.name.replace('models/', ''))
              .sort();
            resolve(models);
          } catch {
            reject(new Error('Failed to parse models response'));
          }
        } else {
          reject(new Error(`Failed to list models: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

const LOCAL_MODEL_LIST_TIMEOUT_MS = 5_000;

export async function listCustomModels(endpoint: string, apiKey: string): Promise<string[]> {
  return new Promise((resolve) => {
    const finish = (models: string[]) => resolve(models);

    try {
      const url = new URL(endpoint);
      const modelsPath = url.pathname.replace(/\/chat\/completions$/, '') + '/models';

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: modelsPath,
        method: 'GET',
        headers: apiKey
          ? {
              Authorization: `Bearer ${apiKey}`,
            }
          : {},
      };

      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              const models = data.data?.map((m: { id: string }) => m.id) || [];
              finish(models);
            } catch {
              finish(['custom-model']);
            }
          } else {
            finish(['custom-model']);
          }
        });
      });

      req.setTimeout(LOCAL_MODEL_LIST_TIMEOUT_MS, () => {
        req.destroy();
        finish(['custom-model']);
      });
      req.on('error', () => finish(['custom-model']));
      req.end();
    } catch {
      finish(['custom-model']);
    }
  });
}

/** Shared helper: fetch GET /v1/models from any OpenAI-compatible host with Bearer auth. */
function listOpenAiCompatibleModels(
  hostname: string,
  apiKey: string,
  filter?: (id: string) => boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path: '/v1/models',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            let models: string[] = (data.data ?? [])
              .map((m: { id: string }) => m.id)
              .filter(Boolean);
            if (filter) {
              models = models.filter(filter);
            }
            resolve(models.sort());
          } catch {
            reject(new Error('Failed to parse models response'));
          }
        } else {
          reject(new Error(`Failed to list models: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** List DeepSeek chat models (platform.deepseek.com — OpenAI-compatible). */
export function listDeepSeekModels(apiKey: string): Promise<string[]> {
  return listOpenAiCompatibleModels('api.deepseek.com', apiKey, (id) =>
    id.startsWith('deepseek-'),
  );
}

/** List Moonshot / Kimi models (platform.moonshot.cn — OpenAI-compatible). */
export function listMoonshotModels(apiKey: string): Promise<string[]> {
  return listOpenAiCompatibleModels('api.moonshot.cn', apiKey, (id) =>
    id.startsWith('moonshot-'),
  );
}

/** List Mistral AI models (api.mistral.ai — OpenAI-compatible). */
export function listMistralModels(apiKey: string): Promise<string[]> {
  // Mistral returns chat-capable models; exclude embedding-only ones
  return listOpenAiCompatibleModels('api.mistral.ai', apiKey, (id) =>
    !id.includes('embed'),
  );
}


export interface VsCodeLanguageModelEntry {
  id: string;
  displayName: string;
}

/** Display label for settings UI; persisted model should use {@link VsCodeLanguageModelEntry.id}. */
export function formatVsCodeLanguageModelLabel(m: vscode.LanguageModelChat): string {
  const name = m.name || m.id;
  const family = m.family;
  return family && family !== name ? `${name} (${family})` : name;
}

/**
 * Parse postgresExplorer ai.*.model values for vscode-lm.
 * Supports legacy "Display (family)" strings and current model ids.
 */
export function parseVsCodeLmModelSetting(configured: string): string[] {
  const trimmed = configured.trim();
  if (!trimmed) {
    return [];
  }
  const candidates = new Set<string>([trimmed]);
  let rest = trimmed;
  for (;;) {
    const match = rest.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (!match) {
      break;
    }
    const inner = match[1].trim();
    const segment = match[2].trim();
    if (segment) {
      candidates.add(segment);
    }
    if (inner) {
      candidates.add(inner);
    }
    rest = inner;
  }
  return [...candidates];
}

export function matchVsCodeLanguageModels(
  configured: string | undefined,
  allModels: vscode.LanguageModelChat[],
): vscode.LanguageModelChat[] {
  if (!configured?.trim()) {
    return [];
  }
  const candidates = parseVsCodeLmModelSetting(configured);
  const candidateSet = new Set(candidates);
  const candidateLower = new Set(candidates.map((c) => c.toLowerCase()));
  return allModels.filter((m) => {
    const fields = [m.id, m.name, m.family].filter((f): f is string => Boolean(f));
    return fields.some(
      (f) => candidateSet.has(f) || candidateLower.has(f.toLowerCase()),
    );
  });
}

/** Resolve the configured VS Code LM; never silently pick another model. */
export async function resolveVsCodeLanguageModel(
  configured: string | undefined,
): Promise<vscode.LanguageModelChat | undefined> {
  if (!configured?.trim()) {
    return undefined;
  }

  const candidates = parseVsCodeLmModelSetting(configured);
  for (const candidate of candidates) {
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(candidate)) {
      const byId = await vscode.lm.selectChatModels({ id: candidate });
      if (byId.length > 0) {
        return byId[0];
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.includes('.')) {
      const byFamily = await vscode.lm.selectChatModels({ family: candidate });
      if (byFamily.length > 0) {
        return byFamily[0];
      }
    }
  }

  const allModels = await vscode.lm.selectChatModels({});
  const matched = matchVsCodeLanguageModels(configured, allModels);
  return matched[0];
}

export async function listVsCodeLanguageModels(): Promise<VsCodeLanguageModelEntry[]> {
  const availableModels = await vscode.lm.selectChatModels();
  return availableModels.map((m) => ({
    id: m.id,
    displayName: formatVsCodeLanguageModelLabel(m),
  }));
}

export async function getGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession('github', GITHUB_MODELS_SCOPES, {
      silent: true,
      clearSessionPreference: false,
    });
  } catch {
    return undefined;
  }
}

const GITHUB_MODELS_API_VERSION = '2026-03-10';

export async function listGitHubModels(accessToken: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'models.github.ai',
      path: '/catalog/models',
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const models = Array.isArray(data)
              ? data
                  .filter(
                    (model: { supported_output_modalities?: string[] }) =>
                      model.supported_output_modalities?.includes('text') ?? true,
                  )
                  .map((model: { id: string }) => model.id)
                  .filter(Boolean)
                  .sort()
              : [];
            resolve(models);
          } catch {
            reject(new Error('Failed to parse GitHub Models catalog response'));
          }
        } else {
          reject(new Error(`Failed to list GitHub Models: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

export async function listCursorModels(
  apiKey: string,
): Promise<Array<{ id: string; displayName?: string }>> {
  const { Cursor } = await import('@cursor/sdk');
  const resolvedApiKey = apiKey || process.env.CURSOR_API_KEY || '';
  const models = await Cursor.models.list({ apiKey: resolvedApiKey });

  return (models || [])
    .map((model: { id: string; displayName?: string }) => ({
      id: model.id,
      displayName: model.displayName || model.id,
    }))
    .filter((model: { id: string }) => !!model.id)
    .sort((left, right) => left.id.localeCompare(right.id));
}
