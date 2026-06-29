import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { detectFrameworks, MIGRATION_FRAMEWORKS, MigrationFramework } from './migrationFrameworks';

/**
 * Migration Hub: detect the migration framework(s) used in the open workspace and
 * open a runbook with the framework's status / apply / rollback / create commands.
 * Bridges NexQL with external migration tooling (previously detection-only).
 */
export async function cmdMigrationHub(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    await vscode.window.showInformationMessage('Open a folder/workspace to detect migration frameworks.');
    return;
  }

  const detected = new Map<string, { fw: MigrationFramework; root: string }>();
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const exists = (rel: string): boolean => {
      try {
        return fs.existsSync(path.join(root, rel));
      } catch {
        return false;
      }
    };
    for (const fw of detectFrameworks(exists)) {
      if (!detected.has(fw.id)) {
        detected.set(fw.id, { fw, root });
      }
    }
  }

  const md = detected.size > 0
    ? renderDetectedRunbook([...detected.values()])
    : renderNoneDetected();

  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

function commandBlock(label: string, cmd?: string): string {
  if (!cmd) { return ''; }
  return `**${label}**\n\n\`\`\`bash\n${cmd}\n\`\`\`\n`;
}

function renderDetectedRunbook(matches: { fw: MigrationFramework; root: string }[]): string {
  const sections = matches.map(({ fw, root }) => {
    const c = fw.commands;
    return [
      `## ${fw.name}`,
      `Detected in \`${root}\`. [Documentation](${fw.docs})`,
      '',
      commandBlock('Status', c.status),
      commandBlock('Apply (migrate up)', c.apply),
      commandBlock('Rollback', c.rollback),
      commandBlock('Create new migration', c.create),
    ].filter(Boolean).join('\n');
  });

  return [
    '# Migration Hub',
    '',
    `Detected ${matches.length} migration framework${matches.length === 1 ? '' : 's'} in this workspace.`,
    'Run these in your terminal. NexQL does not execute them for you — review before applying to production.',
    '',
    ...sections,
  ].join('\n');
}

function renderNoneDetected(): string {
  const supported = MIGRATION_FRAMEWORKS.map((f) => `- ${f.name}`).join('\n');
  return [
    '# Migration Hub',
    '',
    'No migration framework was detected in the open workspace.',
    '',
    '## Supported frameworks',
    supported,
    '',
    'Add one of these to your project (e.g. a `prisma/`, `alembic.ini`, `drizzle.config.ts`, `flyway.conf`, or `atlas.hcl`) and re-run **NexQL: Migration Hub**.',
  ].join('\n');
}
