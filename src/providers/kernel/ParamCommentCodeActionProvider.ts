
import * as vscode from 'vscode';
import { SqlParser } from './SqlParser';

export class ParamCommentCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const docText = document.getText();
    const params = SqlParser.detectParameters(docText);
    const commentParams = SqlParser.parseCommentParameters(docText);

    const missingPositional = params.positional.filter(n => !commentParams.positional.has(n));
    const missingNamed = params.named.filter(name => !commentParams.named.has(name));

    if (missingPositional.length === 0 && missingNamed.length === 0) {
      return [];
    }

    const lines: string[] = [];
    for (const n of missingPositional) {
      lines.push(`-- $${n}=`);
    }
    for (const name of missingNamed) {
      lines.push(`-- :${name}=`);
    }
    const insertText = lines.join('\n') + '\n';

    const action = new vscode.CodeAction(
      `Add ${lines.length} missing parameter comment${lines.length > 1 ? 's' : ''}`,
      vscode.CodeActionKind.QuickFix
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(0, 0), insertText);
    action.isPreferred = true;

    return [action];
  }
}
