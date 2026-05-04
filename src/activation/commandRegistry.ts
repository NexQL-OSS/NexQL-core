import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { SavedQueriesTreeProvider } from '../providers/Phase7TreeProviders';
import { NotebooksTreeProvider } from '../providers/NotebooksTreeProvider';
import { cmdPasteTable } from '../commands/schema';
import { getCommandSpecs } from './commandSpecs';
import { WhatsNewManager } from './WhatsNewManager';
import { TelemetryService } from '../services/TelemetryService';

/**
 * Aggregates command specs and registers VS Code commands. Command IDs must stay stable (docs/API_STABILITY.md).
 */
export function registerAllCommands(
  context: vscode.ExtensionContext,
  databaseTreeProvider: DatabaseTreeProvider,
  chatViewProviderInstance: ChatViewProvider | undefined,
  outputChannel: vscode.OutputChannel,
  whatsNewManager: WhatsNewManager,
  savedQueriesTreeProvider?: SavedQueriesTreeProvider,
  notebooksTreeProvider?: NotebooksTreeProvider
): void {
  const commands = getCommandSpecs(
    context,
    databaseTreeProvider,
    chatViewProviderInstance,
    outputChannel,
    whatsNewManager,
    savedQueriesTreeProvider,
    notebooksTreeProvider
  );

  outputChannel.appendLine('Starting command registration...');

  commands.forEach(({ command, callback }) => {
    try {
      context.subscriptions.push(
        vscode.commands.registerCommand(command, async (...args: unknown[]) => {
          const telemetry = TelemetryService.getInstance();
          const group = command.split('.')[1] ?? 'unknown';
          telemetry.trackEvent('command_invoked', { group });
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
