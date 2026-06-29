import * as vscode from 'vscode';
import { LicenseService, LicenseTier } from './LicenseService';
import { TelemetryService } from './TelemetryService';
import { FeatureQuota, formatReset } from './quotaMath';

/** Fire-and-forget gate telemetry; never let instrumentation break gating. */
function reportGate(feature: ProFeature, mode: Enforcement, allowed: boolean, paid: boolean): void {
  try {
    TelemetryService.getInstance().trackGateDecision(feature, mode, allowed, paid);
  } catch {
    /* telemetry is best-effort */
  }
}

/** Premium features. Free tier gets metered access (see {@link FREE_QUOTAS}); paid is unlimited. */
export enum ProFeature {
  AiAssistant = 'aiAssistant',
  SchemaDiff = 'schemaDiff',
  SchemaDesigner = 'schemaDesigner',
  ExplainStudio = 'explainStudio',
  Dashboard = 'dashboard',
  UnlimitedSavedQueries = 'unlimitedSavedQueries',
  BackupRestore = 'backupRestore',
  DataImport = 'dataImport',
  UnlimitedNotebooks = 'unlimitedNotebooks',
  AuditLog = 'auditLog',
  /** Manual single-device backup to the user's own Postgres (free tier). */
  CloudBackup = 'cloudBackup',
  /** Automatic multi-device sync via consumer storage backends (sponsor+). */
  CloudSync = 'cloudSync',
  /** Sharing synced items with other team members (singularity). */
  SyncSharing = 'syncSharing',
  /** Re-binding a free-tier backup to a new device (metered on free). */
  SyncDeviceRebind = 'syncDeviceRebind',
  DbIndexBuild = 'dbIndexBuild',
  DbIndexAuto = 'dbIndexAuto',
  DbIndexMulti = 'dbIndexMulti',
  DbIndexEmbed = 'dbIndexEmbed',
  AgenticModes = 'agenticModes',
}

const FEATURE_LABELS: Record<ProFeature, string> = {
  [ProFeature.AiAssistant]: 'AI Assistant',
  [ProFeature.SchemaDiff]: 'Schema Diff',
  [ProFeature.SchemaDesigner]: 'Schema Designer / ERD',
  [ProFeature.ExplainStudio]: 'Visual EXPLAIN',
  [ProFeature.Dashboard]: 'Real-time Dashboard',
  [ProFeature.UnlimitedSavedQueries]: 'Unlimited Saved Queries',
  [ProFeature.BackupRestore]: 'Backup & Restore',
  [ProFeature.DataImport]: 'Data Import',
  [ProFeature.UnlimitedNotebooks]: 'Unlimited Notebooks',
  [ProFeature.AuditLog]: 'Production Audit Log',
  [ProFeature.CloudBackup]: 'Cloud Backup',
  [ProFeature.CloudSync]: 'Cloud Sync',
  [ProFeature.SyncSharing]: 'Team Sync Sharing',
  [ProFeature.SyncDeviceRebind]: 'Backup Device Rebind',
  [ProFeature.DbIndexBuild]: 'Database Index Build',
  [ProFeature.DbIndexAuto]: 'Auto Database Indexing',
  [ProFeature.DbIndexMulti]: 'Multi-Database Indexing',
  [ProFeature.DbIndexEmbed]: 'Semantic Database Indexing',
  [ProFeature.AgenticModes]: 'Agentic Mode Loops',
};

/** Ordering for entitlement comparison: a tier unlocks everything at or below its rank. */
const TIER_RANK: Record<LicenseTier, number> = { free: 0, sponsor: 1, singularity: 2 };

export const TIER_DISPLAY: Record<LicenseTier, string> = {
  free: 'Free',
  sponsor: 'Sponsor',
  singularity: 'Singularity (Team)',
};

/**
 * Minimum tier that fully unlocks a feature. Features absent here unlock at
 * `sponsor` (any paid tier). Free-tier metered access via {@link FREE_QUOTAS}
 * only applies to `sponsor`-level features — `singularity`-level features are
 * team capabilities and are never metered to lower tiers.
 */
const FEATURE_MIN_TIER: Partial<Record<ProFeature, LicenseTier>> = {
  [ProFeature.AuditLog]: 'singularity',
  [ProFeature.CloudBackup]: 'free',
  [ProFeature.CloudSync]: 'sponsor',
  [ProFeature.SyncSharing]: 'singularity',
  [ProFeature.DbIndexAuto]: 'sponsor',
  [ProFeature.DbIndexMulti]: 'sponsor',
  [ProFeature.DbIndexEmbed]: 'sponsor',
};

