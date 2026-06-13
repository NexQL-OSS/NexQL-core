import * as vscode from 'vscode';
import { SENTINEL_HEADER_CELL_ROLE, SENTINEL_STRIP_HIDDEN_METADATA_KEY } from './constants';
import type { SentinelContext, SentinelNotebookHeaderPayload } from './types';

const HEADER_MIME = 'application/x-postgres-notebook-header+json';
const HEADER_MARKDOWN = '<!-- NexQL Sentinel connection context -->';

/**
 * Maintains an optional collapsed markdown cell at the top of tagged notebooks
 * that renders the in-editor Sentinel context strip via the notebook renderer.
 */
export class NotebookContextStripService {
  private static readonly mutatingNotebooks = new Set<string>();
  private readonly lastPayloadKey = new Map<string, string>();

  constructor(private readonly rendererMessaging: vscode.NotebookRendererMessaging) {}

  /** True while this service is applying a notebook edit (avoid sync feedback loops). */
  static isMutating(notebookUri: vscode.Uri): boolean {
    return NotebookContextStripService.mutatingNotebooks.has(notebookUri.toString());
  }

  isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('postgresExplorer.sentinel')
      .get<boolean>('notebookContextStrip', true);
  }

  async sync(editor: vscode.NotebookEditor | undefined, context: SentinelContext | null): Promise<void> {
    if (!editor) {
      return;
    }

    const notebook = editor.notebook;
    if (notebook.metadata?.[SENTINEL_STRIP_HIDDEN_METADATA_KEY] === true) {
      const headerIndex = this.findHeaderCellIndex(notebook);
      if (headerIndex >= 0) {
        await this.setHeaderOutput(notebook, headerIndex, this.buildPayload(null));
      }
      return;
    }

    if (!this.isEnabled()) {
      const headerIndex = this.findHeaderCellIndex(notebook);
      if (headerIndex >= 0) {
        await this.setHeaderOutput(notebook, headerIndex, this.buildPayload(null));
      }
      return;
    }
    const headerIndex = this.findHeaderCellIndex(notebook);
    if (headerIndex < 0) {
      this.lastPayloadKey.delete(notebook.uri.toString());
    }
    const payload = this.buildPayload(context);

    if (!context) {
      if (headerIndex >= 0) {
        await this.setHeaderOutput(notebook, headerIndex, { ...payload, enabled: false });
      }
      return;
    }

    if (headerIndex < 0) {
      const index = await this.insertHeaderCell(notebook, payload);
      if (index < 0) {
        return;
      }
      return;
    }

    await this.setHeaderOutput(notebook, headerIndex, payload);
  }

  private buildPayload(context: SentinelContext | null): SentinelNotebookHeaderPayload {
    if (!context) {
      return {
        enabled: false,
        connectionName: '',
        host: '',
        port: 5432,
        database: '',
        username: '',
        readOnlyMode: false,
        isConnected: false,
      };
    }

    return {
      enabled: true,
      connectionName: context.connectionName,
      host: context.host,
      port: context.port,
      database: context.database,
      username: context.username,
      environment: context.environment,
      readOnlyMode: context.readOnlyMode,
      isConnected: true,
    };
  }

  private findHeaderCellIndex(notebook: vscode.NotebookDocument): number {
    return notebook.getCells().findIndex((cell) => {
      if (cell.kind !== vscode.NotebookCellKind.Markup) {
        return false;
      }
      if (cell.metadata?.[SENTINEL_HEADER_CELL_ROLE] === true) {
        return true;
      }
      return cell.document.getText().trim() === HEADER_MARKDOWN;
    });
  }

  private payloadKey(payload: SentinelNotebookHeaderPayload): string {
    return JSON.stringify(payload);
  }

  private shouldSkipPayloadUpdate(notebook: vscode.NotebookDocument, payload: SentinelNotebookHeaderPayload): boolean {
    const key = this.payloadKey(payload);
    const uri = notebook.uri.toString();
    return this.lastPayloadKey.get(uri) === key;
  }

  private rememberPayload(notebook: vscode.NotebookDocument, payload: SentinelNotebookHeaderPayload): void {
    this.lastPayloadKey.set(notebook.uri.toString(), this.payloadKey(payload));
  }

  private async withNotebookEdit<T>(notebook: vscode.NotebookDocument, fn: () => Promise<T>): Promise<T> {
    const uri = notebook.uri.toString();
    NotebookContextStripService.mutatingNotebooks.add(uri);
    try {
      return await fn();
    } finally {
      setTimeout(() => NotebookContextStripService.mutatingNotebooks.delete(uri), 0);
    }
  }

  private buildHeaderCellData(payload: SentinelNotebookHeaderPayload): vscode.NotebookCellData {
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      HEADER_MARKDOWN,
      'markdown',
    );
    cell.metadata = { [SENTINEL_HEADER_CELL_ROLE]: true };
    cell.outputs = [
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(payload, HEADER_MIME),
      ]),
    ];
    return cell;
  }

  private async insertHeaderCell(
    notebook: vscode.NotebookDocument,
    payload: SentinelNotebookHeaderPayload,
  ): Promise<number> {
    if (this.shouldSkipPayloadUpdate(notebook, payload)) {
      return this.findHeaderCellIndex(notebook);
    }

    return this.withNotebookEdit(notebook, async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(0, [this.buildHeaderCellData(payload)])]);
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) {
        this.rememberPayload(notebook, payload);
        return 0;
      }
      return -1;
    });
  }

  private async setHeaderOutput(
    notebook: vscode.NotebookDocument,
    cellIndex: number,
    payload: SentinelNotebookHeaderPayload,
  ): Promise<void> {
    if (this.shouldSkipPayloadUpdate(notebook, payload)) {
      return;
    }

    const cell = notebook.cellAt(cellIndex);
    const hasHeaderOutput = cell.outputs.some((output) =>
      output.items.some((item) => item.mime === HEADER_MIME),
    );

    if (hasHeaderOutput) {
      this.rememberPayload(notebook, payload);
      this.postHeaderMessage(notebook, payload);
      return;
    }

    await this.withNotebookEdit(notebook, async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [
        vscode.NotebookEdit.replaceCells(
          new vscode.NotebookRange(cellIndex, cellIndex + 1),
          [this.buildHeaderCellData(payload)],
        ),
      ]);
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) {
        this.rememberPayload(notebook, payload);
        this.postHeaderMessage(notebook, payload);
      }
    });
  }

  private postHeaderMessage(notebook: vscode.NotebookDocument, payload: SentinelNotebookHeaderPayload): void {
    const editor = vscode.window.visibleNotebookEditors.find((e) => e.notebook === notebook);
    if (editor) {
      void this.rendererMessaging.postMessage({ type: 'sentinel/header', payload }, editor);
    }
  }
}
