import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';

import { SavedQueriesTreeProvider } from '../providers/Phase7TreeProviders';
import { NotebooksTreeProvider } from '../providers/NotebooksTreeProvider';
import { cmdPasteTable } from '../commands/schema';
import { getCommandSpecs } from './commandSpecs';
import { isProBuild } from '../common/buildTier';
import { WhatsNewManager } from './WhatsNewManager';
import { TelemetryService } from '../services/TelemetryService';

/**
 * Aggregates command specs and registers VS Code commands. Command IDs must stay stable (docs/API_STABILITY.md).
 */
export function registerAllCommands(
  context: vscode.ExtensionContext,
  databaseTreeProvider: DatabaseTreeProvider,
  outputChannel: vscode.OutputChannel,
  whatsNewManager: WhatsNewManager,
  savedQueriesTreeProvider?: SavedQueriesTreeProvider,
  notebooksTreeProvider?: NotebooksTreeProvider
): void {
  const commands = getCommandSpecs(
    context,
    databaseTreeProvider,
    outputChannel,
    whatsNewManager,
    savedQueriesTreeProvider,
    notebooksTreeProvider
  );

  outputChannel.appendLine('Starting command registration...');

  commands.forEach(({ command, callback, proOnly }) => {
    // Premium commands are declared only in the pro manifest and registered
    // only in pro builds — the free/OSS build skips them entirely.
    if (proOnly && !isProBuild()) {
      return;
    }
    try {
      context.subscriptions.push(
        vscode.commands.registerCommand(command, async (...args: unknown[]) => {
          const telemetry = TelemetryService.getInstance();
          const group = command.split('.')[1] ?? 'unknown';
          telemetry.trackEvent('command_invoked', { group });
          telemetry.trackCommandRepeat(command);
          await Promise.resolve(callback(...args));
        }),
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      outputChannel.appendLine(`Failed to register command ${command}: ${err}`);
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('postgresExplorer.savedQueries.refresh', () => {
      if (savedQueriesTreeProvider) {
        savedQueriesTreeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('postgres-explorer.pasteTable', (item: DatabaseTreeItem) => cmdPasteTable(item, context))
  );

  outputChannel.appendLine('All commands registered successfully.');
}
