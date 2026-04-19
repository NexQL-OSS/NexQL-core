import * as vscode from 'vscode';
import { ConnectionUtils } from '../utils/connectionUtils';
import { WorkspaceStateService } from '../services/WorkspaceStateService';
import { ErrorHandlers } from './helper';
import { statusBar } from '../extension';

/**
 * Pick connection + database and store as this workspace’s default.
 * If a PostgreSQL notebook is active, its metadata is updated to match.
 */
export async function switchWorkspaceDefaultConnection(): Promise<void> {
  try {
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showWarningMessage('Open a folder or workspace to set a workspace default connection.');
      return;
    }

    const ws = WorkspaceStateService.getInstance();
    const defaults = ws.getDefaults();

    const selected = await ConnectionUtils.showConnectionPicker(defaults.lastConnectionId);
    if (!selected) {
      return;
    }

    const selectedDb = await ConnectionUtils.showDatabasePicker(selected, defaults.lastDatabaseName);
    if (!selectedDb) {
      return;
    }

    await ws.recordDatabaseSwitch(selected.id, selectedDb);

    const editor = ConnectionUtils.getActivePostgresNotebook();
    if (editor) {
      await ConnectionUtils.updateNotebookMetadata(editor.notebook, {
        connectionId: selected.id,
        databaseName: selectedDb,
        host: selected.host,
        port: selected.port,
        username: selected.username,
      });
    }

    vscode.window.showInformationMessage(
      `Workspace default: ${selected.name || selected.host} → ${selectedDb}`,
    );
    statusBar?.update();
  } catch (err: unknown) {
    await ErrorHandlers.handleCommandError(err, 'set workspace default connection');
  }
}
