import * as vscode from 'vscode';
import { SyncController } from './SyncController';
import { WorkspaceSharingService } from './WorkspaceSharingService';
import {
  allowedSyncProviders,
  ProFeature,
  requirePro,
} from '../../services/featureGates';
import { readNotebookSyncId } from './notebookSyncId';
import type { WorkspaceView } from './types';

/** Tree context-menu item shape (saved query or notebook). */
type SyncContextTreeItem = {
  id?: string;
  query?: { id?: string };
  uri?: vscode.Uri;
};

export async function resolveSyncItemIdFromTreeItem(
  item?: SyncContextTreeItem,
): Promise<string | undefined> {
  if (!item) {
    return undefined;
  }
  if (item.query?.id) {
    return item.query.id;
  }
  if (item.uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(item.uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
      return readNotebookSyncId(parsed);
    } catch {
      return undefined;
    }
  }
  return item.id;
}

export async function cmdSyncSetup(_context: vscode.ExtensionContext): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  await vscode.commands.executeCommand('postgres-explorer.settingsHub', {
    section: 'sync',
    wizard: allowedSyncProviders().includes('cloud') ? 'cloud' : 'advanced',
  });
}

/** Pick an existing workspace or create a new one. */
async function pickOrCreateWorkspace(service: WorkspaceSharingService): Promise<WorkspaceView | undefined> {
  const workspaces = await service.listWorkspaces();
  const owned = workspaces.filter((w) => w.role === 'owner');
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(add) New workspace…', id: '__new__' },
      ...owned.map((w) => ({ label: `$(organization) ${w.name}`, description: w.ownerEmail, id: w.spaceId })),
    ],
    { title: 'Share to workspace', placeHolder: 'Choose a team workspace' },
  );
  if (!pick) {
    return undefined;
  }
  if (pick.id === '__new__') {
    const name = await vscode.window.showInputBox({
      title: 'New workspace',
      prompt: 'Name for the shared team workspace',
      ignoreFocusOut: true,
    });
    if (!name?.trim()) {
      return undefined;
    }
    return service.createWorkspace(name.trim());
  }
  return owned.find((w) => w.spaceId === pick.id);
}

