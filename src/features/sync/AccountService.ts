import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import * as vscode from 'vscode';
import { DEFAULT_SYNC_API_ENDPOINT } from './constants';
import type { DeviceAuthStartResponse, DeviceAuthTokenResponse } from './types';

const ACCESS_TOKEN_KEY = 'postgresExplorer.sync.accessToken';
const REFRESH_TOKEN_KEY = 'postgresExplorer.sync.refreshToken';
const ACCOUNT_EMAIL_KEY = 'postgresExplorer.sync.accountEmail';

/**
 * Device authorization flow client for nexql.astrx.dev.
 * Tokens stored per-editor in SecretStorage.
 */
export class AccountService {
  private static instance: AccountService;

  private constructor(private readonly context: vscode.ExtensionContext) {}

  static getInstance(context?: vscode.ExtensionContext): AccountService {
    if (!AccountService.instance) {
      if (!context) {
        throw new Error('AccountService not initialized');
      }
      AccountService.instance = new AccountService(context);
    }
    return AccountService.instance;
  }

  static resetInstanceForTests(): void {
    AccountService.instance = undefined as unknown as AccountService;
  }

  private endpoint(): string {
    const configured = vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.apiEndpoint');
    return (configured?.trim()) || DEFAULT_SYNC_API_ENDPOINT;
  }

  async isSignedIn(): Promise<boolean> {
    const token = await this.context.secrets.get(ACCESS_TOKEN_KEY);
    return !!token;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.context.secrets.get(ACCESS_TOKEN_KEY);
  }

  async getAccountEmail(): Promise<string | undefined> {
    return this.context.secrets.get(ACCOUNT_EMAIL_KEY);
  }

  async signOut(): Promise<void> {
    await this.context.secrets.delete(ACCESS_TOKEN_KEY);
    await this.context.secrets.delete(REFRESH_TOKEN_KEY);
    await this.context.secrets.delete(ACCOUNT_EMAIL_KEY);
  }

  /** Start device flow; returns user_code and verification URL. */
  async startDeviceAuth(): Promise<DeviceAuthStartResponse> {
    return this.postJson<DeviceAuthStartResponse>('/auth/device', {});
  }

  /** Poll for tokens until authorized or timeout. */
  async pollDeviceToken(
    deviceCode: string,
    intervalSec: number,
    expiresInSec: number,
    onWaiting?: (message: string) => void,
  ): Promise<DeviceAuthTokenResponse> {
    const deadline = Date.now() + expiresInSec * 1000;
    let interval = Math.max(intervalSec, 2) * 1000;

    while (Date.now() < deadline) {
      await sleep(interval);
      const res = await this.postJson<DeviceAuthTokenResponse>('/auth/token', { device_code: deviceCode });

      if (res.access_token) {
        return res;
      }

      if (res.error === 'authorization_pending') {
        onWaiting?.('Waiting for authorization in browser…');
        continue;
      }
      if (res.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (res.error) {
        throw new Error(res.error_description ?? res.error);
      }
    }

    throw new Error('Device authorization timed out');
  }

  async completeSignIn(tokens: DeviceAuthTokenResponse, email?: string): Promise<void> {
    if (!tokens.access_token) {
      throw new Error('No access token received');
    }
    await this.context.secrets.store(ACCESS_TOKEN_KEY, tokens.access_token);
    if (tokens.refresh_token) {
      await this.context.secrets.store(REFRESH_TOKEN_KEY, tokens.refresh_token);
    }
    if (email) {
      await this.context.secrets.store(ACCOUNT_EMAIL_KEY, email);
    }
  }

  /** Refresh access token using stored refresh token. */
  async refreshAccessToken(): Promise<string | undefined> {
    const refresh = await this.context.secrets.get(REFRESH_TOKEN_KEY);
    if (!refresh) {
      return undefined;
    }
    try {
      const res = await this.postJson<DeviceAuthTokenResponse>('/auth/refresh', { refresh_token: refresh });
      if (res.access_token) {
        await this.context.secrets.store(ACCESS_TOKEN_KEY, res.access_token);
        if (res.refresh_token) {
          await this.context.secrets.store(REFRESH_TOKEN_KEY, res.refresh_token);
        }
        return res.access_token;
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }

  /** Run full device authorization flow with browser open. */
  async signInWithDeviceFlow(): Promise<{ email?: string }> {
    const start = await this.startDeviceAuth();
    const verifyUrl = start.verification_uri_complete ?? `${start.verification_uri}?user_code=${start.user_code}`;

    const choice = await vscode.window.showInformationMessage(
      `Sign in to NexQL Sync. Your code: ${start.user_code}`,
      'Open Browser',
      'Copy Code',
    );
    if (choice === 'Open Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
    } else if (choice === 'Copy Code') {
      await vscode.env.clipboard.writeText(start.user_code);
    }

    const tokens = await this.pollDeviceToken(
      start.device_code,
      start.interval,
      start.expires_in,
      (msg) => vscode.window.setStatusBarMessage(msg, 3000),
    );

    await this.completeSignIn(tokens, tokens.email ?? undefined);
    return { email: tokens.email ?? (await this.getAccountEmail()) };
  }

  private postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.endpoint().replace(/\/$/, '')}${path}`);
    const payload = JSON.stringify(body);
    const lib = url.protocol === 'http:' ? http : https;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data || '{}') as T);
            } catch {
              reject(new Error(`Invalid JSON from ${path}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
