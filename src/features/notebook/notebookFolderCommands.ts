import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { readNotebookSyncId } from '../../common/notebookSyncId';
import { createSyncIndex, recordSyncActivity, triggerInstantSync } from '../../services/syncRegistry';
import type { NotebooksTreeProvider, NotebookTreeItem } from '../../providers/NotebooksTreeProvider';

const FOLDER_NAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;
const NOTEBOOK_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateFolderName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Folder name is required';
  }
  if (!FOLDER_NAME_PATTERN.test(trimmed)) {
    return 'Use only letters, numbers, spaces, hyphens, underscores';
  }
  return null;
}

/** Re-index notebook file paths under a directory after move/rename. */
async function reindexNotebookFiles(context: vscode.ExtensionContext, rootDir: string): Promise<void> {
  const index = createSyncIndex(context);
  if (!index) {
    return;
  }
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.pgsql')) {
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
          const syncId = readNotebookSyncId(parsed);
          if (syncId) {
            index.update(syncId, {
              kind: 'notebook',
              filePath: full,
              name: path.basename(full, '.pgsql'),
            });
          }
        } catch {
          /* skip corrupt files */
        }
      }
    }
  };
  walk(rootDir);
  await index.flush();
}

/** List folder paths relative to globalStorage for move targets. */
function listNotebookFolderPaths(globalStorageRoot: string): Array<{ label: string; absPath: string }> {
  const results: Array<{ label: string; absPath: string }> = [
    { label: '(root)', absPath: globalStorageRoot },
  ];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const label = prefix ? `${prefix}/${entry.name}` : entry.name;
      results.push({ label, absPath: full });
      walk(full, label);
    }
  };
  walk(globalStorageRoot, '');
  return results;
}

export async function cmdCreateNotebookFolder(
  context: vscode.ExtensionContext,
  item: NotebookTreeItem | undefined,
  notebooksTreeProvider: NotebooksTreeProvider | undefined,
  globalStorageUri: vscode.Uri,
): Promise<void> {
  const parentUri = item?.itemType === 'folder' && item.uri ? item.uri : globalStorageUri;
  const name = await vscode.window.showInputBox({
    prompt: 'New folder name',
    placeHolder: 'e.g. Production / analytics',
    validateInput: validateFolderName,
  });
  if (!name) {
    return;
  }
  const safeName = ConnectionUtils.toSafeSegment(name.trim());
  const target = vscode.Uri.joinPath(parentUri, safeName);
  try {
    await vscode.workspace.fs.createDirectory(target);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not create folder: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  triggerInstantSync();
  notebooksTreeProvider?.refresh();
}

export async function cmdRenameNotebookFolder(
  context: vscode.ExtensionContext,
  item: NotebookTreeItem,
  notebooksTreeProvider: NotebooksTreeProvider | undefined,
): Promise<void> {
  if (!item?.uri || item.itemType !== 'folder') {
    return;
  }
  const oldName = item.label as string;
  const newName = await vscode.window.showInputBox({
    prompt: 'Rename folder',
    value: oldName,
    validateInput: validateFolderName,
  });
  if (!newName || newName.trim() === oldName) {
    return;
  }
  const safeName = ConnectionUtils.toSafeSegment(newName.trim());
  const newUri = vscode.Uri.joinPath(item.uri, '..', safeName);
  try {
    await vscode.workspace.fs.rename(item.uri, newUri, { overwrite: false });
    await reindexNotebookFiles(context, newUri.fsPath);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not rename folder: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  triggerInstantSync();
  notebooksTreeProvider?.refresh();
}

export async function cmdMoveNotebook(
  context: vscode.ExtensionContext,
  item: NotebookTreeItem,
  notebooksTreeProvider: NotebooksTreeProvider | undefined,
  globalStorageUri: vscode.Uri,
): Promise<void> {
  if (!item?.uri || item.itemType !== 'notebook-file') {
    return;
  }
  const folders = listNotebookFolderPaths(globalStorageUri.fsPath);
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.label, description: f.absPath, absPath: f.absPath })),
    { placeHolder: 'Select destination folder' },
  );
  if (!pick) {
    return;
  }
  const fileName = path.basename(item.uri.fsPath);
  const destUri = vscode.Uri.file(path.join(pick.absPath, fileName));
  if (path.resolve(item.uri.fsPath) === path.resolve(destUri.fsPath)) {
    return;
  }
  try {
    await vscode.workspace.fs.rename(item.uri, destUri, { overwrite: false });
    const raw = await vscode.workspace.fs.readFile(destUri);
    const parsed = JSON.parse(Buffer.from(raw).toString()) as Record<string, unknown>;
    const syncId = readNotebookSyncId(parsed);
    const index = syncId ? createSyncIndex(context) : undefined;
    if (syncId && index) {
      index.update(syncId, {
        kind: 'notebook',
        filePath: destUri.fsPath,
        name: path.basename(destUri.fsPath, '.pgsql'),
      });
      await index.flush();
      recordSyncActivity({
        kind: 'notebook',
        action: 'rename',
        itemId: syncId,
        name: path.basename(destUri.fsPath, '.pgsql'),
        previousName: item.label as string,
      });
    }
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not move notebook: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  triggerInstantSync();
  notebooksTreeProvider?.refresh();
}

export { NOTEBOOK_NAME_PATTERN, FOLDER_NAME_PATTERN };
