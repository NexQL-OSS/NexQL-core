import * as https from 'https';
import * as vscode from 'vscode';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** GitHub OAuth device flow fallback when vscode.authentication is unavailable. */
export async function githubDeviceFlowSignIn(
  context: vscode.ExtensionContext,
  clientId: string,
): Promise<{ account: string; token: string }> {
  const device = await postForm<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  }>(GITHUB_DEVICE_CODE_URL, {
    client_id: clientId,
    scope: 'gist',
  });

  await vscode.env.openExternal(
    vscode.Uri.parse(`${device.verification_uri}?user_code=${device.user_code}`),
  );

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const tokenRes = await postForm<{
      access_token?: string;
      error?: string;
    }>(GITHUB_ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, true);

    if (tokenRes.access_token) {
      await context.secrets.store('postgresExplorer.sync.githubToken', tokenRes.access_token);
      const user = await fetchGithubUser(tokenRes.access_token);
      return { account: user, token: tokenRes.access_token };
    }
    if (tokenRes.error === 'authorization_pending') {
      continue;
    }
    if (tokenRes.error === 'slow_down') {
      interval += 5000;
    }
  }

  throw new Error('GitHub device authorization timed out');
}

export async function getGithubToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession('github', ['gist'], { createIfNone: false });
    if (session?.accessToken) {
      return session.accessToken;
    }
  } catch {
    /* fork without GitHub provider */
  }
  return context.secrets.get('postgresExplorer.sync.githubToken');
}

async function fetchGithubUser(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: '/user',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'NexQL-Sync',
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.login ?? 'github-user');
          } catch {
            resolve('github-user');
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function postForm<T>(url: string, fields: Record<string, string>, acceptJson = false): Promise<T> {
  const body = new URLSearchParams(fields).toString();
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          ...(acceptJson ? { Accept: 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (acceptJson) {
            try {
              resolve(JSON.parse(data) as T);
              return;
            } catch { /* fall through */ }
          }
          const params = new URLSearchParams(data);
          const obj: Record<string, string> = {};
          params.forEach((v, k) => { obj[k] = v; });
          resolve(obj as T);
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
