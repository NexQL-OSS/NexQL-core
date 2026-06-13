import * as vscode from 'vscode';
import { SyncController } from './SyncController';
import { VaultService } from './VaultService';
import {
  allowedSyncProviders,
  ProFeature,
  requirePro,
} from '../../services/featureGates';
import { GistSyncProvider } from './providers/GistSyncProvider';
import { readNotebookSyncId } from './notebookSyncId';

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

/** Share selected notebooks / saved queries with another team member. */
export async function cmdSyncShare(
  context: vscode.ExtensionContext,
  treeItem?: SyncContextTreeItem,
): Promise<void> {
  if (!(await requirePro(ProFeature.SyncSharing))) {
    return;
  }
  const controller = SyncController.getInstance();
  if (controller.getConfig().providerId !== 'cloud') {
    await vscode.window.showWarningMessage(
      'Team sharing requires the NexQL Cloud sync backend. Set it up under NexQL Sync: Set Up Sync.',
    );
    return;
  }

  const shareable = controller.listSyncedItems().filter((i) => i.kind === 'query' || i.kind === 'notebook');
  if (shareable.length === 0) {
    await vscode.window.showInformationMessage('No notebooks or saved queries are available to share yet.');
    return;
  }

  const fromMenu = await resolveSyncItemIdFromTreeItem(treeItem);
  let itemIds: string[];
  if (fromMenu) {
    if (!shareable.some((i) => i.id === fromMenu)) {
      await vscode.window.showWarningMessage(
        'This item is not in the sync index yet. Run sync first, then share again.',
      );
      return;
    }
    itemIds = [fromMenu];
  } else {
    const picks = await vscode.window.showQuickPick(
      shareable.map((i) => ({
        label: i.name || i.id,
        description: i.kind === 'notebook' ? 'Notebook' : 'Saved query',
        id: i.id,
      })),
      { title: 'Share items', placeHolder: 'Select items to share', canPickMany: true },
    );
    if (!picks?.length) {
      return;
    }
    itemIds = picks.map((p) => p.id);
  }

  const granteeEmail = await vscode.window.showInputBox({
    title: 'Share with',
    prompt: "Team member's account email (they must have NexQL sync enabled)",
    placeHolder: 'teammate@example.com',
    ignoreFocusOut: true,
    validateInput: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? undefined : 'Enter a valid email'),
  });
  if (!granteeEmail) {
    return;
  }

  try {
    const { SharingService } = await import('./SharingService');
    const count = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sharing items…' },
      () => new SharingService(context).shareItems(granteeEmail.trim(), itemIds),
    );
    await vscode.window.showInformationMessage(
      count > 0
        ? `Shared ${count} item${count === 1 ? '' : 's'} with ${granteeEmail.trim()}.`
        : 'Nothing was shared — selected items could not be read.',
    );
  } catch (e) {
    await vscode.window.showErrorMessage(`Share failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Review and import items other team members have shared with you. */
export async function cmdSyncImportShares(context: vscode.ExtensionContext): Promise<void> {
  if (!(await requirePro(ProFeature.SyncSharing))) {
    return;
  }
  const { SharingService } = await import('./SharingService');
  const service = new SharingService(context);

  let shares;
  try {
    shares = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading shared items…' },
      () => service.listIncomingShares(),
    );
  } catch (e) {
    await vscode.window.showErrorMessage(`Could not load shares: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!shares.length) {
    await vscode.window.showInformationMessage('No one has shared items with you yet.');
    return;
  }

  const picks = await vscode.window.showQuickPick(
    shares.map((s) => ({
      label: s.name || s.shareId,
      description: `${s.kind === 'notebook' ? 'Notebook' : 'Saved query'} · from ${s.ownerEmail}`,
      share: s,
    })),
    { title: 'Import shared items', placeHolder: 'Select items to import', canPickMany: true },
  );
  if (!picks?.length) {
    return;
  }

  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Merge into my library', detail: 'Re-importing later updates these items in place', id: 'merge' as const },
      { label: 'Import as new copies', detail: 'Detached duplicates with fresh ids', id: 'copy' as const },
    ],
    { title: 'How should shared items be imported?' },
  );
  if (!mode) {
    return;
  }

  // Optionally attach one of the grantee's own connections (never the owner's).
  const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
  let connectionId: string | undefined;
  if (connections.length > 0) {
    const connPick = await vscode.window.showQuickPick(
      [
        { label: 'No connection (attach later)', id: undefined as string | undefined },
        ...connections.map((c) => ({ label: c.name ?? `${c.host}:${c.port}`, id: String(c.id) })),
      ],
      { title: 'Attach a connection to imported items?' },
    );
    if (!connPick) {
      return;
    }
    connectionId = connPick.id;
  }

  try {
    const count = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Importing…' },
      () => service.importShares(picks.map((p) => p.share), mode.id, connectionId),
    );
    await vscode.window.showInformationMessage(`Imported ${count} shared item${count === 1 ? '' : 's'}.`);
  } catch (e) {
    await vscode.window.showErrorMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function cmdSyncLinkGist(context: vscode.ExtensionContext): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const config = SyncController.getInstance().getConfig();
  if (config.providerId !== 'gist') {
    await vscode.window.showWarningMessage('Link Gist is only for the GitHub Gist sync backend.');
    return;
  }
  const provider = new GistSyncProvider(context);
  const linked = await provider.linkExistingGistInteractive();
  if (!linked) {
    return;
  }
  const gistId = await context.secrets.get('postgresExplorer.sync.gistId');
  await SyncController.getInstance().saveConfig({ ...config, gistId });
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pulling from linked gist…' },
    () => SyncController.getInstance().runSync() ?? Promise.resolve(),
  );
}

