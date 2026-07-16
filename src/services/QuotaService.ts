import * as vscode from 'vscode';
import { ProFeature } from './featureGates';
import {
  FeatureQuota,
  ConsumeResult,
  PeekResult,
} from './quotaMath';

/**
 * DEPRECATED — per-feature usage quotas have been removed. All free-tier
 * features are unlimited.
 */
export class QuotaService {
  private static instance: QuotaService;

  public static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public initialize(_context: vscode.ExtensionContext): void {
    // No-op — quotas removed.
  }

  /** No features have quotas anymore — always returns undefined. */
  public quotaFor(_feature: ProFeature): FeatureQuota | undefined {
    return undefined;
  }

  /** Always null — no quotas remain. */
  public peek(_feature: ProFeature, _now: Date = new Date()): PeekResult | null {
    return null;
  }

  /** Always allows (null = no quota). */
  public async tryConsume(_feature: ProFeature, _now: Date = new Date()): Promise<ConsumeResult | null> {
    return null;
  }

  /** Empty string — no quotas to reset. */
  public resetHint(_feature: ProFeature, _now: Date = new Date()): string {
    return '';
  }
}

export async function refreshQuotaUI(): Promise<void> {
  try {
    const { statusBar } = await import('../extension');
    if (statusBar) {
      statusBar.update();
    }
  } catch (err) {
    // Silent
  }
  try {
    const { SettingsHubPanel } = await import('../features/settings/SettingsHubPanel');
    if (SettingsHubPanel.currentPanel) {
      SettingsHubPanel.currentPanel.refreshSection('license');
    }
  } catch (err) {
    // Silent
  }
}
