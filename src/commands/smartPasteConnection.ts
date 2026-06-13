import * as vscode from 'vscode';
import { appendWorkspaceConnection } from '../features/connections/connectionStore';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { connectionInfoFromDatabaseUrl } from '../utils/databaseUrl';
import { ErrorHandlers } from './helper';
import { SettingsHubPanel } from '../features/settings/SettingsHubPanel';

const URL_PATTERN = /^postgres(ql)?:\/\//i;

export async function cmdSmartPasteConnection(
  context: vscode.ExtensionContext,
  databaseTreeProvider: DatabaseTreeProvider,
): Promise<void> {
  try {
    const clipboard = await vscode.env.clipboard.readText();
    const trimmed = clipboard.trim();
    if (!URL_PATTERN.test(trimmed)) {
      const choice = await vscode.window.showInformationMessage(
        'Clipboard does not contain a postgres:// URL. Open connection settings instead?',
        'Open Settings',
        'Cancel',
      );
      if (choice === 'Open Settings') {
        SettingsHubPanel.show(context.extensionUri, context, {
          section: 'connections',
          addConnection: true,
        });
      }
      return;
    }

    const id = `paste-${Date.now()}`;
    let info;
    try {
      info = connectionInfoFromDatabaseUrl(trimmed, id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Invalid connection URL: ${msg}`);
      return;
    }

    const action = await vscode.window.showQuickPick(
      [
        {
          label: 'Add connection',
          description: `${info.host}:${info.port}/${info.database}`,
          action: 'add' as const,
        },
        {
          label: 'Open in connection editor',
          description: 'Review fields before saving',
          action: 'editor' as const,
        },
      ],
      { placeHolder: 'PostgreSQL URL detected in clipboard' },
    );
    if (!action) {
      return;
    }

    if (action.action === 'editor') {
      SettingsHubPanel.show(context.extensionUri, context, {
        section: 'connections',
        addConnection: true,
        prefillConnectionUrl: trimmed,
      });
      return;
    }

    const name = await vscode.window.showInputBox({
      title: 'Connection name',
      value: info.name,
      ignoreFocusOut: true,
    });
    if (!name?.trim()) {
      return;
    }

    await appendWorkspaceConnection(context, { ...info, name: name.trim() });
    databaseTreeProvider.refresh();
    vscode.window.showInformationMessage(`Saved connection "${name.trim()}"`);
  } catch (err: unknown) {
    await ErrorHandlers.handleCommandError(err, 'paste connection from clipboard');
  }
}
