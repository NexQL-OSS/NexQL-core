import * as vscode from 'vscode';
import { SyncController } from './SyncController';
import type { SyncIndexEntry } from './SyncIndex';

/** Root node: "Shared by team". */
export class SharedTeamRootTreeItem extends vscode.TreeItem {
  constructor(itemCount: number) {
    super('Shared by team', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'shared-team-root';
    this.description = `${itemCount} item${itemCount === 1 ? '' : 's'}`;
    this.iconPath = new vscode.ThemeIcon('organization');
  }
}

/** Workspace folder under the shared root. */
export class WorkspaceFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly spaceId: string,
    name: string,
    itemCount: number,
  ) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'workspace-folder';
    this.description = `${itemCount} item${itemCount === 1 ? '' : 's'}`;
    this.iconPath = new vscode.ThemeIcon('folder-library');
  }
}

export function groupTeamItemsByWorkspace(
  items: Array<{ id: string; entry: SyncIndexEntry }>,
  kind?: SyncIndexEntry['kind'],
): Map<string, Array<{ id: string; entry: SyncIndexEntry }>> {
  const grouped = new Map<string, Array<{ id: string; entry: SyncIndexEntry }>>();
  for (const item of items) {
    if (kind && item.entry.kind !== kind) {
      continue;
    }
    const spaceId = item.entry.spaceId;
    if (!spaceId?.startsWith('ws_')) {
      continue;
    }
    const list = grouped.get(spaceId) ?? [];
    list.push(item);
    grouped.set(spaceId, list);
  }
  return grouped;
}

export function workspaceDisplayName(spaceId: string): string {
  return SyncController.getInstance().getWorkspaceName(spaceId) ?? spaceId;
}

export function isViewerForSpace(spaceId: string): boolean {
  return SyncController.getInstance().getRoleForSpace(spaceId) === 'viewer';
}
