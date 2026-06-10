import * as vscode from 'vscode';
import { appendWorkspaceConnection, ConnectionInfo } from '../features/connections/connectionStore';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { connectionInfoFromDatabaseUrl, previewDatabaseUrl } from '../utils/databaseUrl';
import { DATABASE_URL_ENV_KEYS, extractDatabaseUrlsFromEnvText } from '../utils/envFileDatabaseUrls';
import { ErrorHandlers } from './helper';

export interface EnvUrlCandidate {
  relativePath: string;
  key: string;
  value: string;
}

export async function cmdImportConnectionFromDatabaseUrl(
  context: vscode.ExtensionContext,
  databaseTreeProvider: DatabaseTreeProvider,
): Promise<void> {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showWarningMessage('Open a workspace folder to scan .env files.');
      return;
    }

    const keySet = new Set<string>(DATABASE_URL_ENV_KEYS);
    const acceptKey = (k: string): boolean => keySet.has(k);
    const candidates = await scanWorkspaceEnvFiles(folders, acceptKey);

    let chosenUrl: string | undefined;
    let sourceLabel: string | undefined;

    if (candidates.length === 0) {
      const pasted = await vscode.window.showInputBox({
        title: 'Import PostgreSQL connection',
        prompt:
          'No DATABASE_URL-style keys found in .env files. Paste a postgres:// or postgresql:// URL.',
        ignoreFocusOut: true,
      });
      if (!pasted?.trim()) {
        return;
      }
      chosenUrl = pasted.trim();
      sourceLabel = 'pasted URL';
    } else if (candidates.length === 1) {
      chosenUrl = candidates[0].value;
      sourceLabel = `${candidates[0].relativePath} (${candidates[0].key})`;
    } else {
      const pick = await vscode.window.showQuickPick(
        candidates.map((c) => ({
          label: `${c.relativePath} — ${c.key}`,
          description: previewDatabaseUrl(c.value),
          candidate: c,
        })),
        { placeHolder: 'Choose a DATABASE_URL from the workspace' },
      );
      if (!pick) {
        return;
      }
      chosenUrl = pick.candidate.value;
      sourceLabel = `${pick.candidate.relativePath} (${pick.candidate.key})`;
    }

    const id = `env-${Date.now()}`;
    let info: ConnectionInfo;
    try {
      info = connectionInfoFromDatabaseUrl(chosenUrl, id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(msg);
      return;
    }

    const name = await vscode.window.showInputBox({
      title: 'Connection name',
      prompt: `Imported from ${sourceLabel}`,
      value: info.name,
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }
    if (!name.trim()) {
      vscode.window.showWarningMessage('Connection name is required.');
      return;
    }

    await appendWorkspaceConnection(context, { ...info, name: name.trim() });
    databaseTreeProvider.refresh();
    vscode.window.showInformationMessage(`Saved connection "${name.trim()}"`);
  } catch (err: unknown) {
    await ErrorHandlers.handleCommandError(err, 'import connection from DATABASE_URL');
  }
}

export async function scanWorkspaceEnvFiles(
  folders: readonly vscode.WorkspaceFolder[],
  acceptKey: (k: string) => boolean,
): Promise<EnvUrlCandidate[]> {
  const out: EnvUrlCandidate[] = [];

  for (const folder of folders) {
    const pattern = new vscode.RelativePattern(
      folder,
      '{**/.env,**/.env.local,**/.env.development,**/.env.production}',
    );
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 80);
    for (const uri of files) {
      let text: string;
      try {
        const doc = await vscode.workspace.fs.readFile(uri);
        text = Buffer.from(doc).toString('utf8');
      } catch {
        continue;
      }
      const rel = vscode.workspace.asRelativePath(uri, false);
      for (const { key, value } of extractDatabaseUrlsFromEnvText(text, acceptKey)) {
        out.push({ relativePath: rel, key, value });
      }
    }
  }
  return out;
}
