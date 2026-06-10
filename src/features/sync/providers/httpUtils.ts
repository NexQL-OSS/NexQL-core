import * as https from 'https';
import * as http from 'http';

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
    timeoutMs?: number;
  } = {},
): Promise<HttpResponse> {
  const parsed = new URL(url);
  const lib = parsed.protocol === 'http:' ? http : https;
  const payload = options.body
    ? (typeof options.body === 'string' ? Buffer.from(options.body) : options.body)
    : undefined;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: {
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
          ...options.headers,
        },
        timeout: options.timeoutMs ?? 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export function parseRetryAfterMs(headers: Record<string, string | string[] | undefined>): number | undefined {
  const raw = headers['retry-after'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val) {
    return undefined;
  }
  const secs = parseInt(val, 10);
  if (!Number.isNaN(secs)) {
    return secs * 1000;
  }
  const date = Date.parse(val);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}
