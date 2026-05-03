import * as vscode from 'vscode';
import type { PostgresMetadata } from '../../common/types';
import { createAndShowNotebook } from '../../commands/connection';

function escapeFence(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/```/g, '\\`\\`\\`');
}

/** Opens a new notebook with a markdown cell containing the backup/restore log. */
export async function openNotebookWithBackupLog(title: string, logBody: string, metadata: PostgresMetadata): Promise<void> {
  const md =
    `## ${title}\n\n` +
    `\`\`\`text\n${escapeFence(logBody)}\n\`\`\`\n`;
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown');
  await createAndShowNotebook([cell], metadata);
}

/**
 * If the active editor is a postgres notebook for the same connection/database, append a markdown cell at the end.
 * Returns true if appended.
 */
export async function tryAppendBackupLogToActiveNotebook(
  title: string,
  logBody: string,
  connectionId: string,
  databaseName: string
): Promise<boolean> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    return false;
  }
  const nb = editor.notebook;
  if (nb.notebookType !== 'postgres-notebook' && nb.notebookType !== 'postgres-query') {
    return false;
  }
  const meta = nb.metadata as { connectionId?: string; databaseName?: string } | undefined;
  if (meta?.connectionId !== connectionId || meta?.databaseName !== databaseName) {
    return false;
  }

  const md =
    `## ${title}\n\n` +
    `\`\`\`text\n${escapeFence(logBody)}\n\`\`\`\n`;
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown');
  const edit = vscode.NotebookEdit.insertCells(nb.cellCount, [cell]);
  const ws = new vscode.WorkspaceEdit();
  ws.set(nb.uri, [edit]);
  await vscode.workspace.applyEdit(ws);
  return true;
}
