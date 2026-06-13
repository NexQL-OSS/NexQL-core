import * as vscode from 'vscode';
import { environmentLabel } from './constants';
import type { SentinelEnvironment, SentinelSettings } from './types';

const THEME_SNAPSHOT_KEY = 'pgstudio.sentinel.themeSnapshot.v1';
const AUTO_CONFIRMED_KEY = 'pgstudio.sentinel.themeSwap.autoConfirmed';

export interface ThemeSwapApplyOptions {
  isTransition?: boolean;
}

/**
 * Optional full workbench theme swap on environment transition (Layer 3).
 * Restores the user's prior theme when the Sentinel gate closes.
 */
export class SentinelThemeSwapService implements vscode.Disposable {
  private appliedForEnvironment: SentinelEnvironment | undefined;
  private swappedBySentinel = false;
  private applyingTheme = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionContext: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.colorTheme')) {
          void this.onUserColorThemeChanged();
        }
      }),
    );
  }

  get isActive(): boolean {
    return this.swappedBySentinel && !!this.appliedForEnvironment;
  }

  isAppliedFor(environment: SentinelEnvironment): boolean {
    return this.swappedBySentinel && this.appliedForEnvironment === environment;
  }

  async applyForEnvironment(
    environment: SentinelEnvironment,
    settings: SentinelSettings,
    options: ThemeSwapApplyOptions = {},
  ): Promise<void> {
    if (!settings.themeSwapEnabled) {
      await this.restore(settings);
      return;
    }

    const themeLabel = settings.themeSwapThemes[environment];
    if (!themeLabel || !this.isThemeAvailable(themeLabel)) {
      return;
    }

    const currentTheme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');

    if (
      !options.isTransition
      && this.swappedBySentinel
      && this.appliedForEnvironment === environment
      && currentTheme === themeLabel
    ) {
      return;
    }

    if (currentTheme === themeLabel) {
      return;
    }

    if (settings.themeSwapMode === 'auto') {
      const confirmed = this.extensionContext.globalState.get<boolean>(AUTO_CONFIRMED_KEY, false);
      if (!confirmed) {
        const accept = await vscode.window.showWarningMessage(
          'Sentinel can switch your entire VS Code color theme when the notebook environment changes. Enable automatic theme swap?',
          { modal: true },
          'Enable Auto Swap',
          'Keep Suggest Mode',
        );
        if (accept === 'Enable Auto Swap') {
          await this.extensionContext.globalState.update(AUTO_CONFIRMED_KEY, true);
        } else {
          await vscode.workspace
            .getConfiguration('postgresExplorer.sentinel')
            .update('themeSwap.mode', 'suggest', vscode.ConfigurationTarget.Global);
          await this.suggestSwap(environment, themeLabel, currentTheme, settings);
          return;
        }
      }
      await this.captureSnapshotIfNeeded(currentTheme, settings);
      await this.setColorTheme(themeLabel);
      this.appliedForEnvironment = environment;
      this.swappedBySentinel = true;
      return;
    }

    await this.suggestSwap(environment, themeLabel, currentTheme, settings);
  }

  async restore(settings?: SentinelSettings): Promise<void> {
    const snapshot = this.extensionContext.globalState.get<string>(THEME_SNAPSHOT_KEY);
    this.appliedForEnvironment = undefined;
    this.swappedBySentinel = false;

    const resolvedSettings = settings ?? this.readSettingsFromConfig();
    if (!snapshot || this.isSentinelThemeLabel(snapshot, resolvedSettings)) {
      await this.extensionContext.globalState.update(THEME_SNAPSHOT_KEY, undefined);
      return;
    }

    const current = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    if (current !== snapshot) {
      await this.setColorTheme(snapshot);
    }
    await this.extensionContext.globalState.update(THEME_SNAPSHOT_KEY, undefined);
  }

  validateThemeLabels(themes: Record<string, string>): Record<string, string> {
    const available = new Set(this.listInstalledThemeLabels());
    const valid: Record<string, string> = {};
    for (const [env, label] of Object.entries(themes)) {
      if (label && available.has(label)) {
        valid[env] = label;
      }
    }
    return valid;
  }

  listInstalledThemeLabels(): string[] {
    const themes = new Set<string>();
    for (const ext of vscode.extensions.all) {
      const contributes = ext.packageJSON?.contributes?.themes;
      if (!Array.isArray(contributes)) {
        continue;
      }
      for (const theme of contributes) {
        if (theme?.label) {
          themes.add(String(theme.label));
        }
      }
    }
    return [...themes].sort((a, b) => a.localeCompare(b));
  }

  detectNexqlSentinelThemes(): Partial<Record<SentinelEnvironment, string>> {
    const labels = this.listInstalledThemeLabels();
    const map: Partial<Record<SentinelEnvironment, string>> = {};
    const pairs: Array<[SentinelEnvironment, string]> = [
      ['production', 'NexQL Sentinel Prod'],
      ['staging', 'NexQL Sentinel Staging'],
      ['development', 'NexQL Sentinel Dev'],
    ];
    for (const [env, label] of pairs) {
      if (labels.includes(label)) {
        map[env] = label;
      }
    }
    return map;
  }

  isNexqlThemesExtensionInstalled(): boolean {
    return vscode.extensions.all.some((ext) => ext.id === 'ric-v.nexql-themes' || ext.id.endsWith('.nexql-themes'));
  }

  private async suggestSwap(
    environment: SentinelEnvironment,
    themeLabel: string,
    currentTheme: string | undefined,
    settings: SentinelSettings,
  ): Promise<void> {
    const envLabel = environmentLabel(environment);
    const choice = await vscode.window.showInformationMessage(
      `${envLabel}: switch color theme to "${themeLabel}"?`,
      'Apply Theme',
      'Dismiss',
    );
    if (choice !== 'Apply Theme') {
      return;
    }
    await this.captureSnapshotIfNeeded(currentTheme, settings);
    await this.setColorTheme(themeLabel);
    this.appliedForEnvironment = environment;
    this.swappedBySentinel = true;
  }

  private async onUserColorThemeChanged(): Promise<void> {
    if (this.applyingTheme || !this.swappedBySentinel || !this.appliedForEnvironment) {
      return;
    }

    const settings = this.readSettingsFromConfig();
    const expected = settings.themeSwapThemes[this.appliedForEnvironment];
    const current = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    if (!expected || current === expected) {
      return;
    }

    await this.extensionContext.globalState.update(THEME_SNAPSHOT_KEY, current);
    this.swappedBySentinel = false;
    this.appliedForEnvironment = undefined;
  }

  private async captureSnapshotIfNeeded(
    currentTheme: string | undefined,
    settings: SentinelSettings,
  ): Promise<void> {
    if (this.extensionContext.globalState.get(THEME_SNAPSHOT_KEY) || !currentTheme) {
      return;
    }
    if (this.isSentinelThemeLabel(currentTheme, settings)) {
      return;
    }
    await this.extensionContext.globalState.update(THEME_SNAPSHOT_KEY, currentTheme);
  }

  private isSentinelThemeLabel(label: string, settings: SentinelSettings): boolean {
    const labels = new Set<string>();
    for (const theme of Object.values(settings.themeSwapThemes)) {
      if (theme) {
        labels.add(theme);
      }
    }
    for (const theme of Object.values(this.detectNexqlSentinelThemes())) {
      if (theme) {
        labels.add(theme);
      }
    }
    return labels.has(label);
  }

  private readSettingsFromConfig(): SentinelSettings {
    const config = vscode.workspace.getConfiguration('postgresExplorer.sentinel');
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

  private async setColorTheme(label: string): Promise<void> {
    this.applyingTheme = true;
    try {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', label, vscode.ConfigurationTarget.Global);
    } finally {
      setTimeout(() => {
        this.applyingTheme = false;
      }, 0);
    }
  }

  private isThemeAvailable(label: string): boolean {
    return this.listInstalledThemeLabels().includes(label);
  }

  dispose(): void {
    void this.restore();
    this.disposables.forEach((d) => d.dispose());
  }
}
