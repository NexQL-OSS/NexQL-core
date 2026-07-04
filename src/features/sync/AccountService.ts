import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import * as vscode from 'vscode';
import { LicenseService } from '../../services/LicenseService';
import { DEFAULT_SYNC_API_ENDPOINT } from './constants';
import { getDeviceName, getOrCreateDeviceId } from './deviceId';
import type { DeviceAuthStartResponse, DeviceAuthTokenResponse } from './types';

const ACCESS_TOKEN_KEY = 'postgresExplorer.sync.accessToken';
const REFRESH_TOKEN_KEY = 'postgresExplorer.sync.refreshToken';
const ACCOUNT_EMAIL_KEY = 'postgresExplorer.sync.accountEmail';
/** Whether the cached bearer was minted from a license key or free OAuth identity. */
const AUTH_MODE_KEY = 'postgresExplorer.sync.authMode';

export type AiSessionAuthMode = 'license' | 'free';

interface SessionAuthResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  email?: string | null;
  tier?: string | null;
  error?: string;
}

interface ApiErrorBody {
  error?: string;
  error_description?: string;
}

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
    await this.context.secrets.delete(AUTH_MODE_KEY);
  }

  private async getAuthMode(): Promise<AiSessionAuthMode | undefined> {
    const mode = await this.context.secrets.get(AUTH_MODE_KEY);
    return mode === 'license' || mode === 'free' ? mode : undefined;
  }

  /** Drop a stale free OAuth session when a paid license is active locally. */
  private async discardFreeSessionIfLicensed(): Promise<boolean> {
    if (!LicenseService.getInstance().getLicenseKey()) {
      return false;
    }
    if ((await this.getAuthMode()) !== 'free') {
      return false;
    }
    await this.signOut();
    return true;
  }

  /** Fast-path sign-in using the activated license key (no browser). */
  async signInWithLicense(): Promise<{ email?: string }> {
    const licenseKey = LicenseService.getInstance().getLicenseKey();
    if (!licenseKey) {
      throw new Error('Activate your NexQL license first (Settings → License).');
    }

    const res = await this.postJson<SessionAuthResponse>('/auth/session', {
      licenseKey,
      instanceId: vscode.env.machineId,
      deviceId: getOrCreateDeviceId(this.context),
      deviceName: getDeviceName(this.context),
    });

    if (!res.access_token) {
      throw new Error(res.error ?? 'Sign-in failed');
    }

    await this.completeSignIn(res as DeviceAuthTokenResponse, res.email ?? undefined, 'license');
    return { email: res.email ?? (await this.getAccountEmail()) };
  }

  /** Start device flow; returns user_code and verification URL. */
  async startDeviceAuth(): Promise<DeviceAuthStartResponse> {
    return this.postJson<DeviceAuthStartResponse>('/auth/device', {});
  }

  /** Free-tier lite sign-in via the editor's GitHub session — no license required. */
  async signInFree(): Promise<{ email?: string }> {
    const session = await vscode.authentication.getSession('github', [], { createIfNone: true });
    if (!session) {
      throw new Error('GitHub sign-in is required to use NexQL free AI.');
    }

    const res = await this.postJson<SessionAuthResponse>('/auth/free-session', {
      provider: 'github',
      access_token: session.accessToken,
      deviceId: getOrCreateDeviceId(this.context),
      deviceName: getDeviceName(this.context),
    });

    if (!res.access_token) {
      throw new Error(res.error ?? 'Free sign-in failed');
    }

    await this.completeSignIn(res as DeviceAuthTokenResponse, res.email ?? undefined, 'free');
    return { email: res.email ?? (await this.getAccountEmail()) };
  }

  /**
   * Resolve a bearer token for the AI Gateway proxy: reuse an existing (free or
   * paid) session, refresh it, sign in with a stored license (paid), or fall
   * back to free GitHub lite sign-in.
   */
  async ensureAiSession(options?: { invalidateAccess?: boolean }): Promise<string> {
    if (options?.invalidateAccess) {
      await this.context.secrets.delete(ACCESS_TOKEN_KEY);
    }

    await this.discardFreeSessionIfLicensed();

    if (!options?.invalidateAccess) {
      const existing = await this.getAccessToken();
      if (existing) {
        return existing;
      }
    }

    const refreshed = await this.refreshAccessToken();
    if (refreshed) {
      if (await this.discardFreeSessionIfLicensed()) {
        // Refreshed token was still tied to free OAuth — re-mint from license below.
      } else {
        return refreshed;
      }
    }

    if (LicenseService.getInstance().getLicenseKey()) {
      await this.signInWithLicense();
    } else {
      await this.signInFree();
    }

    const token = await this.getAccessToken();
    if (!token) {
      throw new Error('Not signed in to NexQL AI');
    }
    return token;
  }

  /** Pre-bind license to pending device session before opening browser. */
  async bindDeviceLicense(deviceCode: string): Promise<void> {
    const licenseKey = LicenseService.getInstance().getLicenseKey();
    if (!licenseKey) {
      throw new Error('Activate your NexQL license first (Settings → License).');
    }

    await this.postJson<{ ok?: boolean; error?: string }>('/auth/device-bind', {
      device_code: deviceCode,
      licenseKey,
      instanceId: vscode.env.machineId,
      deviceName: getDeviceName(this.context),
    });
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

  async completeSignIn(
    tokens: DeviceAuthTokenResponse,
    email?: string,
    authMode?: AiSessionAuthMode,
  ): Promise<void> {
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
    if (authMode) {
      await this.context.secrets.store(AUTH_MODE_KEY, authMode);
    }
  }

  /**
   * Resolve a valid access token: use cached token, refresh, or license re-auth.
   * On 401 retry paths pass `{ invalidateAccess: true }` to drop a stale access token first.
   */
  async ensureSession(options?: { invalidateAccess?: boolean }): Promise<string> {
    if (options?.invalidateAccess) {
      await this.context.secrets.delete(ACCESS_TOKEN_KEY);
    } else {
      const existing = await this.getAccessToken();
      if (existing) {
        return existing;
      }
    }

    const refreshed = await this.refreshAccessToken();
    if (refreshed) {
      return refreshed;
    }

    await this.signInWithLicense();
    const token = await this.getAccessToken();
    if (!token) {
      throw new Error('Not signed in to NexQL account');
    }
    return token;
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

  /** Browser confirm flow — license pre-bound from extension. */
  async signInWithDeviceFlow(onStatus?: (message: string) => void): Promise<{ email?: string }> {
    const start = await this.startDeviceAuth();
    await this.bindDeviceLicense(start.device_code);

    const deviceName = getDeviceName(this.context);
    const verifyParams = new URLSearchParams({ user_code: start.user_code });
    if (deviceName) {
      verifyParams.set('device', deviceName);
    }
    const verifyBase = start.verification_uri_complete?.split('?')[0]
      ?? start.verification_uri;
    const verifyUrl = `${verifyBase}?${verifyParams.toString()}`;

    onStatus?.(`Opening browser — confirm device authorization (code ${start.user_code})`);
    await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));

    const tokens = await this.pollDeviceToken(
      start.device_code,
      start.interval,
      start.expires_in,
      onStatus,
    );

    await this.completeSignIn(tokens, tokens.email ?? undefined, 'license');
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
            let parsed: T & ApiErrorBody;
            try {
              parsed = JSON.parse(data || '{}') as T & ApiErrorBody;
            } catch {
              reject(new Error(`Invalid JSON from ${path}`));
              return;
            }
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(parsed.error ?? parsed.error_description ?? `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed);
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
