import * as vscode from 'vscode';
import { SavedQueriesService } from '../savedQueries/SavedQueriesService';
import { SyncController } from './SyncController';
import { SyncIndex } from './SyncIndex';
import { NotebookSyncService } from './NotebookSyncService';
import { getOrCreateDeviceId } from './deviceId';
import { SYNC_LAST_CONFLICTS_KEY } from './constants';
import { isConflictCopyId } from './syncPreviewUtils';
import type { MergeConflict, SyncItemMeta, SyncKind } from './types';

export interface LiveConflictView {
  id: string;
  kind: SyncKind;
  name?: string;
  remoteDeviceId?: string;
  loserCopyName?: string;
  source: 'lastRun' | 'copy';
}

/**
 * Resolve sync conflicts: persisted merge conflicts and on-disk conflict copies.
 */
export class ConflictResolutionService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  listConflicts(): LiveConflictView[] {
    const fromRun = this.context.globalState.get<MergeConflict[]>(SYNC_LAST_CONFLICTS_KEY, []);
    const seen = new Set<string>();
    const out: LiveConflictView[] = [];

    for (const c of fromRun) {
      seen.add(c.id);
      out.push({
        id: c.id,
        kind: c.kind,
        name: c.localName,
        remoteDeviceId: c.remoteDeviceId,
        loserCopyName: c.loserCopyName,
        source: 'lastRun',
      });
    }

    for (const item of SyncController.getInstance().listSyncedItems()) {
      if (isConflictCopyId(item.id) && !seen.has(item.id)) {
        out.push({
          id: item.id,
          kind: item.kind,
          name: item.name ?? item.id,
          source: 'copy',
        });
      }
    }

    return out;
  }

  async resolveKeepMine(conflictId: string): Promise<void> {
    await this.removeConflictCopy(conflictId);
    await this.clearPersistedConflict(conflictId);
    await SyncController.getInstance().runSync({ direction: 'push' });
  }

  async resolveKeepTheirs(conflictId: string): Promise<void> {
    const baseId = conflictId.replace(/-conflict-\d+$/, '');
    await this.removeConflictCopy(conflictId);
    await this.removeLocalOriginal(baseId);
    await this.clearPersistedConflict(conflictId);
    await SyncController.getInstance().runSync({ direction: 'pull' });
  }

  async resolveKeepBoth(conflictId: string, newName: string): Promise<void> {
    const index = new SyncIndex(this.context);
    const entry = index.get(conflictId);
    if (entry?.kind === 'query') {
      const queries = SavedQueriesService.getInstance().getQueries();
      const q = queries.find((x) => x.id === conflictId);
      if (q) {
        await SavedQueriesService.getInstance().saveQuery({ ...q, title: newName });
      }
    } else if (entry?.kind === 'notebook') {
      const nbSvc = new NotebookSyncService(this.context, index);
      const deviceId = getOrCreateDeviceId(this.context);
      const items = await nbSvc.collectLocalNotebooks(deviceId);
      const match = items.find((i) => i.meta.id === conflictId);
      if (match) {
        const raw = JSON.parse(match.plaintext.toString()) as Record<string, unknown>;
        raw.name = newName;
        await nbSvc.applyNotebook(raw as never, match.meta);
      }
    }
    await this.clearPersistedConflict(conflictId);
    await SyncController.getInstance().schedulePushAfterConflict();
  }

  async deleteConflictCopy(conflictId: string): Promise<void> {
    await this.removeConflictCopy(conflictId);
    await this.clearPersistedConflict(conflictId);
  }

  async openDiff(conflictId: string): Promise<void> {
    const baseId = conflictId.replace(/-conflict-\d+$/, '');
    const controller = SyncController.getInstance();
    const original = await controller.getItemPlaintext(baseId);
    const conflict = await controller.getItemPlaintext(conflictId);
    if (!original || !conflict) {
      void vscode.window.showWarningMessage('Could not load both sides for diff.');
      return;
    }

    const leftUri = vscode.Uri.parse(`untitled:${baseId}-mine.json`);
    const rightUri = vscode.Uri.parse(`untitled:${conflictId}-theirs.json`);
    await vscode.workspace.openTextDocument(leftUri.with({ scheme: 'untitled' }));
    // Use temp files in mem
    const leftDoc = await vscode.workspace.openTextDocument({ content: original, language: 'json' });
    const rightDoc = await vscode.workspace.openTextDocument({ content: conflict, language: 'json' });
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftDoc.uri,
      rightDoc.uri,
      `${baseId} ↔ conflict`,
    );
  }

  private async removeConflictCopy(conflictId: string): Promise<void> {
    const index = new SyncIndex(this.context);
    const entry = index.get(conflictId);
    if (!entry) {
      return;
    }
    if (entry.kind === 'query') {
      await SavedQueriesService.getInstance().deleteQuery(conflictId);
    } else if (entry.kind === 'notebook') {
      await new NotebookSyncService(this.context, index).deleteNotebook({
        id: conflictId,
        kind: 'notebook',
        contentHash: '',
        revision: 0,
        updatedAt: Date.now(),
        deviceId: getOrCreateDeviceId(this.context),
        deleted: true,
      });
    }
    index.remove(conflictId);
    await index.flush();
  }

  private async removeLocalOriginal(baseId: string): Promise<void> {
    const index = new SyncIndex(this.context);
    const entry = index.get(baseId);
    if (entry?.kind === 'query') {
      await SavedQueriesService.getInstance().deleteQuery(baseId);
    } else if (entry?.kind === 'notebook') {
      await new NotebookSyncService(this.context, index).deleteNotebook({
        id: baseId,
        kind: 'notebook',
        contentHash: '',
        revision: 0,
        updatedAt: Date.now(),
        deviceId: getOrCreateDeviceId(this.context),
        deleted: true,
      });
    }
  }

  private async clearPersistedConflict(conflictId: string): Promise<void> {
    const baseId = conflictId.replace(/-conflict-\d+$/, '');
    const existing = this.context.globalState.get<MergeConflict[]>(SYNC_LAST_CONFLICTS_KEY, []);
    const next = existing.filter((c) => c.id !== conflictId && c.id !== baseId);
    await this.context.globalState.update(SYNC_LAST_CONFLICTS_KEY, next);
  }
}
