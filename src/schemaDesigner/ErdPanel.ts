import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { resolveTreeItemConnection } from './connectionHelper';
import { ErrorHandlers } from '../commands/helper';
import { createAndShowNotebook, createMetadata } from '../commands/connection';
import type { PostgresMetadata } from '../common/types';
import { fetchErdSnapshot } from './erd/erdQueries';
import { buildErdWebviewHtml } from './erd/erdWebviewHtml';
import { patchesToMigrationSql, type ErdModelPatch } from './erd/erdMigrationDraft';
import type { ErdWebviewPayload } from './erd/erdTypes';

export type { ErdModelPatch };

/**
 * Entity-Relationship Diagram (ERD) Panel — multi-schema, layers, exports, migration draft.
 */
export class ErdPanel {
  public static readonly viewType = 'pgStudio.erd';

  private static _panels = new Map<string, ErdPanel>();
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  /**
   * Open ERD for a single schema (from tree context).
   */
  public static async open(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
    const labelStr = typeof item.label === 'string' ? item.label : (item.label as { label?: string })?.label ?? '';
    const schema = item.schema || labelStr || 'public';
    await ErdPanel.openForSchemas(context, item, [schema]);
  }

  /**
   * Open ERD for multiple schemas on the same connection/database.
   */
  public static async openForSchemas(
    context: vscode.ExtensionContext,
    item: DatabaseTreeItem,
    schemas: string[]
  ): Promise<void> {
    let conn: Awaited<ReturnType<typeof resolveTreeItemConnection>> | undefined;

    try {
      conn = await resolveTreeItemConnection(item);
      if (!conn) {
        return;
      }

      const { client, metadata, connection } = conn;
      const db = item.databaseName || metadata?.databaseName || 'postgres';
      const uniqSchemas = [...new Set(schemas)].sort();

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Building ERD (${uniqSchemas.join(', ')})…`,
          cancellable: false,
        },
        async () => {
          const snapshot = await fetchErdSnapshot(client, uniqSchemas);
          const readOnlyConnection =
            (connection as { readOnlyMode?: boolean }).readOnlyMode === true ||
            item.readOnlyMode === true;

          const panelKey = `erd:${item.connectionId}:${db}:${uniqSchemas.join(',')}`;
          if (ErdPanel._panels.has(panelKey)) {
            ErdPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
            return;
          }

          const panel = vscode.window.createWebviewPanel(
            ErdPanel.viewType,
            `ERD: ${uniqSchemas.join(', ')}`,
            vscode.ViewColumn.One,
            {
              enableScripts: true,
              retainContextWhenHidden: true,
              localResourceRoots: [context.extensionUri],
            }
          );

          const erdPanel = new ErdPanel(panel);
          ErdPanel._panels.set(panelKey, erdPanel);
          panel.onDidDispose(() => ErdPanel._panels.delete(panelKey));

          const payload: ErdWebviewPayload = {
            snapshot,
            readOnlyConnection,
          };
          panel.webview.html = buildErdWebviewHtml(panel.webview, context.extensionUri, payload);

          panel.webview.onDidReceiveMessage(
            async (msg: Record<string, unknown>) => {
              if (msg.type === 'exportSvg' && typeof msg.svg === 'string') {
                const uri = await vscode.window.showSaveDialog({
                  defaultUri: vscode.Uri.file(`erd-${uniqSchemas.join('-')}.svg`),
                  filters: { 'SVG Image': ['svg'] },
                });
                if (uri) {
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.svg, 'utf8'));
                  vscode.window.showInformationMessage(`Exported SVG to ${uri.fsPath}`);
                }
              } else if (msg.type === 'exportPng' && typeof msg.base64 === 'string') {
                const uri = await vscode.window.showSaveDialog({
                  defaultUri: vscode.Uri.file(`erd-${uniqSchemas.join('-')}.png`),
                  filters: { PNG: ['png'] },
                });
                if (uri) {
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.base64, 'base64'));
                  vscode.window.showInformationMessage(`Exported PNG to ${uri.fsPath}`);
                }
              } else if (msg.type === 'exportText' && typeof msg.content === 'string') {
                const kind = msg.kind === 'mermaid' ? 'mermaid' : 'dbml';
                const ext = kind === 'mermaid' ? 'md' : 'dbml';
                const uri = await vscode.window.showSaveDialog({
                  defaultUri: vscode.Uri.file(`erd-${uniqSchemas.join('-')}.${ext}`),
                  filters:
                    kind === 'mermaid'
                      ? { Markdown: ['md'] }
                      : { DBML: ['dbml'] },
                });
                if (uri) {
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.content, 'utf8'));
                  vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
                }
              } else if (msg.type === 'erdRenameTable') {
                const qual = typeof msg.qual === 'string' ? msg.qual : '';
                const schema = typeof msg.schema === 'string' ? msg.schema : '';
                const currentName = typeof msg.currentName === 'string' ? msg.currentName : '';
                if (!qual || !schema || !currentName) {
                  return;
                }
                const next = await vscode.window.showInputBox({
                  title: `Rename table — ${schema}.${currentName}`,
                  prompt: 'New table name',
                  value: currentName,
                  validateInput: (v) => {
                    const t = v?.trim();
                    if (!t) {
                      return 'Enter a table name';
                    }
                    if (t === currentName) {
                      return 'Name unchanged';
                    }
                    return null;
                  },
                });
                if (next === undefined) {
                  return;
                }
                const to = next.trim();
                await panel.webview.postMessage({
                  type: 'erdRenameTableResult',
                  qual,
                  schema,
                  from: currentName,
                  to,
                });
              } else if (msg.type === 'erdRenameColumn') {
                const qual = typeof msg.qual === 'string' ? msg.qual : '';
                const schema = typeof msg.schema === 'string' ? msg.schema : '';
                const tableName = typeof msg.table === 'string' ? msg.table : '';
                const currentColumn = typeof msg.currentColumn === 'string' ? msg.currentColumn : '';
                if (!qual || !schema || !tableName || !currentColumn) {
                  return;
                }
                const next = await vscode.window.showInputBox({
                  title: `Rename column — ${schema}.${tableName}.${currentColumn}`,
                  prompt: 'New column name',
                  value: currentColumn,
                  validateInput: (v) => {
                    const t = v?.trim();
                    if (!t) {
                      return 'Enter a column name';
                    }
                    if (t === currentColumn) {
                      return 'Name unchanged';
                    }
                    return null;
                  },
                });
                if (next === undefined) {
                  return;
                }
                const to = next.trim();
                await panel.webview.postMessage({
                  type: 'erdRenameColumnResult',
                  qual,
                  schema,
                  table: tableName,
                  from: currentColumn,
                  to,
                });
              } else if (msg.type === 'erdAddColumn') {
                const qual = typeof msg.qual === 'string' ? msg.qual : '';
                const schema = typeof msg.schema === 'string' ? msg.schema : '';
                const tableName = typeof msg.table === 'string' ? msg.table : '';
                if (!qual || !schema || !tableName) {
                  return;
                }
                const name = await vscode.window.showInputBox({
                  title: `Add column — ${schema}.${tableName}`,
                  prompt: 'Column name',
                  validateInput: (v) => (v?.trim() ? null : 'Enter a column name'),
                });
                if (name === undefined) {
                  return;
                }
                const dataType = await vscode.window.showInputBox({
                  title: `Add column — ${name.trim()}`,
                  prompt: 'PostgreSQL type',
                  value: 'text',
                  validateInput: (v) => (v?.trim() ? null : 'Enter a type'),
                });
                if (dataType === undefined) {
                  return;
                }
                const nullPick = await vscode.window.showQuickPick(['NOT NULL', 'Nullable'], {
                  title: 'Nullability',
                  placeHolder: 'Column nullability',
                });
                if (nullPick === undefined) {
                  return;
                }
                await panel.webview.postMessage({
                  type: 'erdAddColumnResult',
                  qual,
                  schema,
                  table: tableName,
                  name: name.trim(),
                  dataType: dataType.trim(),
                  notNull: nullPick === 'NOT NULL',
                });
              } else if (msg.type === 'syncMigration') {
                const patches = msg.patches as ErdModelPatch[];
                if (!Array.isArray(patches) || patches.length === 0) {
                  vscode.window.showInformationMessage('No pending ERD edits to sync.');
                  return;
                }
                const stmts = patchesToMigrationSql(patches);
                const readOnlyNote =
                  msg.readOnly === true
                    ? '\n\n**Note:** This connection is read-only — review SQL before running elsewhere.'
                    : '';
                const md =
                  `### ERD migration draft\n\n` +
                  `Generated **${stmts.length}** statement(s) from ERD edits.${readOnlyNote}\n\n` +
                  `Review inside an explicit transaction; uncomment **COMMIT** or **ROLLBACK** at the bottom.`;

                const sqlCell =
                  `-- ERD migration (draft)\n-- Schemas: ${uniqSchemas.join(', ')}\n\n` +
                  `BEGIN;\n\n${stmts.join('\n\n')}\n\n` +
                  `-- COMMIT;\n-- ROLLBACK;`;

                const metaBase = createMetadata(connection, db) as PostgresMetadata;
                const meta: PostgresMetadata = {
                  ...metaBase,
                  readOnlyMode: (connection as { readOnlyMode?: boolean }).readOnlyMode === true,
                };

                await createAndShowNotebook(
                  [
                    new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown'),
                    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sqlCell, 'sql'),
                  ],
                  meta
                );
              }
            },
            null,
            erdPanel._disposables
          );
        }
      );
    } catch (err: unknown) {
      await ErrorHandlers.handleCommandError(err, 'open ERD');
    } finally {
      if (conn?.release) {
        conn.release();
      }
    }
  }

  public dispose(): void {
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