/** Create/select a team workspace and invite a member. */
export async function cmdSyncShare(
  context: vscode.ExtensionContext,
  _treeItem?: SyncContextTreeItem,
): Promise<void> {
  if (!(await requirePro(ProFeature.SyncSharing))) {
    return;
  }
  if (SyncController.getInstance().getConfig().providerId !== 'cloud') {
    await vscode.window.showWarningMessage(
      'Team workspaces require the NexQL Cloud sync backend. Set it up under NexQL Sync: Set Up Sync.',
    );
    return;
  }

  const service = new WorkspaceSharingService(context);
  try {
    const workspace = await pickOrCreateWorkspace(service);
    if (!workspace) {
      return;
    }
    const email = await vscode.window.showInputBox({
      title: `Invite to "${workspace.name}"`,
      prompt: "Team member's account email (they must have NexQL sync enabled)",
      placeHolder: 'teammate@example.com',
      ignoreFocusOut: true,
      validateInput: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? undefined : 'Enter a valid email'),
    });
    if (!email) {
      return;
    }
    const role = await vscode.window.showQuickPick(
      [
        { label: 'Editor', detail: 'Can read and write shared items', id: 'editor' as const },
        { label: 'Viewer', detail: 'Read-only access', id: 'viewer' as const },
      ],
      { title: 'Member role' },
    );
    if (!role) {
      return;
    }
    await service.addMember(workspace.spaceId, email.trim(), role.id);
    await vscode.window.showInformationMessage(`Invited ${email.trim()} to "${workspace.name}" as ${role.id}.`);
  } catch (e) {
    await vscode.window.showErrorMessage(`Share failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** View team workspaces you belong to and manage members of ones you own. */
export async function cmdSyncImportShares(context: vscode.ExtensionContext): Promise<void> {
  if (!(await requirePro(ProFeature.SyncSharing))) {
    return;
  }
  const service = new WorkspaceSharingService(context);
  let workspaces: WorkspaceView[];
  try {
    workspaces = await service.listWorkspaces();
  } catch (e) {
    await vscode.window.showErrorMessage(`Could not load workspaces: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!workspaces.length) {
    await vscode.window.showInformationMessage('You are not in any team workspaces yet.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    workspaces.map((w) => ({ label: `$(organization) ${w.name}`, description: `${w.role} · ${w.ownerEmail}`, ws: w })),
    { title: 'Team workspaces', placeHolder: 'Select a workspace to view members' },
  );
  if (!pick) {
    return;
  }
  const members = await service.listMembers(pick.ws.spaceId);
  const memberPick = await vscode.window.showQuickPick(
    members.map((m) => ({ label: m.email, description: m.role, member: m })),
    { title: `Members of "${pick.ws.name}"`, placeHolder: pick.ws.role === 'owner' ? 'Select a member to remove' : 'Members (read-only)' },
  );
  if (memberPick && pick.ws.role === 'owner' && memberPick.member.role !== 'owner') {
    const confirm = await vscode.window.showWarningMessage(
      `Remove ${memberPick.member.email} from "${pick.ws.name}"?`,
      'Remove',
    );
    if (confirm === 'Remove') {
      await service.removeMember(pick.ws.spaceId, memberPick.member.email);
      await vscode.window.showInformationMessage(`Removed ${memberPick.member.email}.`);
    }
  }
}

export async function cmdSyncNow(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  await SyncController.getInstance().runSync({ userInitiated: true });
}

export async function cmdSyncPull(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  await SyncController.getInstance().pullOnly();
}

export async function cmdSyncPush(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  await SyncController.getInstance().pushOnly();
}

export async function cmdSyncPreview(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync', tab: 'preview' });
}

export async function cmdSyncConflicts(): Promise<void> {
  await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync', tab: 'items' });
}

export async function cmdSyncReplaceLocal(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const typed = await vscode.window.showInputBox({
    title: 'Clear local & pull from cloud',
    prompt: 'Type REPLACE to wipe local synced state and pull everything fresh from the cloud',
    ignoreFocusOut: true,
  });
  if (typed !== 'REPLACE') {
    return;
  }
  const ok = await SyncController.getInstance().replaceLocalWithCloud();
  void vscode.window.showInformationMessage(ok ? 'Local data replaced from cloud.' : 'Replace failed.');
}

export async function cmdSyncReplaceRemote(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const typed = await vscode.window.showInputBox({
    title: 'Clear cloud & push from this device',
    prompt: "Type REPLACE to wipe the cloud copy and push this device's data",
    ignoreFocusOut: true,
  });
  if (typed !== 'REPLACE') {
    return;
  }
  const ok = await SyncController.getInstance().replaceCloudWithLocal();
  void vscode.window.showInformationMessage(ok ? 'Cloud replaced from local.' : 'Replace failed.');
}

export async function cmdSyncRebuildIndex(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const typed = await vscode.window.showInputBox({
    title: 'Rebuild sync index',
    prompt: 'Type REPLACE to rebuild the local sync index from disk',
    ignoreFocusOut: true,
  });
  if (typed !== 'REPLACE') {
    return;
  }
  const count = await SyncController.getInstance().rebuildSyncIndex();
  void vscode.window.showInformationMessage(`Rebuilt index for ${count} item(s).`);
}

export async function cmdSyncRepair(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    'Repair sync state and pull the latest from the cloud?',
    'Repair Sync',
  );
  if (confirm !== 'Repair Sync') {
    return;
  }
  const ok = await SyncController.getInstance().repair();
  void vscode.window.showInformationMessage(ok ? 'Sync repaired successfully.' : 'Sync repair failed.');
}

export async function cmdSyncDiagnostics(): Promise<void> {
  await SyncController.getInstance().runDiagnostics();
}

export async function cmdSyncExcludeItem(itemId?: string): Promise<void> {
  if (!itemId) {
    void vscode.window.showWarningMessage(
      'Could not resolve this item for sync exclusion. Exclude it from NexQL Sync settings instead.',
    );
    return;
  }
  await SyncController.getInstance().setItemExcluded(itemId, true);
  void vscode.window.showInformationMessage('Item excluded from sync on this device.');
}

