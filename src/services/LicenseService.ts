import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { SecretStorageService } from './SecretStorageService';

export type LicenseTier = 'free' | 'sponsor' | 'singularity';

/** Persisted entitlement snapshot. Lives in SecretStorage. */
interface LicenseCache {
  licenseKey: string;
  instanceId: string;
  tier: LicenseTier;
  status: string;
  validatedAt: number;
  expiresAt: number | null;
  gracePeriodStartedAt: number | null;
  /** Owner email for server-side device/history management. */
  email?: string | null;
}

interface ValidateResponse {
  valid: boolean;
  tier?: LicenseTier;
  status?: string;
  expiresAt?: number | null;
  reason?: string;
  expiringSoon?: boolean;
  graceUntil?: number | null;
}

export interface LicenseServerStatus {
  found: boolean;
  tier?: LicenseTier;
  status?: string;
  period?: string;
  currency?: string;
  expiresAt?: number | null;
  email?: string | null;
  hasSubscription?: boolean;
  memberSince?: number | null;
  renewalCount?: number;
  deviceLimit?: number;
  devices?: Array<{
    instanceId: string;
    deviceName: string | null;
    lastSeen: number | null;
  }>;
}

export interface LicenseHistoryEvent {
  eventType: string;
  detail: Record<string, unknown>;
  source: string;
  createdAt: number | null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ENDPOINT = 'https://nexql.astrx.dev/api';

/**
 * Manages NexQL license activation and tier entitlement.
 *
 * Source of truth is the server (`/api/license/validate`); a cached snapshot in
 * SecretStorage lets the extension answer `getTier()` synchronously and keep
 * working offline within a 7-day grace window. Designed to fail OPEN to `free`
 * (never blocks startup, never throws into callers).
 */
export class LicenseService {
  private static instance: LicenseService;
  private cache: LicenseCache | null = null;
  private revalidating = false;
  private lastAttemptAt = 0;

  private readonly _onDidChangeLicense = new vscode.EventEmitter<LicenseTier>();
  public readonly onDidChangeLicense = this._onDidChangeLicense.event;

  private constructor(private readonly context: vscode.ExtensionContext) { }

  public static getInstance(context?: vscode.ExtensionContext): LicenseService {
    if (!LicenseService.instance) {
      if (!context) {
        throw new Error('LicenseService not initialized');
      }
      LicenseService.instance = new LicenseService(context);
    }
    return LicenseService.instance;
  }

  public async initialize(): Promise<void> {
    try {
      const raw = await SecretStorageService.getInstance().getLicenseCache();
      if (raw) {
        this.cache = JSON.parse(raw) as LicenseCache;
      }
    } catch {
      this.cache = null;
    }
    if (this.cache && this.isStale()) {
      void this.revalidate();
    }
    this._onDidChangeLicense.fire(this.getTier());
  }

  public getTier(): LicenseTier {
    const tier = this.entitledTier();
    if (tier !== 'free' && this.shouldAttempt()) {
      void this.revalidate();
    }
    return tier;
  }

  private entitledTier(): LicenseTier {
    return this.entitled() ? this.cache!.tier : 'free';
  }

  private shouldAttempt(): boolean {
    return this.isStale() && !this.revalidating && Date.now() - this.lastAttemptAt > 60_000;
  }

  public isPaid(): boolean {
    return this.getTier() !== 'free';
  }

  public getLicenseKey(): string | null {
    return this.cache?.licenseKey ?? null;
  }

  public getOwnerEmail(): string | null {
    return this.cache?.email ?? null;
  }

  public async setOwnerEmail(email: string): Promise<void> {
    if (!this.cache) return;
    this.cache.email = email.trim().toLowerCase();
    await this.persist();
  }

  private entitled(): boolean {
    const c = this.cache;
    if (!c) return false;
    if (c.status !== 'active') return false;
    if (c.expiresAt && Date.now() > c.expiresAt) return false;
    if (Date.now() - c.validatedAt <= CACHE_TTL_MS) return true;
    if (c.gracePeriodStartedAt && Date.now() - c.gracePeriodStartedAt > GRACE_MS) {
      return false;
    }
    return true;
  }

  private isStale(): boolean {
    return !!this.cache && Date.now() - this.cache.validatedAt > CACHE_TTL_MS;
  }

  public async activate(licenseKey: string): Promise<{ ok: boolean; message: string; tier?: LicenseTier }> {
    const key = (licenseKey || '').trim().toUpperCase();
    if (!key) {
      return { ok: false, message: 'Please enter a license key.' };
    }

    let res: ValidateResponse;
    try {
      res = await this.callValidate(key);
    } catch {
      return { ok: false, message: 'Could not reach the license server. Check your connection and try again.' };
    }

    if (!res.valid || !res.tier) {
      const reason =
        res.reason === 'device_limit'
          ? 'This license has reached its device limit.'
          : res.status === 'cancelled'
            ? 'This subscription was cancelled.'
            : 'License key not valid or inactive.';
      return { ok: false, message: reason };
    }

    this.cache = {
      licenseKey: key,
      instanceId: vscode.env.machineId,
      tier: res.tier,
      status: res.status || 'active',
      validatedAt: Date.now(),
      expiresAt: res.expiresAt ?? null,
      gracePeriodStartedAt: null,
      email: this.cache?.email ?? null,
    };
    await this.persist();
    this._onDidChangeLicense.fire(res.tier);

    if (res.expiringSoon) {
      void this.maybeWarnExpiringSoon(res.expiresAt);
    }

    if (res.tier === 'sponsor' || res.tier === 'singularity') {
      void import('../features/sync/syncBootstrap').then((m) => m.maybePromptSyncBootstrap(this.context));
    }

    return { ok: true, message: `Activated NexQL ${this.tierLabel(res.tier)}.`, tier: res.tier };
  }

