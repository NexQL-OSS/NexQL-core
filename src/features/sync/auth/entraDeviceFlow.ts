import * as https from 'https';
import * as vscode from 'vscode';

const ENTRA_DEVICE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode';
const ENTRA_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** Entra (Microsoft) device code flow for OneDrive appFolder access. */
export async function entraDeviceFlowSignIn(
  context: vscode.ExtensionContext,
  clientId: string,
): Promise<{ account: string; token: string }> {
  const device = await postForm<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
    message?: string;
  }>(ENTRA_DEVICE_URL, {
    client_id: clientId,
    scope: 'Files.ReadWrite.AppFolder offline_access User.Read',
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
      refresh_token?: string;
      error?: string;
      error_description?: string;
    }>(ENTRA_TOKEN_URL, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: device.device_code,
    });

    if (tokenRes.access_token) {
      await context.secrets.store('postgresExplorer.sync.onedriveToken', tokenRes.access_token);
      if (tokenRes.refresh_token) {
        await context.secrets.store('postgresExplorer.sync.onedriveRefresh', tokenRes.refresh_token);
      }
      const account = await fetchGraphMe(tokenRes.access_token);
      return { account, token: tokenRes.access_token };
    }
    if (tokenRes.error === 'authorization_pending') {
      continue;
    }
    if (tokenRes.error === 'slow_down') {
      interval += 5000;
    } else if (tokenRes.error) {
      throw new Error(tokenRes.error_description ?? tokenRes.error);
    }
  }

  throw new Error('Microsoft authorization timed out');
}

export async function getOneDriveToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get('postgresExplorer.sync.onedriveToken');
}

async function fetchGraphMe(token: string): Promise<string> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'graph.microsoft.com',
        path: '/v1.0/me',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.userPrincipalName ?? parsed.mail ?? 'onedrive-user');
          } catch {
            resolve('onedrive-user');
          }
        });
      },
    );
    req.on('error', () => resolve('onedrive-user'));
    req.end();
  });
}

function postForm<T>(url: string, fields: Record<string, string>): Promise<T> {
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
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error('Invalid token response'));
          }
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
