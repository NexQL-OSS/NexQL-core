import * as vscode from 'vscode';
import { SavedQueriesService } from '../savedQueries/SavedQueriesService';
import { SyncController } from './SyncController';
import { SyncIndex } from './SyncIndex';
import type { SyncKind } from './types';

export type LocalDeleteCloudChoice = 'cancel' | 'keep-cloud' | 'delete-cloud';

/** True when this item has been synced to cloud at least once. */
export function isItemSyncedToCloud(context: vscode.ExtensionContext, itemId: string): boolean {
  const config = SyncController.getInstance().getConfig();
  if (!config.providerId) {
    return false;
  }
  const entry = new SyncIndex(context).get(itemId);
  return entry?.syncedVersion != null;
}

/** Ask whether a local delete should also remove the cloud copy. */
export async function promptDeleteWithCloudChoice(itemLabel: string): Promise<LocalDeleteCloudChoice> {
  const choice = await vscode.window.showWarningMessage(
    `Delete "${itemLabel}"?`,
    {
      modal: true,
      detail:
        'Delete locally only keeps the item in cloud storage and on other synced devices.\n\n' +
        'Delete from cloud too removes it from cloud storage and other devices on next sync.',
    },
    'Delete locally only',
    'Delete from cloud too',
  );
  if (choice === 'Delete locally only') {
    return 'keep-cloud';
  }
  if (choice === 'Delete from cloud too') {
    return 'delete-cloud';
  }
  return 'cancel';
}

/**
 * Resolve cloud delete behavior for a synced item. Returns null when the user cancels.
 * Skips the prompt when sync is off or the item was never pushed to cloud.
 */
export async function resolveDeleteCloudChoice(
  context: vscode.ExtensionContext,
  itemId: string,
  itemLabel: string,
): Promise<'keep-cloud' | 'delete-cloud' | null> {
  if (!isItemSyncedToCloud(context, itemId)) {
    return 'keep-cloud';
  }
  const choice = await promptDeleteWithCloudChoice(itemLabel);
  return choice === 'cancel' ? null : choice;
}

/** Apply post-delete cloud policy for a locally removed synced item. */
export async function applyLocalDeleteCloudChoice(
  itemId: string,
  choice: Exclude<LocalDeleteCloudChoice, 'cancel'>,
): Promise<void> {
  const controller = SyncController.getInstance();
  if (choice === 'keep-cloud') {
    await controller.setItemExcluded(itemId, true);
    return;
  }
  await controller.removeFromCloud(itemId);
}

/** Delete a saved query after cloud policy + confirmation prompts. */
export async function deleteSavedQueryWithCloudPrompt(
  context: vscode.ExtensionContext,
  queryId: string,
  title: string,
): Promise<boolean> {
  const synced = isItemSyncedToCloud(context, queryId);
  const cloudChoice = await resolveDeleteCloudChoice(context, queryId, title);
  if (!cloudChoice) {
    return false;
  }
  if (!synced) {
    const confirm = await vscode.window.showWarningMessage(
      `Delete saved query "${title}"?`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') {
      return false;
    }
  }
  await SavedQueriesService.getInstance().deleteQuery(queryId, { cloudChoice });
  return true;
}

export type { SyncKind };
