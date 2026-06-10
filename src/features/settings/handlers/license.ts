import * as vscode from 'vscode';
import { LicenseService } from '../../../services/LicenseService';
import { QuotaService } from '../../../services/QuotaService';
import { SecretStorageService } from '../../../services/SecretStorageService';
import {
  FREE_QUOTAS,
  ProFeature,
  TIER_DISPLAY,
  featureLabel,
} from '../../../services/featureGates';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';

const PRICING_URL = 'https://nexql.astrx.dev/#pricing';
// Server-issued keys use the PGST- prefix; NXQL- accepted for forward compat.
const KEY_HINT = /^(NXQL|PGST)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MASK_VISIBLE_CHARS = 4;

function maskLicenseKey(key: string): string {
  if (key.length <= MASK_VISIBLE_CHARS) {
    return key;
  }
  return `${key.slice(0, 5)}····-····-····-${key.slice(-MASK_VISIBLE_CHARS)}`;
}

export class LicenseSectionHandler implements SettingsSectionHandler {
  readonly section = 'license';

  constructor(private readonly host: SettingsHubHostContext) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        await this.sendState();
        break;
      case 'activate':
        await this.activate(String(message.key ?? ''));
        break;
      case 'deactivate':
        await this.deactivate();
        break;
      case 'openUpgrade':
        await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
        break;
    }
  }

  private async sendState(): Promise<void> {
    const svc = LicenseService.getInstance();
    const status = svc.getStatus();

    // Cached snapshot only — masked key + grace info come from the local
    // SecretStorage cache, never a fresh API call (plan: cached-only).
    let maskedKey: string | null = null;
    let gracePeriodStartedAt: number | null = null;
    let cachedStatus: string | null = null;
    try {
      const raw = await SecretStorageService.getInstance().getLicenseCache();
      if (raw) {
        const cache = JSON.parse(raw) as {
          licenseKey?: string;
          gracePeriodStartedAt?: number | null;
          status?: string;
        };
        maskedKey = cache.licenseKey ? maskLicenseKey(cache.licenseKey) : null;
        gracePeriodStartedAt = cache.gracePeriodStartedAt ?? null;
        cachedStatus = cache.status ?? null;
      }
    } catch {
      // Unreadable cache — present as free tier details only.
    }

    const quotas = QuotaService.getInstance();
    const now = new Date();
    const quotaRows = (Object.keys(FREE_QUOTAS) as ProFeature[]).map((feature) => {
      const peek = quotas.peek(feature, now);
      return {
        feature,
        label: featureLabel(feature),
        used: peek?.used ?? 0,
        remaining: peek?.remaining ?? null,
        limit: peek?.limit ?? null,
        period: peek?.period ?? null,
        resetHint: quotas.resetHint(feature, now),
      };
    });

    this.host.post({
      type: 'license/state',
      license: {
        tier: status.tier,
        tierLabel: TIER_DISPLAY[status.tier],
        offline: status.offline,
        expiresAt: status.expiresAt,
        maskedKey,
        gracePeriodStartedAt,
        cachedStatus,
        pricingUrl: PRICING_URL,
        quotas: status.tier === 'free' ? quotaRows : [],
      },
    });
  }

  private async activate(key: string): Promise<void> {
    const trimmed = key.trim().toUpperCase();
    if (!trimmed) {
      this.host.post({ type: 'license/activateResult', ok: false, message: 'Please enter a license key.' });
      return;
    }
    if (!KEY_HINT.test(trimmed)) {
      this.host.post({
        type: 'license/activateResult',
        ok: false,
        message: 'That does not look like a NexQL key (expected PGST-XXXX-XXXX-XXXX-XXXX).',
      });
      return;
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Activating license…' },
      () => LicenseService.getInstance().activate(trimmed),
    );

    this.host.post({ type: 'license/activateResult', ok: result.ok, message: result.message });
    await this.sendState();
  }

  private async deactivate(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Remove the license from this machine? Your subscription is not cancelled.',
      { modal: true },
      'Deactivate',
    );
    if (confirm === 'Deactivate') {
      await LicenseService.getInstance().deactivate();
      vscode.window.showInformationMessage('License removed from this machine.');
    }
    await this.sendState();
  }
}
