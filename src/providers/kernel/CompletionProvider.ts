
import * as vscode from 'vscode';
import { SqlParser } from './SqlParser';

export class CompletionProvider implements vscode.CompletionItemProvider {

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

    // On a comment line, suggest missing parameter comment definitions instead of keywords
    if (linePrefix.trimStart().startsWith('--')) {
      return this.getParamCommentCompletions(document, position);
    }

    const items: vscode.CompletionItem[] = [];

    // Add basic SQL keywords
    const keywords = [
      'SELECT', 'FROM', 'WHERE', 'LIMIT', 'ORDER BY', 'GROUP BY', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
      'INNER JOIN', 'OUTER JOIN', 'UPDATE', 'DELETE', 'INSERT INTO', 'VALUES', 'CREATE TABLE',
      'ALTER TABLE', 'DROP TABLE', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'AS', 'ON', 'IN', 'BETWEEN',
      'LIKE', 'ILIKE', 'HAVING', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE'
    ];

    for (const kw of keywords) {
      items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
    }

    return items;
  }

  private getParamCommentCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const docText = document.getText();
    const params = SqlParser.detectParameters(docText);
    const commentParams = SqlParser.parseCommentParameters(docText);

    const items: vscode.CompletionItem[] = [];
    const replaceRange = new vscode.Range(new vscode.Position(position.line, 0), position);

    for (const n of params.positional) {
      if (commentParams.positional.has(n)) { continue; }
      const item = new vscode.CompletionItem(`-- $${n}=`, vscode.CompletionItemKind.Value);
      item.insertText = `-- $${n}=`;
      item.range = replaceRange;
      item.detail = `Define value for parameter $${n}`;
      item.sortText = `0_${String(n).padStart(4, '0')}`;
      items.push(item);
    }

    for (const name of params.named) {
      if (commentParams.named.has(name)) { continue; }
      const item = new vscode.CompletionItem(`-- :${name}=`, vscode.CompletionItemKind.Value);
      item.insertText = `-- :${name}=`;
      item.range = replaceRange;
      item.detail = `Define value for parameter :${name}`;
      item.sortText = `1_${name}`;
      items.push(item);
    }

    return items;
  }
}
