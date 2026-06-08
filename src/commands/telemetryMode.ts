import * as vscode from 'vscode';

const CONFIG_SECTION = 'postgresExplorer.telemetry';

export type TelemetryMode = 'off' | 'basic' | 'detailed';

export async function setTelemetryMode(mode: TelemetryMode): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('mode', mode, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`NexQL telemetry mode set to: ${mode}`);
}

interface ModePickItem extends vscode.QuickPickItem {
  readonly mode: TelemetryMode;
}

export async function showTelemetryModePicker(): Promise<void> {
  const current = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('mode', 'basic') as TelemetryMode;
  const items: ModePickItem[] = [
    {
      label: '$(circle-slash) Off',
      description: 'No usage or performance events',
      detail: 'Maximum privacy; no product analytics are sent for NexQL.',
      mode: 'off',
      picked: current === 'off',
    },
    {
      label: '$(pulse) Basic',
      description: 'Anonymous usage counters (recommended default)',
      detail:
        'Feature and command usage, coarse connection outcomes, AI provider success — allowlisted properties only; no SQL, hosts, or schema names.',
      mode: 'basic',
      picked: current === 'basic',
    },
    {
      label: '$(graph) Detailed',
      description: 'Basic + anonymized performance buckets',
      detail:
        'Adds duration and result-size buckets for queries and spans so maintainers can spot slow paths and regressions.',
      mode: 'detailed',
      picked: current === 'detailed',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Current mode: ${current} — choose telemetry mode`,
    title: 'NexQL telemetry',
  });
  if (!picked) {
    return;
  }
  await setTelemetryMode(picked.mode);
}
