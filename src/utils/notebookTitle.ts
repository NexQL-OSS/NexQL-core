/**
 * Host-side (Node.js) utility for deriving a notebook title from SQL cell content.
 *
 * This mirrors the logic in src/renderer/utils/sqlParsing.ts but runs in the
 * extension host where VS Code notebook metadata APIs are available.
 */

import * as vscode from 'vscode';

/**
 * Extracts schema and table from a SQL statement containing a FROM or JOIN clause
 * with a qualified `schema.table` reference.
 */
function parseBreadcrumbFromSql(sql: string): { schema?: string; table?: string } {
  const identPart = `(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
  const pattern = new RegExp(
    `(?:FROM|JOIN)\\s+(${identPart})\\.(${identPart})(?:\\s+(?:AS\\s+${identPart}|WHERE|ON|LEFT|RIGHT|INNER|OUTER|CROSS|JOIN|GROUP|ORDER|LIMIT|HAVING|UNION|EXCEPT|INTERSECT|;|$))?`,
    'i'
  );

  const match = pattern.exec(sql);
  if (!match) {
    return {};
  }

  const stripQuotes = (s: string) => s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
  return {
    schema: stripQuotes(match[1]),
    table: stripQuotes(match[2]),
  };
}

/**
 * Scans an array of notebook cell SQL strings in order and returns a title
 * derived from the first cell that contains a SELECT statement.
 *
 * Returns `""` when no SELECT statement is found in any cell.
 */
export function deriveNotebookTitle(cells: string[]): string {
  for (const cell of cells) {
    if (!/SELECT/i.test(cell)) {
      continue;
    }

    const { schema, table } = parseBreadcrumbFromSql(cell);
    if (schema && table) {
      return `View ${schema}.${table}`;
    }

    const selectMatch = /SELECT\b.*/i.exec(cell);
    if (selectMatch) {
      const raw = selectMatch[0].trim().replace(/\s+/g, ' ');
      return raw.length > 50 ? raw.slice(0, 50) : raw;
    }
  }

  return '';
}

/**
 * Updates the displayed title of a VS Code notebook document.
 *
 * Uses `vscode.workspace.applyEdit` with `replaceNotebookMetadata` to set
 * a `title` key in the notebook's metadata. Falls back to the file name
 * (without extension) when `autoTitle` is empty.
 */
export async function updateNotebookTitle(notebook: vscode.NotebookDocument): Promise<void> {
  const cells = notebook.getCells()
    .filter(c => c.kind === vscode.NotebookCellKind.Code)
    .map(c => c.document.getText());

  const autoTitle = deriveNotebookTitle(cells);

  // Fall back to the file name (without extension) when no SELECT is found
  const fallback = notebook.uri.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
  const title = autoTitle || fallback;

  const currentTitle = (notebook.metadata as any)?.title;
  if (currentTitle === title) {
    return; // No change needed
  }

  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.updateNotebookMetadata({
      ...(notebook.metadata as object),
      title,
    })
  ]);

  await vscode.workspace.applyEdit(edit);
}
