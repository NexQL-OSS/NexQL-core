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
  status: string; // 'active' | 'cancelled' | 'halted' | 'paused' | ...
  validatedAt: number; // unix ms of last successful server validation
  expiresAt: number | null;
  gracePeriodStartedAt: number | null;
}

interface ValidateResponse {
  valid: boolean;
  tier?: LicenseTier;
  status?: string;
  expiresAt?: number | null;
  reason?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // re-validate after 24h
const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // tolerate 7 days offline
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

  /** Load the cached entitlement and kick off a background refresh if stale. Non-blocking. */
  public async initialize(): Promise<void> {
    try {
      const raw = await SecretStorageService.getInstance().getLicenseCache();
      if (raw) {
        this.cache = JSON.parse(raw) as LicenseCache;
      }
    } catch {
      this.cache = null;
    }
    // Fire-and-forget freshness check.
    if (this.cache && this.isStale()) {
      void this.revalidate();
    }
    this._onDidChangeLicense.fire(this.getTier());
  }

  /** Current entitled tier, or 'free' when unlicensed / expired / past grace. */
  public getTier(): LicenseTier {
    const tier = this.entitledTier();
    // Opportunistic refresh when stale — throttled so a failing server never loops.
    if (tier !== 'free' && this.shouldAttempt()) {
      void this.revalidate();
    }
    return tier;
  }

  /** Side-effect-free tier resolution (safe to call from within revalidate). */
  private entitledTier(): LicenseTier {
    return this.entitled() ? this.cache!.tier : 'free';
  }

  private shouldAttempt(): boolean {
    return this.isStale() && !this.revalidating && Date.now() - this.lastAttemptAt > 60_000;
  }

  public isPaid(): boolean {
    return this.getTier() !== 'free';
  }

  /** True only while we have a verified-and-current entitlement. */
  private entitled(): boolean {
    const c = this.cache;
    if (!c) return false;
    if (c.status !== 'active') return false;
    if (c.expiresAt && Date.now() > c.expiresAt) return false;
    if (Date.now() - c.validatedAt <= CACHE_TTL_MS) return true;
    // Stale: still honor within the offline grace window.
    if (c.gracePeriodStartedAt && Date.now() - c.gracePeriodStartedAt > GRACE_MS) {
      return false;
    }
    return true;
  }

  private isStale(): boolean {
    return !!this.cache && Date.now() - this.cache.validatedAt > CACHE_TTL_MS;
  }

  /** Activate a license key. Returns a user-facing result. */
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
    };
    await this.persist();
    this._onDidChangeLicense.fire(res.tier);
    return { ok: true, message: `Activated NexQL ${this.tierLabel(res.tier)}.`, tier: res.tier };
  }

  /** Remove the local license (does not cancel the subscription). */
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

  // ---- internals ---------------------------------------------------------

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
      } else {
        // Server says no — instant downgrade (revocation/cancellation/expiry).
        this.cache = null;
        await SecretStorageService.getInstance().deleteLicenseCache();
      }
    } catch {
      // Network failure → start/keep the offline grace window, retain cache.
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
    const url = new URL(`${this.endpoint().replace(/\/$/, '')}/license/validate`);
    const payload = JSON.stringify({ licenseKey, instanceId: vscode.env.machineId });
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
          timeout: 10000,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            // 404 = unknown key, 4xx without body = treat as invalid (not a network error).
            if (res.statusCode === 404) {
              return resolve({ valid: false, status: 'unknown' });
            }
            try {
              resolve(JSON.parse(body) as ValidateResponse);
            } catch {
              // Unparseable success body is effectively invalid.
              resolve({ valid: false });
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

  public dispose(): void {
    this._onDidChangeLicense.dispose();
  }
}
