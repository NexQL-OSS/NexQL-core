import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Loopback PKCE for Google Drive appdata — device flow does not support Drive scopes. */
export async function googleLoopbackPkceSignIn(
  context: vscode.ExtensionContext,
  clientId: string,
): Promise<{ account: string; token: string }> {
  if (vscode.env.remoteName) {
    const proceed = await vscode.window.showWarningMessage(
      'Google Drive sync uses a local browser callback. This may not work over SSH Remote or Codespaces.',
      'Continue Anyway',
      'Cancel',
    );
    if (proceed !== 'Continue Anyway') {
      throw new Error('Google Drive sync cancelled — remote environment detected');
    }
  }

  const { verifier, challenge } = createPkcePair();
  const port = 49152 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const code = await waitForAuthCode(clientId, redirectUri, challenge, port);
  const tokens = await exchangeCode(clientId, code, redirectUri, verifier);

  await context.secrets.store('postgresExplorer.sync.gdriveToken', tokens.access_token);
  if (tokens.refresh_token) {
    await context.secrets.store('postgresExplorer.sync.gdriveRefresh', tokens.refresh_token);
  }

  return { account: 'google-drive-user', token: tokens.access_token };
}

export async function getGDriveToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get('postgresExplorer.sync.gdriveToken');
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function waitForAuthCode(
  clientId: string,
  redirectUri: string,
  challenge: string,
  port: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Authorization complete. You can close this tab.</body></html>');
      server.close();
      if (error) {
        reject(new Error(error));
      } else if (code) {
        resolve(code);
      } else {
        reject(new Error('No authorization code received'));
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const authUrl = new URL(GOOGLE_AUTH_URL);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.appdata');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      void vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
    });

    server.on('error', reject);
    setTimeout(() => {
      server.close();
      reject(new Error('Google authorization timed out'));
    }, 5 * 60 * 1000);
  });
}

function exchangeCode(
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
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
            resolve(JSON.parse(data));
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
