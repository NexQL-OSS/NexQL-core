import * as vscode from 'vscode';
import {
  getChromeAccentColors,
  SENTINEL_ACCENT_SNAPSHOT_KEY,
  SENTINEL_OWNED_COLOR_KEYS,
  type SentinelOwnedColorKey,
} from './constants';
import type { SentinelEnvironment } from './types';

type ColorCustomizations = Record<string, string | Record<string, string>>;

/**
 * Applies scoped workbench chrome tints while Sentinel gate is open.
 * Tracks and restores only keys Sentinel owns — never clobbers unrelated customizations.
 */
export class SentinelAccentService implements vscode.Disposable {
  private activeEnvironment: SentinelEnvironment | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionContext: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('postgresExplorer.sentinel.chromeAccent') && this.activeEnvironment) {
          void this.apply(this.activeEnvironment);
        }
      }),
    );
  }

  get isActive(): boolean {
    return !!this.activeEnvironment;
  }

  async apply(environment: SentinelEnvironment): Promise<void> {
    if (!this.isChromeAccentEnabled() || this.isHighContrastTheme()) {
      await this.restore();
      this.activeEnvironment = undefined;
      return;
    }

    if (this.activeEnvironment === environment) {
      return;
    }

    await this.captureSnapshotIfNeeded();
    this.activeEnvironment = environment;

    const accent = getChromeAccentColors(environment);
    const current = this.readColorCustomizations();
    const next: ColorCustomizations = { ...current };

    for (const key of SENTINEL_OWNED_COLOR_KEYS) {
      next[key] = accent[key];
    }

    await this.writeColorCustomizations(next);
  }

  async restore(): Promise<void> {
    if (!this.activeEnvironment && !this.extensionContext.globalState.get(SENTINEL_ACCENT_SNAPSHOT_KEY)) {
      return;
    }

    this.activeEnvironment = undefined;
    const snapshot = this.extensionContext.globalState.get<Partial<Record<SentinelOwnedColorKey, string | undefined>>>(
      SENTINEL_ACCENT_SNAPSHOT_KEY,
    );

    const current = this.readColorCustomizations();
    const next: ColorCustomizations = { ...current };

    if (snapshot) {
      for (const key of SENTINEL_OWNED_COLOR_KEYS) {
        const previous = snapshot[key];
        if (previous === undefined) {
          delete next[key];
        } else {
          next[key] = previous;
        }
      }
    } else {
      for (const key of SENTINEL_OWNED_COLOR_KEYS) {
        delete next[key];
      }
    }

    await this.writeColorCustomizations(next);
    await this.extensionContext.globalState.update(SENTINEL_ACCENT_SNAPSHOT_KEY, undefined);
  }

  private isChromeAccentEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('postgresExplorer.sentinel')
      .get<boolean>('chromeAccent', true);
  }

  private isHighContrastTheme(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.HighContrast
      || kind === vscode.ColorThemeKind.HighContrastLight;
  }

  private readColorCustomizations(): ColorCustomizations {
    return vscode.workspace.getConfiguration('workbench').get<ColorCustomizations>('colorCustomizations', {});
  }

  private async writeColorCustomizations(value: ColorCustomizations): Promise<void> {
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorCustomizations', value, vscode.ConfigurationTarget.Global);
  }

  private async captureSnapshotIfNeeded(): Promise<void> {
    const existing = this.extensionContext.globalState.get(SENTINEL_ACCENT_SNAPSHOT_KEY);
    if (existing) {
      return;
    }

    const current = this.readColorCustomizations();
    const snapshot: Partial<Record<SentinelOwnedColorKey, string | undefined>> = {};
    for (const key of SENTINEL_OWNED_COLOR_KEYS) {
      const value = current[key];
      snapshot[key] = typeof value === 'string' ? value : undefined;
    }
    await this.extensionContext.globalState.update(SENTINEL_ACCENT_SNAPSHOT_KEY, snapshot);
  }

  dispose(): void {
    void this.restore();
    this.disposables.forEach((d) => d.dispose());
  }
}
