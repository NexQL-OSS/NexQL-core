import * as vscode from 'vscode';
import { SyncController } from './SyncController';
import { VaultService } from './VaultService';
import { AccountService } from './AccountService';
import {
  allowedSyncProviders,
  ProFeature,
  requirePro,
  syncProviderMinTier,
  TIER_DISPLAY,
} from '../../services/featureGates';
import type { SyncProviderId } from './types';
import { GistSyncProvider } from './providers/GistSyncProvider';
import { OneDriveSyncProvider } from './providers/OneDriveSyncProvider';
import { GoogleDriveSyncProvider } from './providers/GoogleDriveSyncProvider';
import { CloudSyncProvider } from './providers/CloudSyncProvider';
import { PostgresSyncProvider } from './providers/PostgresSyncProvider';

export async function cmdSyncSetup(context: vscode.ExtensionContext): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }

  const allProviders: Array<{ label: string; id: SyncProviderId; description?: string }> = [
    { label: 'Shared Postgres', id: 'postgres', description: 'pgstudio_sync schema in your own database' },
    { label: 'GitHub Gist', id: 'gist', description: 'Private gist — works in most editors' },
    { label: 'OneDrive', id: 'onedrive', description: 'Microsoft appFolder' },
    { label: 'Google Drive', id: 'gdrive', description: 'drive.appdata — loopback OAuth' },
    { label: 'NexQL Cloud', id: 'cloud', description: 'Hosted sync on nexql.astrx.dev' },
  ];
  const allowed = allowedSyncProviders();
  const providers = allProviders.map((p) =>
    allowed.includes(p.id)
      ? p
      : {
          ...p,
          label: `$(lock) ${p.label}`,
          description: `Requires NexQL ${TIER_DISPLAY[syncProviderMinTier(p.id)]} — ${p.description}`,
        });

  const picked = await vscode.window.showQuickPick(providers, {
    title: 'PgStudio: Set Up Sync',
    placeHolder: 'Choose storage backend',
  });
  if (!picked) {
    return;
  }
  if (!allowed.includes(picked.id)) {
    const tier = syncProviderMinTier(picked.id);
    const choice = await vscode.window.showInformationMessage(
      `The ${picked.id === 'cloud' ? 'NexQL Cloud' : picked.id} backend requires NexQL ${TIER_DISPLAY[tier]}.`,
      'View Plans',
    );
    if (choice === 'View Plans') {
      await vscode.env.openExternal(vscode.Uri.parse('https://nexql.astrx.dev/#pricing'));
    }
    return;
  }

  const controller = SyncController.getInstance();
  const provider = createProviderForSetup(context, picked.id);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Connecting…' },
    async () => {
      if (picked.id === 'cloud') {
        await AccountService.getInstance().signInWithDeviceFlow();
      } else if (picked.id === 'gist') {
        await (provider as GistSyncProvider).ensureAuth();
      } else if (picked.id === 'onedrive') {
        await (provider as OneDriveSyncProvider).ensureAuth();
      } else if (picked.id === 'gdrive') {
        await (provider as GoogleDriveSyncProvider).ensureAuth();
      }

      const test = await provider.testConnection();
      if (!test.ok) {
        throw new Error(test.error ?? 'Connection failed');
      }
    },
  );

  const email = await vscode.window.showInputBox({
    title: 'Account email (for vault encryption)',
    prompt: 'Used to derive your encryption key — not sent to storage backends',
    ignoreFocusOut: true,
  });
  if (!email) {
    return;
  }

  const vaultAction = await vscode.window.showQuickPick(
    [
      { label: 'Create new vault', id: 'create' },
      { label: 'Unlock existing vault', id: 'unlock' },
    ],
    { title: 'Vault setup' },
  );
  if (!vaultAction) {
    return;
  }

  const vault = VaultService.getInstance(context);

  if (vaultAction.id === 'create') {
    const { secretKey } = await vault.createVault(email);
    const copy = await vscode.window.showWarningMessage(
      'Save your secret key now — we cannot recover it if lost.',
      'Copy Secret Key',
      'Save Recovery Kit…',
    );
    if (copy === 'Copy Secret Key') {
      await vscode.env.clipboard.writeText(secretKey);
    } else if (copy === 'Save Recovery Kit…') {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('pgstudio-recovery-kit.txt'),
        filters: { 'Text': ['txt'] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(
          uri,
          Buffer.from(`PgStudio Sync Recovery Kit\nEmail: ${email}\nSecret Key: ${secretKey}\n\nKeep this file safe. Without the secret key, encrypted data cannot be recovered.`),
        );
      }
    }
  } else {
    const secretKey = await vscode.window.showInputBox({
      title: 'Enter secret key',
      password: true,
      ignoreFocusOut: true,
    });
    if (!secretKey) {
      return;
    }
    try {
      await vault.unlock(secretKey, email);
    } catch (e) {
      await vscode.window.showErrorMessage(
        e instanceof Error ? e.message : 'Failed to unlock vault',
      );
      return;
    }
  }

  const syncWhat = await vscode.window.showQuickPick(
    [
      { label: 'Connections', picked: true, id: 'connections' },
      { label: 'Saved queries', picked: true, id: 'queries' },
      { label: 'Notebooks', picked: true, id: 'notebooks' },
      { label: 'Passwords (opt-in)', picked: false, id: 'passwords' },
    ],
    { title: 'What to sync?', canPickMany: true },
  );
  if (!syncWhat?.length) {
    return;
  }

  if (picked.id === 'gist') {
    const linked = await (provider as GistSyncProvider).linkToRemoteStorage({
      mode: vaultAction.id === 'unlock' ? 'unlock' : 'create',
      vaultGeneration: vault.getGeneration(),
    });
    if (!linked) {
      return;
    }
  }

  const ids = new Set(syncWhat.map((s) => s.id));
  const gistId = picked.id === 'gist'
    ? await context.secrets.get('postgresExplorer.sync.gistId')
    : undefined;
  await controller.saveConfig({
    providerId: picked.id,
    gistId,
    syncConnections: ids.has('connections'),
    syncQueries: ids.has('queries'),
    syncNotebooks: ids.has('notebooks'),
    syncPasswords: ids.has('passwords'),
    paused: false,
    accountEmail: email,
    vaultGeneration: vault.getGeneration(),
  });

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Running first sync…' },
    () => controller.runSync() ?? Promise.resolve(),
  );

  // Register this vault's public key so team members can share to this account
  // (NexQL Cloud backend + Teams tier only).
  if (picked.id === 'cloud') {
    try {
      const { SharingService } = await import('./SharingService');
      await new SharingService(context).registerPublicKey();
    } catch {
      /* sharing key registration is best-effort */
    }
  }

  const { TelemetryService } = await import('../../services/TelemetryService');
  TelemetryService.getInstance().trackEvent('sync_setup_completed', { provider: picked.id });
}