  public async deactivate(): Promise<void> {
    this.cache = null;
    await SecretStorageService.getInstance().deleteLicenseCache();
    this._onDidChangeLicense.fire('free');
  }

  public getStatus(): { tier: LicenseTier; offline: boolean; expiresAt: number | null } {
    const offline = this.entitled() && this.isStale();
    return {
      tier: this.getTier(),
      offline,
      expiresAt: this.cache?.expiresAt ?? null,
    };
  }

  public async fetchServerStatus(email?: string | null): Promise<LicenseServerStatus | null> {
    const key = this.cache?.licenseKey;
    if (!key) return null;
    try {
      const body: Record<string, string> = { licenseKey: key };
      const resolvedEmail = (email ?? this.cache?.email)?.trim();
      if (resolvedEmail) {
        body.email = resolvedEmail;
      }
      return await this.callApi<LicenseServerStatus>('/license/status', body);
    } catch {
      return null;
    }
  }

  public async fetchHistory(email: string): Promise<LicenseHistoryEvent[]> {
    const key = this.cache?.licenseKey;
    if (!key || !email.trim()) return [];
    try {
      const res = await this.callApi<{ ok: boolean; events: LicenseHistoryEvent[] }>(
        '/license/history',
        { licenseKey: key, email: email.trim(), limit: 50 },
      );
      return res?.events ?? [];
    } catch {
      return [];
    }
  }

  public async removeDevice(email: string, instanceId: string): Promise<{ ok: boolean; message: string }> {
    const key = this.cache?.licenseKey;
    if (!key) {
      return { ok: false, message: 'No license is active on this machine.' };
    }
    try {
      const res = await this.callApi<{ ok: boolean; error?: string }>(
        '/license/devices',
        { licenseKey: key, email: email.trim(), action: 'remove', instanceId },
      );
      if (!res?.ok) {
        return { ok: false, message: 'Could not remove device. Check your email and try again.' };
      }
      return { ok: true, message: 'Device removed.' };
    } catch {
      return { ok: false, message: 'Could not reach the license server.' };
    }
  }

  private async revalidate(): Promise<void> {
    if (this.revalidating || !this.cache) return;
    this.revalidating = true;
    this.lastAttemptAt = Date.now();
    const before = this.entitledTier();
    try {
      const res = await this.callValidate(this.cache.licenseKey);
      if (res.valid && res.tier) {
        this.cache = {
          ...this.cache,
          tier: res.tier,
          status: res.status || 'active',
          validatedAt: Date.now(),
          expiresAt: res.expiresAt ?? null,
          gracePeriodStartedAt: null,
        };
        await this.persist();
        if (res.expiringSoon) {
          void this.maybeWarnExpiringSoon(res.expiresAt);
        }
      } else {
        this.cache = null;
        await SecretStorageService.getInstance().deleteLicenseCache();
      }
    } catch {
      if (this.cache && !this.cache.gracePeriodStartedAt) {
        this.cache.gracePeriodStartedAt = Date.now();
        await this.persist();
      }
    } finally {
      this.revalidating = false;
      const after = this.entitledTier();
      if (after !== before) {
        this._onDidChangeLicense.fire(after);
      }
    }
  }

  private async maybeWarnExpiringSoon(expiresAt?: number | null): Promise<void> {
    if (!expiresAt) return;
    const when = new Date(expiresAt).toLocaleDateString();
    const choice = await vscode.window.showWarningMessage(
      `Your NexQL license renews or expires on ${when}.`,
      'Manage License',
    );
    if (choice === 'Manage License') {
      void vscode.commands.executeCommand('postgres-explorer.license.manage');
    }
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    await SecretStorageService.getInstance().setLicenseCache(JSON.stringify(this.cache));
  }

  private endpoint(): string {
    const configured = vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.license.endpoint');
    return (configured && configured.trim()) || DEFAULT_ENDPOINT;
  }

  private tierLabel(tier: LicenseTier): string {
    return tier === 'free' ? 'Free' : tier[0].toUpperCase() + tier.slice(1);
  }

  private callValidate(licenseKey: string): Promise<ValidateResponse> {
    return this.callApi<ValidateResponse>('/license/validate', {
      licenseKey,
      instanceId: vscode.env.machineId,
    });
  }

  private callApi<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.endpoint().replace(/\/$/, '')}${path}`);
    const body = JSON.stringify(payload);
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
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode === 404) {
              return resolve({ found: false, valid: false, status: 'unknown' } as T);
            }
            if (!res.statusCode || res.statusCode >= 500) {
              return reject(new Error(`server ${res.statusCode}`));
            }
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error('invalid json'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  public dispose(): void {
    this._onDidChangeLicense.dispose();
  }
}
