import * as vscode from 'vscode';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../settings/types';
import { NEXQL_THEMES_MARKETPLACE_URL } from './constants';
import { SentinelThemeSwapService } from './SentinelThemeSwapService';
import type { SentinelSettings } from './types';

const PREFIX = 'postgresExplorer.sentinel';

export class SentinelSectionHandler implements SettingsSectionHandler {
  readonly section = 'sentinel';

  constructor(
    private readonly host: SettingsHubHostContext,
    private readonly themeSwapService: SentinelThemeSwapService,
  ) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        this.sendState();
        break;
      case 'update':
        await this.update(String(message.key ?? ''), message.value);
        break;
      case 'state':
        this.sendState();
        break;
      case 'prefillNexqlThemes':
        await this.prefillNexqlThemes();
        break;
      case 'openNexqlThemes':
        await vscode.env.openExternal(vscode.Uri.parse(NEXQL_THEMES_MARKETPLACE_URL));
        break;
    }
  }

  private readSettings(): SentinelSettings {
    const config = vscode.workspace.getConfiguration(PREFIX);
    return {
      enabled: config.get<boolean>('enabled', true),
      statusBarAccent: config.get<boolean>('statusBarAccent', true),
      notebookContextStrip: config.get<boolean>('notebookContextStrip', true),
      chromeAccent: config.get<boolean>('chromeAccent', true),
      tabBadges: config.get<boolean>('tabBadges', true),
      chatEnvChip: config.get<boolean>('chatEnvChip', true),
      notifyOnTransition: config.get<boolean>('notifyOnTransition', false),
      themeSwapEnabled: config.get<boolean>('themeSwap.enabled', false),
      themeSwapMode: config.get<'suggest' | 'auto'>('themeSwap.mode', 'suggest'),
      themeSwapThemes: config.get<Record<string, string>>('themeSwap.themes', {}),
    };
  }

  private sendState(): void {
    const themeNames = this.themeSwapService.listInstalledThemeLabels();
    const detected = this.themeSwapService.detectNexqlSentinelThemes();
    const settings = this.readSettings();
    const validatedThemes = this.themeSwapService.validateThemeLabels(settings.themeSwapThemes);

    this.host.post({
      type: 'sentinel/state',
      sentinel: { ...settings, themeSwapThemes: validatedThemes },
      themes: themeNames,
      nexqlThemesInstalled: this.themeSwapService.isNexqlThemesExtensionInstalled(),
      detectedNexqlThemes: detected,
      nexqlThemesUrl: NEXQL_THEMES_MARKETPLACE_URL,
    });
  }

  private async prefillNexqlThemes(): Promise<void> {
    const detected = this.themeSwapService.detectNexqlSentinelThemes();
    if (Object.keys(detected).length === 0) {
      this.host.post({
        type: 'sentinel/error',
        error: 'Install NexQL Themes and enable the Sentinel variant themes first.',
      });
      return;
    }
    const config = vscode.workspace.getConfiguration(PREFIX);
    const current = config.get<Record<string, string>>('themeSwap.themes', {});
    await config.update(
      'themeSwap.themes',
      { ...current, ...detected },
      vscode.ConfigurationTarget.Global,
    );
    this.sendState();
  }

  private async update(key: string, value: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration(PREFIX);
    const map: Record<string, string> = {
      enabled: 'enabled',
      statusBarAccent: 'statusBarAccent',
      notebookContextStrip: 'notebookContextStrip',
      chromeAccent: 'chromeAccent',
      tabBadges: 'tabBadges',
      chatEnvChip: 'chatEnvChip',
      notifyOnTransition: 'notifyOnTransition',
      themeSwapEnabled: 'themeSwap.enabled',
      themeSwapMode: 'themeSwap.mode',
      themeSwapThemes: 'themeSwap.themes',
    };

    const configKey = map[key];
    if (!configKey) {
      this.host.post({ type: 'sentinel/error', error: `Unknown setting: ${key}` });
      return;
    }

    try {
      if (key === 'themeSwapThemes' && value && typeof value === 'object') {
        const validated = this.themeSwapService.validateThemeLabels(value as Record<string, string>);
        await config.update('themeSwap.themes', validated, vscode.ConfigurationTarget.Global);
      } else {
        await config.update(configKey, value, vscode.ConfigurationTarget.Global);
      }
      this.sendState();
    } catch (err: unknown) {
      this.host.post({
        type: 'sentinel/error',
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendState();
    }
  }
}
