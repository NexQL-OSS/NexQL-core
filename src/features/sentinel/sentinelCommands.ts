import * as vscode from 'vscode';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { SENTINEL_STRIP_HIDDEN_METADATA_KEY } from './constants';
import type { SentinelContextService } from './SentinelContextService';

export function registerSentinelCommands(
  context: vscode.ExtensionContext,
  getSentinel: () => SentinelContextService | undefined,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('postgres-explorer.sentinel.toggleNotebookStrip', async () => {
      const editor = ConnectionUtils.getActivePostgresNotebook();
      if (!editor) {
        vscode.window.showInformationMessage('Open a NexQL notebook to toggle the in-editor context strip.');
        return;
      }

      const hidden = editor.notebook.metadata?.[SENTINEL_STRIP_HIDDEN_METADATA_KEY] === true;
      const applied = await ConnectionUtils.updateNotebookMetadata(editor.notebook, {
        [SENTINEL_STRIP_HIDDEN_METADATA_KEY]: !hidden,
      });
      if (!applied) {
        vscode.window.showWarningMessage('Could not update notebook metadata.');
        return;
      }

      await getSentinel()?.sync();
      vscode.window.showInformationMessage(
        hidden ? 'Notebook context strip shown for this notebook.' : 'Notebook context strip hidden for this notebook.',
      );
    }),
    vscode.commands.registerCommand('postgres-explorer.sentinel.openSettings', async () => {
      await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sentinel' });
    }),
  );
}