/** Share selected notebooks / saved queries with another team member. */
export async function cmdSyncShare(context: vscode.ExtensionContext): Promise<void> {
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
      () => new SharingService(context).shareItems(granteeEmail.trim(), picks.map((p) => p.id)),
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

export async function cmdSyncStatus(): Promise<void> {
  const controller = SyncController.getInstance();
  const config = controller.getConfig();
  const status = controller.getStatus();
  const conflicts = controller.getConflictCount();

  await vscode.window.showInformationMessage(
    `Sync: ${status} | provider: ${config.providerId ?? 'none'} | conflicts: ${conflicts}`,
  );
}

export async function cmdSyncShowSecretKey(): Promise<void> {
  if (!(await requirePro(ProFeature.CloudBackup))) {
    return;
  }
  await vscode.window.showWarningMessage(
    'Secret keys are shown only once at vault creation. Use your saved recovery kit.',
  );
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
        ...gistItems,
        ...shareItems,
        { label: '$(info) Show Status', id: 'status' },
        { label: '$(key) Show Secret Key', id: 'secret' },
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
      await cmdSyncShowSecretKey();
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

function createProviderForSetup(context: vscode.ExtensionContext, id: SyncProviderId) {
  switch (id) {
    case 'gist':
      return new GistSyncProvider(context);
    case 'onedrive':
      return new OneDriveSyncProvider(context);
    case 'gdrive':
      return new GoogleDriveSyncProvider(context);
    case 'cloud':
      return new CloudSyncProvider(context);
    case 'postgres':
      return new PostgresSyncProvider(context);
  }
}
