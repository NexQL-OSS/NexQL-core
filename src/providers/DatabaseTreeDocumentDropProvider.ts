import * as vscode from 'vscode';

const NEXQL_DRAG_MIME = 'application/vnd.code.tree.postgresExplorer';

interface SerializedTreeItem {
  type: string;
  connectionId: string;
  databaseName?: string;
  schema?: string;
  tableName?: string;
  columnName?: string;
  label: string;
  comment?: string;
}

function formatDbObjectForDrop(item: SerializedTreeItem): string {
  if (item.type === 'column' && item.tableName && item.columnName) {
    return `${item.tableName}.${item.columnName}`;
  }
  if (item.type === 'connection' || item.type === 'database') {
    return item.label;
  }
  if ((item.type === 'function' || item.type === 'procedure' || item.type === 'aggregate') && item.comment) {
    return `${item.schema || 'public'}.${item.label}(${item.comment})`;
  }
  return `${item.schema || 'public'}.${item.label}`;
}

export class DatabaseTreeDocumentDropProvider implements vscode.DocumentDropEditProvider {
  async provideDocumentDropEdits(
    _document: vscode.TextDocument,
    _position: vscode.Position,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<vscode.DocumentDropEdit | undefined> {
    const textPlain = dataTransfer.get('text/plain');
    if (textPlain) {
      const text = await textPlain.asString();
      if (text) {
        return new vscode.DocumentDropEdit(text);
      }
    }

    const nexqlData = dataTransfer.get(NEXQL_DRAG_MIME);
    if (!nexqlData) {
      return undefined;
    }

    try {
      const raw = await nexqlData.asString();
      const items: SerializedTreeItem[] = JSON.parse(raw);
      const text = items.map(formatDbObjectForDrop).join(',').replace(/\s+/g, ' ');
      if (text) {
        return new vscode.DocumentDropEdit(text);
      }
    } catch {
      // ignore parse failures
    }

    return undefined;
  }
}
