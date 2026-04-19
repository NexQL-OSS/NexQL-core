import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { SavedQueriesTreeProvider } from '../providers/Phase7TreeProviders';
import { NotebooksTreeProvider } from '../providers/NotebooksTreeProvider';
import { cmdPasteTable } from '../commands/schema';
import { getCommandSpecs } from './commandSpecs';

/**
 * Aggregates command specs and registers VS Code commands. Command IDs must stay stable (docs/API_STABILITY.md).
 */
export function registerAllCommands(
  context: vscode.ExtensionContext,
  databaseTreeProvider: DatabaseTreeProvider,
  chatViewProviderInstance: ChatViewProvider | undefined,
  outputChannel: vscode.OutputChannel,
  savedQueriesTreeProvider?: SavedQueriesTreeProvider,
  notebooksTreeProvider?: NotebooksTreeProvider
): void {
  const commands = getCommandSpecs(
    context,
    databaseTreeProvider,
    chatViewProviderInstance,
    outputChannel,
    savedQueriesTreeProvider,
    notebooksTreeProvider
  );

  outputChannel.appendLine('Starting command registration...');

  commands.forEach(({ command, callback }) => {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(command, callback as (...args: unknown[]) => void));
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
