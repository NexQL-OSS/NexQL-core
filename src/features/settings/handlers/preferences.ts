import * as vscode from 'vscode';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';

const DDL_ENABLED_KEY = 'nexql.ddlViewer.enabled';
const DDL_OPEN_ON_SELECTION_KEY = 'nexql.ddlViewer.openOnSelection';
const HISTORY_MAX_ITEMS_KEY = 'postgresExplorer.queryHistory.maxItems';

export class PreferencesSectionHandler implements SettingsSectionHandler {
  readonly section = 'prefs';

  constructor(private readonly host: SettingsHubHostContext) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        this.sendState();
        break;
      case 'update':
        await this.update(String(message.key), message.value as boolean | number);
        break;
    }
  }

  private sendState(): void {
    const config = vscode.workspace.getConfiguration();
    this.host.post({
      type: 'prefs/state',
      prefs: {
        ddlEnabled: config.get<boolean>(DDL_ENABLED_KEY, true),
        ddlOpenOnSelection: config.get<boolean>(DDL_OPEN_ON_SELECTION_KEY, true),
        historyMaxItems: config.get<number>(HISTORY_MAX_ITEMS_KEY, 200),
      },
    });
  }

  private async update(key: string, value: boolean | number): Promise<void> {
    try {
      if (key === 'ddlEnabled') {
        // Route through the DDL viewer command so open preview tabs are
        // cleaned up and code lenses refresh, same as the in-editor toggle.
        await vscode.commands.executeCommand('postgres-explorer.ddlViewer.toggleEnabled', value);
      } else if (key === 'ddlOpenOnSelection') {
        await vscode.workspace
          .getConfiguration()
          .update(DDL_OPEN_ON_SELECTION_KEY, value, vscode.ConfigurationTarget.Global);
      } else if (key === 'historyMaxItems') {
        const n = Math.max(10, Math.min(1000, Number(value)));
        await vscode.workspace
          .getConfiguration()
          .update(HISTORY_MAX_ITEMS_KEY, n, vscode.ConfigurationTarget.Global);
      } else {
        this.host.post({ type: 'prefs/error', error: `Unknown preference: ${key}` });
        return;
      }
      this.sendState();
    } catch (err: unknown) {
      this.host.post({
        type: 'prefs/error',
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendState();
    }
  }
}
