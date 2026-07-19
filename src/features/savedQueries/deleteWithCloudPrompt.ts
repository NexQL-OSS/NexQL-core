import * as vscode from 'vscode';
import { getCloudDeletePrompt } from '../../services/syncRegistry';
import { SavedQueriesService } from './SavedQueriesService';

/**
 * Delete a saved query, asking about the cloud copy first when Cloud Sync is
 * active. In the free build (no sync feature registered) this falls back to
 * a plain local confirmation — saved-query deletion itself is a core
 * feature, only the cloud-awareness is premium.
 */
export async function deleteSavedQueryWithCloudPrompt(
  context: vscode.ExtensionContext,
  queryId: string,
  title: string,
): Promise<boolean> {
  const cloudPrompt = getCloudDeletePrompt();
  const synced = cloudPrompt?.isItemSyncedToCloud(context, queryId) ?? false;
  const cloudChoice = cloudPrompt
    ? await cloudPrompt.resolveDeleteCloudChoice(context, queryId, title)
    : 'keep-cloud';
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
