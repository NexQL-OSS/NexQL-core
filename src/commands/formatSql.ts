/**
 * formatSql.ts
 * VS Code command implementation for formatting SQL in notebooks and editors.
 */

import * as vscode from 'vscode';
import { SqlFormatterService } from '../services/SqlFormatterService';

export async function formatSqlCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No active editor to format');
    return;
  }

  const doc = editor.document;
  const languageId = doc.languageId;

  // Only format SQL and PostgreSQL files
  const supportedLanguages = ['sql', 'pgsql', 'postgresql', 'postgres'];
  if (!supportedLanguages.includes(languageId)) {
    vscode.window.showInformationMessage(
      `Format SQL is not available for ${languageId} files. Supported: ${supportedLanguages.join(', ')}`
    );
    return;
  }

  const service = SqlFormatterService.getInstance();

  try {
    // Check if there's a selection
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;

    if (hasSelection) {
      // Format only selected text
      const selectedText = doc.getText(selection);
      const formatted = await service.format(selectedText);
      await editor.edit(editBuilder => {
        editBuilder.replace(selection, formatted);
      });
      vscode.window.setStatusBarMessage('$(check) SQL formatted (selection)', 3000);
    } else {
      // Format entire document
      const edits = await service.formatDocument(doc);
      if (edits.length === 0) {
        vscode.window.setStatusBarMessage('$(check) SQL already formatted', 2000);
        return;
      }
      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.set(doc.uri, edits);
      await vscode.workspace.applyEdit(wsEdit);
      vscode.window.setStatusBarMessage('$(check) SQL formatted', 3000);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to format SQL: ${(err as Error).message}`);
  }
}

/**
 * Format-on-save handler — registered in extension.ts
 */
export function createFormatOnSaveListener(): vscode.Disposable {
  return vscode.workspace.onWillSaveTextDocument(async (event) => {
    const doc = event.document;
    const supportedLanguages = ['sql', 'pgsql', 'postgresql', 'postgres'];

    if (!supportedLanguages.includes(doc.languageId)) { return; }

    const config = vscode.workspace.getConfiguration('postgresExplorer.formatter');
    if (!config.get<boolean>('formatOnSave', false)) { return; }

    const service = SqlFormatterService.getInstance();
    const editsPromise = service.formatDocument(doc);
    event.waitUntil(editsPromise);
  });
}