export async function cmdSyncStatus(): Promise<void> {
  const controller = SyncController.getInstance();
  const config = controller.getConfig();
  await vscode.window.showInformationMessage(
    `Sync: ${controller.getStatus()} | provider: ${config.providerId ?? 'none'} | conflicts: ${controller.getConflictCount()}`,
  );
}

/** Security/privacy info — pass 1 stores items in plaintext (TLS in transit). */
export async function cmdSyncShowSecretKey(_context: vscode.ExtensionContext): Promise<void> {
  await vscode.window.showInformationMessage(
    'PgStudio Sync stores your connections (without passwords), saved queries and notebooks on the sync backend in plain text, protected by TLS in transit and your account credentials. Passwords and SSH/SSL key paths never leave this device. End-to-end encryption is planned for a future release.',
    { modal: true },
  );
}

export async function cmdSyncPause(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const controller = SyncController.getInstance();
  const config = controller.getConfig();
  await controller.saveConfig({ ...config, paused: !config.paused });
  void vscode.window.showInformationMessage(config.paused ? 'Sync resumed' : 'Sync paused');
}

export async function cmdSyncSignOut(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Sign out of sync? Local data is kept; the cloud copy remains.',
    'Sign Out',
  );
  if (confirm === 'Sign Out') {
    await SyncController.getInstance().signOut();
  }
}

export async function cmdSyncStatusMenu(context?: vscode.ExtensionContext): Promise<void> {
  const controller = SyncController.getInstance();
  const config = controller.getConfig();

  if (!config.providerId && !(await requirePro(ProFeature.CloudBackup))) {
    return;
  }

  const configured = !!config.providerId;
  const shareItems = config.providerId === 'cloud'
    ? [
        { label: '$(person-add) Share to Workspace…', id: 'share' },
        { label: '$(organization) Manage Workspaces…', id: 'importShares' },
      ]
    : [];
  const items = configured
    ? [
        { label: '$(sync) Sync Now', id: 'now' },
        { label: '$(cloud-download) Pull Only', id: 'pull' },
        { label: '$(cloud-upload) Push Only', id: 'push' },
        { label: '$(eye) Preview Sync…', id: 'preview' },
        ...shareItems,
        { label: '$(info) Show Status', id: 'status' },
        { label: '$(shield) Privacy & Security', id: 'secret' },
        { label: config.paused ? '$(play) Resume Sync' : '$(debug-pause) Pause Sync', id: 'pause' },
        { label: '$(wrench) Repair Sync', id: 'repair' },
        { label: '$(sign-out) Sign Out', id: 'signout' },
        { label: '$(settings-gear) Open Settings', id: 'settings' },
      ]
    : [
        { label: '$(cloud-upload) Set Up Sync', id: 'setup' },
        { label: '$(settings-gear) Open Settings', id: 'settings' },
      ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'PgStudio Sync',
    placeHolder: 'Choose an action',
  });
  if (!pick) {
    return;
  }

  switch (pick.id) {
    case 'setup':
      if (context) {
        await cmdSyncSetup(context);
      }
      break;
    case 'now':
      await cmdSyncNow();
      break;
    case 'pull':
      await cmdSyncPull();
      break;
    case 'push':
      await cmdSyncPush();
      break;
    case 'preview':
      await cmdSyncPreview();
      break;
    case 'share':
      if (context) {
        await cmdSyncShare(context);
      }
      break;
    case 'importShares':
      if (context) {
        await cmdSyncImportShares(context);
      }
      break;
    case 'status':
      await cmdSyncStatus();
      break;
    case 'secret':
      if (context) {
        await cmdSyncShowSecretKey(context);
      }
      break;
    case 'pause':
      await cmdSyncPause();
      break;
    case 'repair':
      await cmdSyncRepair();
      break;
    case 'signout':
      await cmdSyncSignOut();
      break;
    case 'settings':
      await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync' });
      break;
  }
}
