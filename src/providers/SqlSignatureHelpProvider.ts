import * as vscode from 'vscode';

import { SqlCompletionProvider } from './SqlCompletionProvider';
import { SqlParser } from './kernel/SqlParser';

/**
 * Parameter hints for function calls in SQL notebook cells (uses same schema cache as completions).
 */
export class SqlSignatureHelpProvider implements vscode.SignatureHelpProvider {
  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.SignatureHelpContext
  ): vscode.ProviderResult<vscode.SignatureHelp> {
    if (document.uri.scheme !== 'vscode-notebook-cell' || document.languageId !== 'sql') {
      return undefined;
    }
    const completion = SqlCompletionProvider.getInstance();
    if (!completion) {
      return undefined;
    }

    return (async () => {
      const cache = await completion.ensureSchemaForNotebook(document);
      if (!cache) {
        return undefined;
      }

      const text = SqlCompletionProvider.sqlTextBeforeCursor(document, position);
      const openIdx = SqlSignatureHelpProvider._callOpenParenIndex(text);
      if (openIdx < 0) {
        return undefined;
      }

      const beforeOpen = SqlParser.stripCommentsAndStrings(text.slice(0, openIdx)).trimEnd();
      const fnMatch = beforeOpen.match(/(?:^|[^\w.])(["\w][\w"]*)(?:\s*\.\s*(["\w][\w"]*))?\s*$/);
      if (!fnMatch) {
        return undefined;
      }
      let schema: string | null = null;
      let fnName: string;
      if (fnMatch[2]) {
        schema = SqlParser.normalizeIdentifier(fnMatch[1]);
        fnName = SqlParser.normalizeIdentifier(fnMatch[2]);
      } else {
        fnName = SqlParser.normalizeIdentifier(fnMatch[1]);
      }

      const objs = cache.objects.filter(
        o =>
          (o.objectType === 'function' || o.objectType === 'procedure') &&
          o.objectName.toLowerCase() === fnName.toLowerCase() &&
          (!schema || o.schema.toLowerCase() === schema.toLowerCase())
      );
      if (objs.length === 0) {
        return undefined;
      }

      const obj = objs[0];
      const argsText = obj.arguments || '';
      const paramLabels = SqlSignatureHelpProvider._splitTopLevelArgs(argsText);
      const sigLabel = `${obj.objectName}(${argsText})`;
      const sig = new vscode.SignatureInformation(
        sigLabel,
        new vscode.MarkdownString(obj.objectType === 'procedure' ? '*procedure*' : '*function*')
      );
      sig.parameters = paramLabels.map(p => new vscode.ParameterInformation(p));

      const commaIdx = SqlSignatureHelpProvider._commaIndexAtCursor(text, openIdx);
      const help = new vscode.SignatureHelp();
      help.signatures = [sig];
      help.activeSignature = 0;
      help.activeParameter =
        sig.parameters.length === 0 ? 0 : Math.min(commaIdx, Math.max(0, sig.parameters.length - 1));

      return help;
    })();
  }

  private static _callOpenParenIndex(textBeforeCursor: string): number {
    let depth = 0;
    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
      const ch = textBeforeCursor[i];
      if (ch === ')') {
        depth++;
      } else if (ch === '(') {
        if (depth === 0) {
          return i;
        }
        depth--;
      }
    }
    return -1;
  }

  private static _commaIndexAtCursor(textBeforeCursor: string, openIdx: number): number {
    const inner = textBeforeCursor.slice(openIdx + 1);
    let d = 0;
    let commas = 0;
    for (let j = 0; j < inner.length; j++) {
      const c = inner[j];
      if (c === '(') {
        d++;
      } else if (c === ')') {
        if (d === 0) {
          break;
        }
        d--;
      } else if (c === ',' && d === 0) {
        commas++;
      }
    }
    return commas;
  }

  /** Split `pg_get_function_arguments` style argument list on top-level commas only. */
  private static _splitTopLevelArgs(args: string): string[] {
    if (!args.trim()) {
      return [];
    }
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= args.length; i++) {
      const ch = args[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
      } else if ((ch === ',' && depth === 0) || i === args.length) {
        const chunk = args.slice(start, i).trim();
        if (chunk) {
          parts.push(chunk);
        }
        start = i + 1;
      }
    }
    return parts;
  }
}
