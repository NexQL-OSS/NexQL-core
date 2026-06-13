import * as vscode from 'vscode';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { environmentLabel } from './constants';
import type { SentinelEnvironment } from './types';

const NOTEBOOK_SUFFIXES = ['.pgsql', '.pgquery'];

const BADGE_COLORS: Record<SentinelEnvironment, vscode.ThemeColor> = {
  production: new vscode.ThemeColor('charts.red'),
  staging: new vscode.ThemeColor('charts.orange'),
  development: new vscode.ThemeColor('charts.blue'),
};

const BADGE_LETTERS: Record<SentinelEnvironment, string> = {
  production: 'P',
  staging: 'S',
  development: 'D',
};

/**
 * Tab / explorer badges for environment-tagged notebook files.
 */
export class SentinelTabDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  constructor() {
    vscode.workspace.onDidChangeNotebookDocument(() => this._onDidChange.fire(undefined));
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('postgresExplorer.sentinel')) {
        this._onDidChange.fire(undefined);
      }
    });
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.isEnabled()) {
      return undefined;
    }

    const path = uri.path.toLowerCase();
    if (!NOTEBOOK_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
      return undefined;
    }

    const environment = this.resolveEnvironment(uri);
    if (!environment) {
      return undefined;
    }

    return {
      badge: BADGE_LETTERS[environment],
      color: BADGE_COLORS[environment],
      tooltip: `${environmentLabel(environment)} environment`,
    };
  }

  private isEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('postgresExplorer.sentinel');
    if (!config.get<boolean>('enabled', true)) {
      return false;
    }
    return config.get<boolean>('tabBadges', true);
  }

  private resolveEnvironment(uri: vscode.Uri): SentinelEnvironment | undefined {
    const open = vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === uri.toString());
    if (!open) {
      return undefined;
    }

    const metadata = ConnectionUtils.getEffectiveMetadata(open.metadata);
    const connection = ConnectionUtils.findConnectionWithFallback(metadata?.connectionId, open.metadata);
    const env = connection?.environment;
    if (env === 'production' || env === 'staging' || env === 'development') {
      return env;
    }
    return undefined;
  }
}