export async function cmdSyncNow(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  await SyncController.getInstance().runSync();
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
  await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync', tab: 'conflicts' });
}

export async function cmdSyncReplaceLocal(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const typed = await vscode.window.showInputBox({
    title: 'Replace local with cloud',
    prompt: 'Type REPLACE to confirm',
    ignoreFocusOut: true,
  });
  if (typed !== 'REPLACE') {
    return;
  }
  await SyncController.getInstance().replaceLocalWithCloud();
}

export async function cmdSyncReplaceRemote(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const typed = await vscode.window.showInputBox({
    title: 'Replace cloud with local',
    prompt: 'Type REPLACE to confirm',
    ignoreFocusOut: true,
  });
  if (typed !== 'REPLACE') {
    return;
  }
  await SyncController.getInstance().replaceCloudWithLocal();
}

export async function cmdSyncRebuildIndex(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const typed = await vscode.window.showInputBox({
    title: 'Rebuild sync index',
    prompt: 'Type REPLACE to confirm',
    ignoreFocusOut: true,
  });
  if (typed !== 'REPLACE') {
    return;
  }
  const count = await SyncController.getInstance().rebuildSyncIndex();
  void vscode.window.showInformationMessage(`Rebuilt index for ${count} item(s).`);
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
  const status = controller.getStatus();
  const conflicts = controller.getConflictCount();

  await vscode.window.showInformationMessage(
    `Sync: ${status} | provider: ${config.providerId ?? 'none'} | conflicts: ${conflicts}`,
  );
}

export async function cmdSyncShowSecretKey(context: vscode.ExtensionContext): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const vault = VaultService.getInstance(context);
  if (!vault.isUnlocked()) {
    await vscode.window.showWarningMessage(
      'Unlock your vault first (Settings → Cloud Sync → wizard, or re-run setup).',
    );
    return;
  }
  const email = vault.getAccountEmail() ?? SyncController.getInstance().getConfig().accountEmail ?? '';
  const secretKey = await vscode.window.showInputBox({
    title: 'Export recovery kit',
    prompt: 'Enter your secret key to re-export the recovery kit (not stored by PgStudio)',
    password: true,
    ignoreFocusOut: true,
  });
  if (!secretKey) {
    return;
  }
  try {
    await vault.unlock(secretKey, email);
  } catch {
    await vscode.window.showErrorMessage('Secret key did not unlock the vault.');
    return;
  }
  const { SyncSetupWizard } = await import('./SyncSetupWizard');
  await new SyncSetupWizard(context).exportRecoveryKit(email, secretKey);
}

export async function cmdSyncPause(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  const controller = SyncController.getInstance();
  const config = controller.getConfig();
  await controller.saveConfig({ ...config, paused: !config.paused });
  vscode.window.showInformationMessage(config.paused ? 'Sync resumed' : 'Sync paused');
}

export async function cmdSyncSignOut(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Sign out of sync? Local data is kept; remote vault remains.',
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
  const gistItems = config.providerId === 'gist'
    ? [{ label: '$(link) Link GitHub Gist…', id: 'linkGist' }]
    : [];
  // Team sharing rides the NexQL Cloud backend only.
  const shareItems = config.providerId === 'cloud'
    ? [
        { label: '$(person-add) Share Items…', id: 'share' },
        { label: '$(cloud-download) Import Shared Items…', id: 'importShares' },
      ]
    : [];
  const items = configured
    ? [
        { label: '$(sync) Sync Now', id: 'now' },
        { label: '$(cloud-download) Pull Only', id: 'pull' },
        { label: '$(cloud-upload) Push Only', id: 'push' },
        { label: '$(eye) Preview Sync…', id: 'preview' },
        { label: '$(warning) Resolve Conflicts…', id: 'conflicts' },
        ...gistItems,
        ...shareItems,
        { label: '$(info) Show Status', id: 'status' },
        { label: '$(key) Export Recovery Kit…', id: 'secret' },
        {
          label: config.paused ? '$(play) Resume Sync' : '$(debug-pause) Pause Sync',
          id: 'pause',
        },
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
      if (!context) {
        await vscode.window.showErrorMessage('Sync setup requires extension context.');
        return;
      }
      await cmdSyncSetup(context);
      break;
    case 'now':
      if (!(await requirePro(ProFeature.CloudBackup))) {
        return;
      }
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
    case 'conflicts':
      await cmdSyncConflicts();
      break;
    case 'linkGist':
      if (!context) {
        return;
      }
      await cmdSyncLinkGist(context);
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
    case 'signout':
      await cmdSyncSignOut();
      break;
    case 'settings':
      await vscode.commands.executeCommand('postgres-explorer.settingsHub', { section: 'sync' });
      break;
  }
}
