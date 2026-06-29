import * as vscode from 'vscode';
import type { ConnectionConfig } from '../common/types';
import { isTransactionPooler } from '../lib/platform/detectPlatform';

const GLOBAL_DISMISS_KEY = 'postgresExplorer.poolerWarning.dismissedGlobal';

/**
 * One-time dismissable warning when a transaction-mode pooler is detected.
 */
export class PoolerWarningService {
  private static instance: PoolerWarningService;
  /** Warn at most once per saved connection per VS Code session. */
  private readonly warnedConnectionIds = new Set<string>();
  private readonly warnInFlight = new Set<string>();

  public static getInstance(): PoolerWarningService {
    if (!PoolerWarningService.instance) {
      PoolerWarningService.instance = new PoolerWarningService();
    }
    return PoolerWarningService.instance;
  }

  public async maybeWarn(config: ConnectionConfig): Promise<void> {
    if (!isTransactionPooler(config.host, config.port)) {
      return;
    }

    const dismissed = vscode.workspace
      .getConfiguration()
      .get<boolean>(GLOBAL_DISMISS_KEY);
    if (dismissed) {
      return;
    }

    if (
      this.warnedConnectionIds.has(config.id) ||
      this.warnInFlight.has(config.id)
    ) {
      return;
    }

    this.warnInFlight.add(config.id);
    try {
      const docsAction = 'Open compatibility docs';
      const choice = await vscode.window.showWarningMessage(
        'This connection uses a transaction-mode pooler. Multi-cell transactions, SET, LISTEN/NOTIFY, and temp tables may not work reliably. Prefer a direct or session pooler endpoint.',
        { modal: false },
        docsAction,
        'Dismiss',
      );

      if (choice === docsAction) {
        void vscode.env.openExternal(
          vscode.Uri.parse(
            'https://github.com/dev-asterix/NexQL/blob/main/docs/COMPATIBILITY.md',
          ),
        );
      } else if (choice === 'Dismiss') {
        await vscode.workspace
          .getConfiguration()
          .update(GLOBAL_DISMISS_KEY, true, vscode.ConfigurationTarget.Global);
      }

      // Once shown (or dismissed via X), do not repeat for this connection this session.
      this.warnedConnectionIds.add(config.id);
    } finally {
      this.warnInFlight.delete(config.id);
    }
  }
}
