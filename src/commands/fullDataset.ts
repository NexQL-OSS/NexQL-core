import * as vscode from 'vscode';
import { SqlSafetyAnalyzer } from '../services/sqlSafety';
import { FullDatasetPreferenceService } from '../services/FullDatasetPreferenceService';
import { QueryCodeLensProvider } from '../providers/QueryCodeLensProvider';
import { SqlParser } from '../providers/kernel/SqlParser';

function resolveNotebookCell(cell?: vscode.NotebookCell): vscode.NotebookCell | undefined {
  if (cell) {
    return cell;
  }
  const editor = vscode.window.activeNotebookEditor;
  if (editor?.selection && editor.selection.start < editor.notebook.cellCount) {
    return editor.notebook.cellAt(editor.selection.start);
  }
  return undefined;
}

export async function toggleFullDatasetFromCell(cell?: vscode.NotebookCell): Promise<void> {
  const target = resolveNotebookCell(cell);
  if (!target) {
    vscode.window.showWarningMessage('Open a SQL notebook cell to toggle full dataset mode.');
    return;
  }

  const text = target.document.getText().trim();
  if (/^\s*EXPLAIN/i.test(text)) {
    vscode.window.showWarningMessage('Full dataset mode is not available for EXPLAIN queries.');
    return;
  }
  if (!SqlSafetyAnalyzer.getInstance().isReadOnlyQuery(text)) {
    vscode.window.showWarningMessage('Full dataset mode is only available for read-only SELECT queries.');
    return;
  }

  const params = SqlParser.detectParameters(text);
  if (params.positional.length > 0 || params.named.length > 0 || params.quoted.length > 0) {
    vscode.window.showWarningMessage('Full dataset mode is not available for parameterized queries.');
    return;
  }

  await toggleFullDatasetForCell(target.document.uri);
}

export async function toggleFullDatasetForCell(cellUri?: vscode.Uri): Promise<void> {
  const uri = cellUri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'vscode-notebook-cell') {
    vscode.window.showWarningMessage('Open a SQL notebook cell to toggle full dataset mode.');
    return;
  }

  const enabled = await FullDatasetPreferenceService.toggle(uri.toString());
  QueryCodeLensProvider.getInstance()?.refresh();
  vscode.window.setStatusBarMessage(
    enabled ? 'Full dataset enabled for this cell.' : 'Full dataset disabled for this cell.',
    3000,
  );
}