/** User-facing upgrade copy for above-tier features. */
const TEAM_UPGRADE_MESSAGES: Partial<Record<ProFeature, string>> = {
  [ProFeature.CloudSync]: 'Automatic multi-device sync requires NexQL Sponsor or Teams.',
  [ProFeature.SyncSharing]: 'Team sync sharing requires a Teams (Singularity) subscription.',
};

export function minTierFor(feature: ProFeature): LicenseTier {
  return FEATURE_MIN_TIER[feature] ?? 'sponsor';
}

export function featureLabel(feature: ProFeature): string {
  return FEATURE_LABELS[feature];
}

export function meetsTier(actual: LicenseTier, required: LicenseTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

/**
 * Free-tier allowances (the freemium model). Paid tiers are unlimited. A feature
 * present here grants metered access on the free tier — each action consumes one
 * unit and the counter resets per period. A feature absent here is a paid-only
 * unlock (e.g. {@link ProFeature.UnlimitedSavedQueries}, which is a stock cap
 * enforced by SavedQueriesService rather than a periodic quota).
 *
 * Tuned so casual free use is comfortable; heavy/costly actions (AI, backups,
 * imports) have firmer caps.
 */
export const FREE_QUOTAS: Partial<Record<ProFeature, FeatureQuota>> = {
  [ProFeature.ExplainStudio]: { limit: 10, period: 'day' },
  [ProFeature.Dashboard]: { limit: 5, period: 'day' },
  [ProFeature.SchemaDiff]: { limit: 5, period: 'day' },
  [ProFeature.SchemaDesigner]: { limit: 5, period: 'day' },
  [ProFeature.DataImport]: { limit: 3, period: 'week' },
  [ProFeature.BackupRestore]: { limit: 3, period: 'week' },
  [ProFeature.SyncDeviceRebind]: { limit: 1, period: 'week' },
  [ProFeature.DbIndexBuild]: { limit: 2, period: 'week' },
};

/**
 * Storage backends per tier (cumulative). Free = bring-your-own Postgres,
 * manual sync, single device. Sponsor adds consumer clouds + auto multi-device
 * sync. Singularity adds hosted NexQL Cloud and team sharing.
 */
const SYNC_PROVIDERS_BY_TIER: Record<LicenseTier, ReadonlyArray<string>> = {
  free: ['postgres'],
  sponsor: ['cloud', 'postgres'],
  singularity: ['cloud', 'postgres'],
};

export function allowedSyncProviders(): ReadonlyArray<string> {
  if (enforcement() === 'off') {
    return SYNC_PROVIDERS_BY_TIER.singularity;
  }
  return SYNC_PROVIDERS_BY_TIER[LicenseService.getInstance().getTier()];
}

export function isSyncProviderAllowed(providerId: string): boolean {
  return allowedSyncProviders().includes(providerId);
}

/** Tier required to use a given sync backend (for upgrade copy). */
export function syncProviderMinTier(providerId: string): LicenseTier {
  if (SYNC_PROVIDERS_BY_TIER.free.includes(providerId)) {
    return 'free';
  }
  return SYNC_PROVIDERS_BY_TIER.sponsor.includes(providerId) ? 'sponsor' : 'singularity';
}

const PRICING_URL = 'https://nexql.astrx.dev/#pricing';

/** `off` = no metering (dev / dark-ship). `freemium` = free quotas enforced, paid unlimited. */
type Enforcement = 'off' | 'freemium';

/**
 * Reads the enforcement mode. Legacy values `hard`/`soft` (full block / nudge)
 * are mapped to `freemium` so existing settings keep working under the new model.
 */
function enforcement(): Enforcement {
  const v = vscode.workspace
    .getConfiguration()
    .get<string>('postgresExplorer.license.enforcement', 'freemium');
  return v === 'off' ? 'off' : 'freemium';
}

function quotaWord(period: FeatureQuota['period']): string {
  return period === 'week' ? 'weekly' : 'daily';
}

/**
 * Synchronous unlock check for render-time gating (e.g. webviews). Under freemium,
 * any quota-metered feature is "enabled" (access is granted; usage is metered at
 * the action via {@link requirePro}). Features without a quota are paid-only.
 */
export function isProFeatureEnabled(feature: ProFeature): boolean {
  if (feature === ProFeature.AiAssistant || feature === ProFeature.AgenticModes) {
    return true;
  }
  if (enforcement() === 'off') {
    return true;
  }
  const tier = LicenseService.getInstance().getTier();
  if (meetsTier(tier, minTierFor(feature))) {
    return true;
  }
  // Below the required tier: free users may still have metered access to
  // sponsor-level features; singularity-level features stay locked.
  return tier === 'free' && minTierFor(feature) === 'sponsor' && FREE_QUOTAS[feature] !== undefined;
}

/**
 * Action gate for the freemium model. Returns true if the action may proceed.
 * Paid → always. Free → consumes one unit of the feature's periodic quota; when
 * the quota is exhausted it returns false with a non-blocking "resets …" nudge
 * (the feature is rate-limited for the period, not permanently locked).
 */
export async function requirePro(feature: ProFeature, _context?: vscode.ExtensionContext): Promise<boolean> {
  if (feature === ProFeature.AiAssistant || feature === ProFeature.AgenticModes) {
    return true; // unlimited on all tiers
  }
  const mode = enforcement();
  if (mode === 'off') {
    return true;
  }

  const tier = LicenseService.getInstance().getTier();
  const paid = tier !== 'free';
  const required = minTierFor(feature);

  if (meetsTier(tier, required)) {
    reportGate(feature, mode, true, paid);
    return true;
  }

  // Paid but below the required tier (e.g. Sponsor using a Team feature):
  // no metering ladder — prompt for the higher plan.
  if (paid || required !== 'sponsor') {
    reportGate(feature, mode, false, paid);
    promptUpgrade(
      TEAM_UPGRADE_MESSAGES[feature] ??
        `${FEATURE_LABELS[feature]} requires NexQL ${TIER_DISPLAY[required]}.`,
    );
    return false;
  }

  // Free tier → meter against the periodic quota.
  const { QuotaService } = await import('./QuotaService');
  const result = await QuotaService.getInstance().tryConsume(feature);

  // No quota configured → either a paid-only unlock or unmetered: block paid-only, allow otherwise.
  if (!result) {
    const unlimitedOnly = FREE_QUOTAS[feature] === undefined;
    reportGate(feature, mode, !unlimitedOnly, paid);
    if (unlimitedOnly) {
      promptUpgrade(`${FEATURE_LABELS[feature]} is a paid feature.`);
      return false;
    }
    return true;
  }

  if (result.allowed) {
    reportGate(feature, mode, true, paid);
    if (result.remaining <= 1) {
      const left = result.remaining;
      void vscode.window.showInformationMessage(
        `${FEATURE_LABELS[feature]}: ${left} free ${quotaWord(result.period)} use${left === 1 ? '' : 's'} left (${formatReset(result.resetsAt, new Date())}).`,
      );
    }
    return true;
  }

  // Exhausted for this period — rate-limited, not blocked forever.
  reportGate(feature, mode, false, paid);
  promptUpgrade(
    `Free ${quotaWord(result.period)} limit reached for ${FEATURE_LABELS[feature]} (${result.limit}/${result.period}). ${formatReset(result.resetsAt, new Date())}. Upgrade for unlimited.`,
  );
  return false;
}

function promptUpgrade(message: string): void {
  void vscode.window
    .showInformationMessage(message, 'View Plans', 'Activate License')
    .then((choice) => handleUpgradeChoice(choice));
}

async function handleUpgradeChoice(choice: string | undefined): Promise<void> {
  if (choice === 'View Plans') {
    await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
  } else if (choice === 'Activate License') {
    await vscode.commands.executeCommand('postgres-explorer.license.activate');
  }
}

/** Inline upgrade HTML for webviews that gate synchronously (paid-only features). */
export function getUpgradeHtml(feature: ProFeature): string {
  const label = FEATURE_LABELS[feature];
  const required = minTierFor(feature);
  const plans = required === 'singularity' ? `NexQL ${TIER_DISPLAY.singularity}` : 'NexQL Sponsor or Singularity';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
             padding: 32px; text-align: center; }
      h2 { margin-bottom: 8px; }
      p { color: var(--vscode-descriptionForeground); }
      a.btn { display:inline-block; margin-top:16px; padding:10px 18px; border-radius:6px;
              background: var(--vscode-button-background); color: var(--vscode-button-foreground);
              text-decoration:none; }
    </style></head>
    <body>
      <h2>${label} is a paid feature</h2>
      <p>Upgrade to ${plans} to unlock ${label}.</p>
      <a class="btn" href="${PRICING_URL}">View plans</a>
      <p style="margin-top:20px;font-size:12px">Already subscribed? Run
        <b>NexQL: Activate License</b> from the command palette.</p>
    </body></html>`;
}
