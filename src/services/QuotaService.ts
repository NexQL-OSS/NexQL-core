import * as vscode from 'vscode';
import { ProFeature, FREE_QUOTAS } from './featureGates';
import {
  consume as consumeQuota,
  peek as peekQuota,
  formatReset,
  FeatureQuota,
  UsageRecord,
  ConsumeResult,
  PeekResult,
} from './quotaMath';

/**
 * Per-feature usage accounting for the freemium model. Persists counters in
 * `globalState` keyed per period; counts reset automatically when the period
 * rolls over (the stored record carries its period key).
 */
export class QuotaService {
  private static instance: QuotaService;
  private context: vscode.ExtensionContext | undefined;

  public static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  public initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  public quotaFor(feature: ProFeature): FeatureQuota | undefined {
    return FREE_QUOTAS[feature];
  }

  private storeKey(feature: ProFeature): string {
    return `postgresExplorer.quota.${feature}`;
  }

  private read(feature: ProFeature): UsageRecord | undefined {
    return this.context?.globalState.get<UsageRecord>(this.storeKey(feature));
  }

  /** Non-mutating view of remaining free usage, or null when the feature is unlimited. */
  public peek(feature: ProFeature, now: Date = new Date()): PeekResult | null {
    const quota = this.quotaFor(feature);
    if (!quota) { return null; }
    return peekQuota(this.read(feature), quota, now);
  }

  /**
   * Consume one unit of free usage. Features without a quota (or before init)
   * are always allowed. Persists the incremented counter on success.
   */
  public async tryConsume(feature: ProFeature, now: Date = new Date()): Promise<ConsumeResult | null> {
    const quota = this.quotaFor(feature);
    if (!quota || !this.context) { return null; } // unlimited / not yet initialized
    const result = consumeQuota(this.read(feature), quota, now);
    if (result.record) {
      await this.context.globalState.update(this.storeKey(feature), result.record);
      void refreshQuotaUI();
    }
    return result;
  }

  /** Short phrase describing when a feature's free quota resets. */
  public resetHint(feature: ProFeature, now: Date = new Date()): string {
    const status = this.peek(feature, now);
    return status ? formatReset(status.resetsAt, now) : '';
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

