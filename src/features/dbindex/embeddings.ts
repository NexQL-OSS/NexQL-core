import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { AiCredentialsService } from '../aiAssistant/AiCredentialsService';
import { EmbeddingMetaEntry } from './types';

/**
 * Computes cosine similarity between two numeric vectors of equal length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generate embedding vector using the user's active configuration & credential keys.
 */
export async function generateEmbedding(
  text: string,
  config: vscode.WorkspaceConfiguration
): Promise<{ vector: number[]; model: string }> {
  const provider = config.get<string>('postgresExplorer.aiProvider', 'vscode-lm');

  if (provider === 'vscode-lm' || provider === 'cursor' || provider === 'opencode') {
    throw new Error(`Provider "${provider}" does not support local embedding creation.`);
  }

  const credentials = AiCredentialsService.getInstance();
  const apiKey = await credentials.getApiKey(provider as any);

  if (!apiKey && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'custom') {
    throw new Error(`API key is required for embedding provider "${provider}"`);
  }

  let endpoint = '';
  let model = '';
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  let body: any = {};

  if (provider === 'openai') {
    endpoint = 'https://api.openai.com/v1/embeddings';
    model = 'text-embedding-3-small';
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = { input: text, model };
  } else if (provider === 'gemini') {
    model = 'text-embedding-004';
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
    body = { content: { parts: [{ text }] } };
  } else if (provider === 'ollama') {
    model = config.get<string>('postgresExplorer.aiModel', 'nomic-embed-text');
    const ollamaUrl = config.get<string>('postgresExplorer.ollamaUrl', 'http://localhost:11434').replace(/\/$/, '');
    endpoint = `${ollamaUrl}/api/embeddings`;
    body = { model, prompt: text };
  } else if (provider === 'lmstudio') {
    endpoint = 'http://localhost:1234/v1/embeddings';
    model = config.get<string>('postgresExplorer.aiModel', 'text-embedding-3-small');
    body = { input: text, model };
  } else if (provider === 'custom') {
    endpoint = config.get<string>('postgresExplorer.customEndpoint', '').replace(/\/chat\/completions$/, '/embeddings');
    model = config.get<string>('postgresExplorer.aiModel', '');
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    body = { input: text, model };
  } else {
    throw new Error(`Provider "${provider}" does not support embeddings`);
  }

  const vector = await makeEmbeddingRequest(endpoint, headers, body, provider);
  return { vector, model };
}

function makeEmbeddingRequest(
  endpoint: string,
  headers: Record<string, string>,
  body: any,
  provider: string
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const requestData = JSON.stringify(body);

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(requestData),
      },
    };

    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode !== 200) {
          reject(new Error(`Embedding request failed with status ${statusCode}: ${data}`));
          return;
        }

        try {
          const json = JSON.parse(data);
          let vector: number[] | undefined;

          if (provider === 'openai' || provider === 'lmstudio' || provider === 'custom') {
            vector = json.data?.[0]?.embedding;
          } else if (provider === 'gemini') {
            vector = json.embedding?.values;
          } else if (provider === 'ollama') {
            vector = json.embedding;
          }

          if (vector && Array.isArray(vector)) {
            resolve(vector);
          } else {
            reject(new Error(`Failed to parse embedding vector from response: ${data}`));
          }
        } catch (e: any) {
          reject(new Error(`Failed to parse embedding JSON: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(requestData);
    req.end();
  });
}

/**
 * Helper to write embedding vectors as a contiguous binary Float32Array buffer.
 */
export function serializeEmbeddings(vectors: number[][], dim: number): Uint8Array {
  const buffer = Buffer.alloc(vectors.length * dim * 4);
  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];
    for (let j = 0; j < dim; j++) {
      buffer.writeFloatLE(vec[j] || 0, (i * dim + j) * 4);
    }
  }
  return new Uint8Array(buffer);
}

/**
 * Helper to extract an embedding vector at a specific index from a binary Float32Array buffer.
 */
export function deserializeEmbedding(buffer: Uint8Array, index: number, dim: number): number[] {
  const vector: number[] = [];
  const nodeBuffer = Buffer.from(buffer);
  const offset = index * dim * 4;
  for (let j = 0; j < dim; j++) {
    vector.push(nodeBuffer.readFloatLE(offset + j * 4));
  }
  return vector;
}
