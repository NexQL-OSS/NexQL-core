import * as vscode from 'vscode';
import { LicenseService } from '../../../services/LicenseService';
import { defaultDeviceName, getDeviceName, getOrCreateDeviceId } from '../../sync/deviceId';
import { saveDeviceDisplayName } from '../../sync/deviceRename';
import { QuotaService } from '../../../services/QuotaService';
import { SecretStorageService } from '../../../services/SecretStorageService';
import { fetchAiUsage } from '../../../services/aiUsage';
import {
  FREE_QUOTAS,
  ProFeature,
  TIER_DISPLAY,
  featureLabel,
} from '../../../services/featureGates';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';

const PRICING_URL = 'https://nexql.astrx.dev/#pricing';
const KEY_HINT = /^(NXQL|PGST)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MASK_VISIBLE_CHARS = 4;
const MACHINE_ID = vscode.env.machineId;

function maskLicenseKey(key: string): string {
  if (key.length <= MASK_VISIBLE_CHARS) {
    return key;
  }
  return `${key.slice(0, 5)}····-····-····-${key.slice(-MASK_VISIBLE_CHARS)}`;
}

function formatEventSummary(eventType: string, detail: Record<string, unknown>): string {
  switch (eventType) {
    case 'issued':
      return `License issued${detail.tier ? ` (${detail.tier})` : ''}`;
    case 'renewed':
    case 'expiry_extended': {
      const oldAt = detail.old_expires_at as number | undefined;
      const newAt = detail.new_expires_at as number | undefined;
      const oldLabel = oldAt ? new Date(oldAt).toLocaleDateString() : '?';
      const newLabel = newAt ? new Date(newAt).toLocaleDateString() : '?';
      return eventType === 'renewed'
        ? `Renewed — expiry ${oldLabel} → ${newLabel}`
        : `Expiry extended — ${oldLabel} → ${newLabel}`;
    }
    case 'status_changed':
      return `Status ${detail.old_status ?? '?'} → ${detail.new_status ?? '?'}`;
    case 'device_bound':
      return `Device bound (${String(detail.instance_id ?? '').slice(0, 8)}…)`;
    case 'device_removed':
      return `Device removed (${String(detail.instance_id ?? '').slice(0, 8)}…)`;
    case 'tier_changed':
      return `Tier ${detail.old_tier ?? '?'} → ${detail.new_tier ?? '?'}`;
    default:
      return eventType.replace(/_/g, ' ');
  }
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
      case 'setEmail':
        await this.setEmail(String(message.email ?? ''));
        break;
      case 'removeDevice':
        await this.removeDevice(String(message.instanceId ?? ''));
        break;
      case 'renameDevice':
        await this.renameDevice(String(message.deviceName ?? ''));
        break;
      case 'refresh':
        await this.sendState();
        break;
    }
  }

  private async sendState(): Promise<void> {
    const svc = LicenseService.getInstance();
    const status = svc.getStatus();

    let maskedKey: string | null = null;
    let gracePeriodStartedAt: number | null = null;
    let cachedStatus: string | null = null;
    let ownerEmail: string | null = svc.getOwnerEmail();
    let licenseKey: string | null = svc.getLicenseKey();

    try {
      const raw = await SecretStorageService.getInstance().getLicenseCache();
      if (raw) {
        const cache = JSON.parse(raw) as {
          licenseKey?: string;
          gracePeriodStartedAt?: number | null;
          status?: string;
          email?: string | null;
        };
        licenseKey = cache.licenseKey ?? licenseKey;
        maskedKey = cache.licenseKey ? maskLicenseKey(cache.licenseKey) : null;
        gracePeriodStartedAt = cache.gracePeriodStartedAt ?? null;
        cachedStatus = cache.status ?? null;
        ownerEmail = cache.email ?? ownerEmail;
      }
    } catch {
      // Unreadable cache — present as free tier details only.
    }

    const server = licenseKey
      ? await svc.fetchServerStatus(ownerEmail)
      : null;

    const serverFound = Boolean(server?.found);
    const effectiveTier = serverFound && server?.tier ? server.tier : status.tier;
    const effectiveStatus = serverFound && server?.status ? server.status : cachedStatus;
    const effectiveExpiresAt = serverFound && server?.expiresAt != null
      ? server.expiresAt
      : status.expiresAt;

    let history: Array<{ createdAt: number | null; summary: string }> = [];
    if (licenseKey && ownerEmail && serverFound) {
      const events = await svc.fetchHistory(ownerEmail);
      history = events.map((e) => ({
        createdAt: e.createdAt,
        summary: formatEventSummary(e.eventType, e.detail),
      }));
    }

    const quotas = QuotaService.getInstance();
    const now = new Date();
    const quotaRows = (Object.keys(FREE_QUOTAS) as ProFeature[]).map((feature) => {
      if (effectiveTier !== 'free') {
        return {
          feature,
          label: featureLabel(feature),
          used: 0,
          remaining: null,
          limit: null,
          period: null,
          resetHint: '',
        };
      }
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

    const aiUsage = await fetchAiUsage(this.host.extensionContext);
    const aiLimit = aiUsage ? aiUsage.limit : (effectiveTier === 'singularity' ? 500 : (effectiveTier === 'sponsor' ? 200 : 50));
    const aiUsed = aiUsage ? aiUsage.used : 0;
    const aiRemaining = aiUsage ? aiUsage.remaining : aiLimit;

    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const daysUntilReset = Math.ceil((nextMonth.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const aiResetHint = `resets in ${daysUntilReset}d`;

    // AI Chat Assistant is the headline free feature — show it first in the table.
    quotaRows.unshift({
      feature: ProFeature.AiAssistant,
      label: 'AI Chat Assistant',
      used: aiUsed,
      remaining: aiRemaining,
      limit: aiLimit,
      period: 'month',
      resetHint: aiResetHint,
    });

    this.host.post({
      type: 'license/state',
      license: {
        tier: effectiveTier,
        tierLabel: TIER_DISPLAY[effectiveTier],
        offline: status.offline,
        expiresAt: effectiveExpiresAt,
        maskedKey,
        gracePeriodStartedAt,
        cachedStatus: effectiveStatus,
        pricingUrl: PRICING_URL,
        quotas: quotaRows,
        serverFound,
        period: server?.period ?? null,
        maskedEmail: server?.email ?? null,
        memberSince: server?.memberSince ?? null,
        renewalCount: server?.renewalCount ?? null,
        hasSubscription: server?.hasSubscription ?? false,
        ownerEmail,
        needsEmail: Boolean(licenseKey && effectiveTier !== 'free' && !ownerEmail),
        devices: (server?.devices ?? []).map((d) => {
          const isCurrent = d.instanceId === MACHINE_ID;
          const localName = getDeviceName(this.host.extensionContext);
          return {
            instanceId: d.instanceId,
            deviceName: isCurrent ? (localName || d.deviceName) : d.deviceName,
            lastSeen: d.lastSeen,
            isCurrent,
          };
        }),
        deviceLimit: server?.deviceLimit ?? null,
        localDeviceName: getDeviceName(this.host.extensionContext) || defaultDeviceName(),
        syncDeviceId: getOrCreateDeviceId(this.host.extensionContext),
        history,
        machineId: MACHINE_ID,
      },
    });
  }

  private async setEmail(email: string): Promise<void> {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      this.host.post({ type: 'license/emailResult', ok: false, message: 'Enter the email on your subscription.' });
      return;
    }
    await LicenseService.getInstance().setOwnerEmail(trimmed);
    const server = await LicenseService.getInstance().fetchServerStatus(trimmed);
    if (!server?.found) {
      this.host.post({
        type: 'license/emailResult',
        ok: false,
        message: 'Email does not match this license. Check the address from your purchase receipt.',
      });
      return;
    }
    this.host.post({ type: 'license/emailResult', ok: true, message: 'Email verified.' });
    await this.sendState();
  }

  private async renameDevice(deviceName: string): Promise<void> {
    const trimmed = deviceName.trim();
    if (!trimmed) {
      this.host.post({
        type: 'license/deviceRenameResult',
        ok: false,
        message: 'Enter a device name.',
      });
      return;
    }
    try {
      const { cloudOk } = await saveDeviceDisplayName(this.host.extensionContext, trimmed);
      this.host.post({
        type: 'license/deviceRenameResult',
        ok: true,
        message: cloudOk
          ? 'Device name saved.'
          : 'Device name saved locally. Cloud sync will pick it up on the next sync.',
        deviceName: trimmed,
      });
      await this.sendState();
    } catch (err: unknown) {
      this.host.post({
        type: 'license/deviceRenameResult',
        ok: false,
        message: err instanceof Error ? err.message : 'Could not save device name.',
      });
    }
  }

  private async removeDevice(instanceId: string): Promise<void> {
    const email = LicenseService.getInstance().getOwnerEmail();
    if (!email) {
      this.host.post({ type: 'license/deviceResult', ok: false, message: 'Verify your email first.' });
      return;
    }
    if (instanceId === MACHINE_ID) {
      this.host.post({
        type: 'license/deviceResult',
        ok: false,
        message: 'Use Deactivate to remove this machine.',
      });
      return;
    }
    const result = await LicenseService.getInstance().removeDevice(email, instanceId);
    this.host.post({ type: 'license/deviceResult', ok: result.ok, message: result.message });
    await this.sendState();
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

