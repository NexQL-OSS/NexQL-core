import * as vscode from 'vscode';
import {
  buildNotebookHtmlDocument,
  serializeNotebookForGist,
} from '../features/notebook/notebookExportHtml';
import { SecretStorageService } from '../services/SecretStorageService';
import { ErrorHandlers } from './helper';

function isPostgresNotebookDoc(doc: vscode.NotebookDocument): boolean {
  return doc.notebookType === 'postgres-notebook' || doc.notebookType === 'postgres-query';
}

function sanitizeFilenameBase(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'notebook';
}

async function ensureGithubGistToken(): Promise<string | undefined> {
  const secrets = SecretStorageService.getInstance();
  const existing = await secrets.getGithubGistToken();
  if (existing) {
    return existing;
  }
  const input = await vscode.window.showInputBox({
    title: 'GitHub personal access token',
    prompt: 'Needs the gist scope. Create at https://github.com/settings/tokens — stored in VS Code Secret Storage.',
    password: true,
    ignoreFocusOut: true,
  });
  if (!input?.trim()) {
    return undefined;
  }
  await secrets.setGithubGistToken(input.trim());
  return input.trim();
}

async function createGithubGist(params: {
  description: string;
  public: boolean;
  files: Record<string, { content: string }>;
  token: string;
}): Promise<string> {
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'NexQL-VSCode-Extension',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      description: params.description,
      public: params.public,
      files: params.files,
    }),
  });

  if (res.status === 401) {
    await SecretStorageService.getInstance().deleteGithubGistToken();
    throw new Error('GitHub rejected the token (401). Run export again to set a new token with gist scope.');
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { html_url?: string };
  if (!data.html_url) {
    throw new Error('GitHub response missing html_url');
  }
  return data.html_url;
}

/**
 * Export the active PostgreSQL notebook to HTML (print to PDF from the browser) and optionally publish a Gist.
 */
export async function cmdExportNotebook(): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isPostgresNotebookDoc(editor.notebook)) {
    vscode.window.showWarningMessage('Open a PostgreSQL notebook (.pgsql) first.');
    return;
  }

  const doc = editor.notebook;
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(file-code) Save as HTML file',
        description: 'Standalone page with SQL, markdown, and result tables',
        id: 'html' as const,
      },
      {
        label: '$(browser) Save HTML and open in browser',
        description: 'Use the browser Print dialog → Save as PDF',
        id: 'html-open' as const,
      },
      {
        label: '$(github) Publish to GitHub Gist',
        description: 'Upload .pgsql source + HTML render (needs GitHub token)',
        id: 'gist' as const,
      },
    ],
    { title: 'Export PostgreSQL notebook', placeHolder: 'Choose how to export' },
  );
  if (!pick) {
    return;
  }

  const meta = doc.metadata as Record<string, unknown> | undefined;
  const title =
    (meta?.title as string) ||
    doc.uri.path.split('/').pop()?.replace(/\.pgsql$/i, '') ||
    'notebook';
  const safeBase = sanitizeFilenameBase(title);

  try {
    const html = buildNotebookHtmlDocument(doc, title);

    if (pick.id === 'gist') {
      const token = await ensureGithubGistToken();
      if (!token) {
        return;
      }

      const vis = await vscode.window.showQuickPick(
        [
          { label: 'Secret gist', id: 'secret' as const },
          { label: 'Public gist', id: 'public' as const },
        ],
        { placeHolder: 'Gist visibility' },
      );
      if (!vis) {
        return;
      }

      const { filename, json } = serializeNotebookForGist(doc);
      const htmlName = filename.replace(/\.pgsql$/i, '.html');

      const url = await createGithubGist({
        description: `NexQL: ${title}`,
        public: vis.id === 'public',
        token,
        files: {
          [filename]: { content: json },
          [htmlName]: { content: html },
        },
      });

      const open = await vscode.window.showInformationMessage(`Gist created: ${url}`, 'Open in browser');
      if (open === 'Open in browser') {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${safeBase}.html`),
      filters: { HTML: ['html'] },
      saveLabel: 'Save HTML',
    });
    if (!uri) {
      return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf8'));
    vscode.window.showInformationMessage(`Exported notebook to ${uri.fsPath}`);

    if (pick.id === 'html-open') {
      await vscode.env.openExternal(uri);
    }
  } catch (err: unknown) {
    await ErrorHandlers.handleCommandError(err, 'export notebook');
  }
}
