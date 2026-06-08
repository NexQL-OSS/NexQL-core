import * as vscode from 'vscode';
import { LicenseService } from './LicenseService';

/** Premium features gated behind a paid tier. */
export enum ProFeature {
  AiAssistant = 'aiAssistant',
  SchemaDiff = 'schemaDiff',
  SchemaDesigner = 'schemaDesigner',
  ExplainStudio = 'explainStudio',
  Dashboard = 'dashboard',
  UnlimitedSavedQueries = 'unlimitedSavedQueries',
}

const FEATURE_LABELS: Record<ProFeature, string> = {
  [ProFeature.AiAssistant]: 'AI Assistant',
  [ProFeature.SchemaDiff]: 'Schema Diff',
  [ProFeature.SchemaDesigner]: 'Schema Designer / ERD',
  [ProFeature.ExplainStudio]: 'Visual EXPLAIN',
  [ProFeature.Dashboard]: 'Real-time Dashboard',
  [ProFeature.UnlimitedSavedQueries]: 'Unlimited Saved Queries',
};

const PRICING_URL = 'https://pgstudio.dev/#pricing';

type Enforcement = 'off' | 'soft' | 'hard';

/**
 * Rollout safety valve. Default `off` means every gate is a no-op, so shipping
 * the gating code does NOT change behavior for existing users. Flip to `hard`
 * (or `soft`) via settings / a release default once entitlement is live.
 */
function enforcement(): Enforcement {
  const v = vscode.workspace
    .getConfiguration()
    .get<string>('postgresExplorer.license.enforcement', 'off');
  return v === 'hard' || v === 'soft' ? v : 'off';
}

/** Synchronous check for hot paths (e.g. webview rendering). */
export function isProFeatureEnabled(_feature: ProFeature): boolean {
  if (enforcement() !== 'hard') {
    return true; // off / soft never block
  }
  return LicenseService.getInstance().isPaid();
}

/**
 * Async gate for commands. Returns true if the feature may proceed. When blocked,
 * shows an upgrade prompt. In `soft` mode it nudges once but still allows.
 */
export async function requirePro(feature: ProFeature, _context?: vscode.ExtensionContext): Promise<boolean> {
  const mode = enforcement();
  if (mode === 'off') {
    return true;
  }

  const paid = LicenseService.getInstance().isPaid();
  if (paid) {
    return true;
  }

  const label = FEATURE_LABELS[feature];

  if (mode === 'soft') {
    // Non-blocking nudge.
    void vscode.window
      .showInformationMessage(`${label} is a PgStudio paid feature.`, 'Upgrade', 'Activate License')
      .then((choice) => handleUpgradeChoice(choice));
    return true;
  }

  // hard
  const choice = await vscode.window.showWarningMessage(
    `${label} requires a PgStudio subscription.`,
    { modal: true },
    'Upgrade',
    'Activate License',
  );
  await handleUpgradeChoice(choice);
  return false;
}

async function handleUpgradeChoice(choice: string | undefined): Promise<void> {
  if (choice === 'Upgrade') {
    await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
  } else if (choice === 'Activate License') {
    await vscode.commands.executeCommand('postgres-explorer.license.activate');
  }
}

/** Inline upgrade HTML for webviews that gate synchronously. */
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
      <p>Upgrade to PgStudio Sponsor or Singularity to unlock ${label}.</p>
      <a class="btn" href="${PRICING_URL}">View plans</a>
      <p style="margin-top:20px;font-size:12px">Already subscribed? Run
        <b>PgStudio: Activate License</b> from the command palette.</p>
    </body></html>`;
}
