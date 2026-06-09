import * as vscode from 'vscode';
import { LicenseService } from './LicenseService';
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
};

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
  [ProFeature.AiAssistant]: { limit: 25, period: 'day' },
  [ProFeature.ExplainStudio]: { limit: 10, period: 'day' },
  [ProFeature.Dashboard]: { limit: 5, period: 'day' },
  [ProFeature.SchemaDiff]: { limit: 5, period: 'day' },
  [ProFeature.SchemaDesigner]: { limit: 5, period: 'day' },
  [ProFeature.DataImport]: { limit: 3, period: 'week' },
  [ProFeature.BackupRestore]: { limit: 3, period: 'week' },
};

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
  if (enforcement() === 'off') {
    return true;
  }
  if (LicenseService.getInstance().isPaid()) {
    return true;
  }
  return FREE_QUOTAS[feature] !== undefined;
}

/**
 * Action gate for the freemium model. Returns true if the action may proceed.
 * Paid → always. Free → consumes one unit of the feature's periodic quota; when
 * the quota is exhausted it returns false with a non-blocking "resets …" nudge
 * (the feature is rate-limited for the period, not permanently locked).
 */
export async function requirePro(feature: ProFeature, _context?: vscode.ExtensionContext): Promise<boolean> {
  const mode = enforcement();
  if (mode === 'off') {
    return true;
  }

  const paid = LicenseService.getInstance().isPaid();
  if (paid) {
    reportGate(feature, mode, true, paid);
    return true;
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
    .showInformationMessage(message, 'Upgrade', 'Activate License')
    .then((choice) => handleUpgradeChoice(choice));
}

async function handleUpgradeChoice(choice: string | undefined): Promise<void> {
  if (choice === 'Upgrade') {
    await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
  } else if (choice === 'Activate License') {
    await vscode.commands.executeCommand('postgres-explorer.license.activate');
  }
}

/** Inline upgrade HTML for webviews that gate synchronously (paid-only features). */
export function getUpgradeHtml(feature: ProFeature): string {
  const label = FEATURE_LABELS[feature];
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
      <p>Upgrade to NexQL Sponsor or Singularity to unlock ${label}.</p>
      <a class="btn" href="${PRICING_URL}">View plans</a>
      <p style="margin-top:20px;font-size:12px">Already subscribed? Run
        <b>NexQL: Activate License</b> from the command palette.</p>
    </body></html>`;
}
