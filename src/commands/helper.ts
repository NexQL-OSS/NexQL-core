import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { createAndShowNotebook, createMetadata, getConnectionWithPassword, validateItem, validateCategoryItem, validateRoleItem, validateNotebookContextItem } from './connection';
import { ConnectionManager } from '../services/ConnectionManager';
import { ErrorService } from '../services/ErrorService';
import { SessionRegistry } from '../services/SessionRegistry';

/** Module-level ExtensionContext set once by NotebookBuilder.setContext() */
let _extensionContext: vscode.ExtensionContext | undefined;

// Re-export SQL templates from sql/helper.ts for backward compatibility
export { SQL_TEMPLATES, QueryBuilder, MaintenanceTemplates } from './sql/helper';

export { validateItem, validateCategoryItem, validateRoleItem, validateNotebookContextItem };

/** Get database connection and metadata for tree item operations */
export async function getDatabaseConnection(item: DatabaseTreeItem, validateFn: (item: DatabaseTreeItem) => void = validateItem) {
  validateFn(item);
  const connection = await getConnectionWithPassword(item.connectionId!, item.databaseName);
  const client = await ConnectionManager.getInstance().getPooledClient({
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    database: item.databaseName,
    name: connection.name
  });
  const metadata = createMetadata(connection, item.databaseName);
  return {
    connection,
    client,
    metadata: { ...metadata, name: connection.name },
    release: () => client.release()
  };
}
/** Fluent builder for notebook cells */
export class NotebookBuilder {
  private cells: vscode.NotebookCellData[] = [];
  private readonly connectionId: string | undefined;
  private readonly databaseName: string | undefined;
  /** Composite key used for registry and scratch file: "{connectionId}:{databaseName}" */
  private readonly sessionKey: string | undefined;

  constructor(private metadata: any) {
    this.connectionId = metadata?.connectionId as string | undefined;
    this.databaseName = (metadata?.databaseName ?? metadata?.database) as string | undefined;
    if (this.connectionId && this.databaseName) {
      this.sessionKey = `${this.connectionId}:${this.databaseName}`;
    }
  }

  /**
   * Called once during extension activation to provide the ExtensionContext.
   * Satisfies Requirement 5.4.
   */
  static setContext(context: vscode.ExtensionContext): void {
    _extensionContext = context;
  }

  addMarkdown(content: string): NotebookBuilder {
    this.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, content, 'markdown'));
    return this;
  }

  addSql(content: string): NotebookBuilder {
    this.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, content, 'sql'));
    return this;
  }

  /** Human-readable tab title: "{connectionName}-{databaseName}" or just "{databaseName}" */
  private _scratchTitle(): string {
    const connName = (this.metadata?.name ?? this.metadata?.connectionName) as string | undefined;
    return connName ? `${connName}-${this.databaseName}` : this.databaseName!;
  }

  /**
   * Always opens a brand-new named notebook file, bypassing the persistent session.
   * Creates `{connectionName}-{databaseName}-{n}.pgsql` in globalStorageUri.
   * Use this for explicit "New Notebook" / "Query Tool" actions.
   */
  async showNew(): Promise<void> {
    if (_extensionContext && this.databaseName) {
      const { getNewNotebookUri } = await import('../services/SessionRegistry');
      await vscode.workspace.fs.createDirectory(_extensionContext.globalStorageUri);
      const uri = await getNewNotebookUri(
        _extensionContext.globalStorageUri,
        this.databaseName,
        this.metadata?.name as string | undefined
      );
      // Ensure nested folder exists before writing
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      const fileMetadata = {
        connectionId: this.metadata?.connectionId,
        host: this.metadata?.host,
        port: this.metadata?.port,
        username: this.metadata?.username,
        database: this.databaseName,
        databaseName: this.databaseName,
        title: this._scratchTitle(),
      };
      // Serialize initial cells into the file so content is immediately visible
      const cells = this.cells.map(c => ({
        value: c.value,
        kind: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql',
        language: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql',
      }));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ cells, metadata: fileMetadata })));
      const notebook = await vscode.workspace.openNotebookDocument(uri);
      const editor = await vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
      if (notebook.cellCount > 0) {
        editor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.AtTop);
      }
    } else {
      // Fallback when context not set (e.g. tests / legacy path)
      await createAndShowNotebook(this.cells, this.metadata);
    }
  }

  async show(): Promise<void> {
    // Persistent session path: requires sessionKey (connectionId + databaseName) and extension context
    if (this.sessionKey && _extensionContext) {
      await this._showPersistent();
    } else {
      // Legacy fallback: open a new untitled notebook (Req 5.3)
      await createAndShowNotebook(this.cells, this.metadata);
    }
  }

  private async _showPersistent(): Promise<void> {
    const sessionKey = this.sessionKey!;
    const context = _extensionContext!;
    const { getScratchUri, getLatestNumberedUri, isNotebookForSession } = await import('../services/SessionRegistry');
    const scratchUri = getScratchUri(
      context.globalStorageUri,
      this.connectionId!,
      this.databaseName!,
      this.metadata?.name as string | undefined
    );

    const connName = this.metadata?.name as string | undefined;

    // ── Priority 1: active notebook editor, if it belongs to this connection+db ──
    let doc: vscode.NotebookDocument | undefined;
    const activeEditor = vscode.window.activeNotebookEditor;
    if (activeEditor && !activeEditor.notebook.isClosed) {
      if (isNotebookForSession(activeEditor.notebook.uri, this.databaseName!, connName, this.connectionId)) {
        doc = activeEditor.notebook;
        // Keep registry in sync
        SessionRegistry.set(sessionKey, doc);
      }
    }

    // ── Priority 2: registry entry (last known open doc for this session) ──
    if (!doc) {
      const registered = SessionRegistry.get(sessionKey);
      if (registered && !registered.isClosed) {
        doc = registered;
      } else if (registered?.isClosed) {
        SessionRegistry.delete(sessionKey);
      }
    }

    // ── Priority 3: scan open notebook documents for any matching file ──
    if (!doc) {
      const existing = vscode.workspace.notebookDocuments.find(
        nd => !nd.isClosed && isNotebookForSession(nd.uri, this.databaseName!, connName, this.connectionId)
      );
      if (existing) {
        SessionRegistry.set(sessionKey, existing);
        doc = existing;
      }
    }

    // ── Priority 4: latest numbered file on disk (e.g. -2.pgsql before -1.pgsql) ──
    if (!doc) {
      const latestUri = await getLatestNumberedUri(context.globalStorageUri, this.databaseName!, connName);
      if (latestUri) {
        const notebook = await vscode.workspace.openNotebookDocument(latestUri);
        SessionRegistry.set(sessionKey, notebook);
        doc = notebook;
      }
    }

    // ── Priority 5: base scratch file ──
    if (!doc) {
      let fileExists = false;
      try { await vscode.workspace.fs.stat(scratchUri); fileExists = true; } catch { /* not found */ }
      if (fileExists) {
        const notebook = await vscode.workspace.openNotebookDocument(scratchUri);
        SessionRegistry.set(sessionKey, notebook);
        doc = notebook;
      }
    }

    if (doc) {
      // Cell count guard: warn when the notebook is getting large
      const CELL_LIMIT = 150;
      if (doc.cellCount >= CELL_LIMIT) {
        const choice = await vscode.window.showWarningMessage(
          `The scratch notebook for ${this.databaseName} has ${doc.cellCount} cells and may be getting large.`,
          { modal: false },
          'Continue anyway',
          'Open new notebook instead'
        );
        if (choice === 'Open new notebook instead') {
          await this.showNew();
          return;
        }
        if (!choice) { return; } // dismissed
      }

      // Capture insertion point before appending so we can scroll to the first new cell
      const firstNewCellIndex = doc.cellCount;

      // Add a visual separator when appending to an existing notebook with content
      const cellsToInsert = [...this.cells];
      if (firstNewCellIndex > 0) {
        const timestamp = new Date().toLocaleString();
        const separator = new vscode.NotebookCellData(
          vscode.NotebookCellKind.Markup,
          `---\n\n*Section added: ${timestamp}*`,
          'markdown'
        );
        cellsToInsert.unshift(separator);
      }

      // Append cells to the already-open document (Req 2.1, 2.2, 4.2)
      const edit = new vscode.WorkspaceEdit();
      edit.set(doc.uri, [
        vscode.NotebookEdit.insertCells(firstNewCellIndex, cellsToInsert)
      ]);
      await vscode.workspace.applyEdit(edit);

      // Reveal the first of the newly appended cells so the user lands at the top of the new content
      const notebookEditor = await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
      if (firstNewCellIndex < doc.cellCount) {
        notebookEditor.revealRange(
          new vscode.NotebookRange(firstNewCellIndex, firstNewCellIndex + 1),
          vscode.NotebookEditorRevealType.AtTop
        );
      }
    } else {
      // No existing file found — create the base scratch file for this connection+db
      // Ensure nested folder structure exists: {globalStorageUri}/{connectionName}/{databaseName}/
      const scratchDir = vscode.Uri.joinPath(scratchUri, '..');
      await vscode.workspace.fs.createDirectory(scratchDir);
      const fileMetadata = {
        connectionId: this.metadata?.connectionId,
        host: this.metadata?.host,
        port: this.metadata?.port,
        username: this.metadata?.username,
        database: this.databaseName,
        databaseName: this.databaseName,
        title: this._scratchTitle(),
      };
      await vscode.workspace.fs.writeFile(scratchUri, Buffer.from(JSON.stringify({ cells: [], metadata: fileMetadata })));
      const notebook = await vscode.workspace.openNotebookDocument(scratchUri);
      SessionRegistry.set(sessionKey, notebook);

      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(0, this.cells)]);
      await vscode.workspace.applyEdit(edit);

      const notebookEditor = await vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
      if (notebook.cellCount > 0) {
        notebookEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.AtTop);
      }
    }
  }
}
/** Markdown formatting utilities */
export const MarkdownUtils = {
  infoBox: (message: string, title = 'Note'): string =>
    `<div style="font-size: 12px; background-color: rgba(52, 152, 219, 0.1); border-left: 3px solid #3498db; padding: 6px 10px; margin-bottom: 15px; border-radius: 3px; color: var(--vscode-editor-foreground);">
    <strong>ℹ️ ${title}:</strong> ${message}
</div>`,
  warningBox: (message: string, title = 'Warning'): string =>
    `<div style="font-size: 12px; background-color: rgba(231, 76, 60, 0.1); border-left: 3px solid #e74c3c; padding: 6px 10px; margin-bottom: 15px; border-radius: 3px; color: var(--vscode-editor-foreground);">
    <strong>⚠️ ${title}:</strong> ${message}
</div>`,
  dangerBox: (message: string, title = 'DANGER'): string =>
    `<div style="font-size: 12px; background-color: rgba(231, 76, 60, 0.1); border-left: 3px solid #e74c3c; padding: 6px 10px; margin-bottom: 15px; border-radius: 3px; color: var(--vscode-editor-foreground);">
    <strong>🛑 ${title}:</strong> ${message}
</div>`,
  dangerBoxDrop: (objectType: string, schema: string, name: string): string =>
    MarkdownUtils.dangerBox(`Dropping \`${schema}.${name}\` is permanent and will fail if dependent objects exist.`, `Drop ${objectType}`),
  successBox: (message: string, title = 'Tip'): string =>
    `<div style="font-size: 12px; background-color: rgba(46, 204, 113, 0.1); border-left: 3px solid #2ecc71; padding: 6px 10px; margin-bottom: 15px; border-radius: 3px; color: var(--vscode-editor-foreground);">
    <strong>💡 ${title}:</strong> ${message}
</div>`,
  detailsFold: (title: string, body: string): string =>
    `<details><summary>${title}</summary>

${body}

</details>`,
  optionsList: (items: string[]): string =>
    items.length ? `**Options:**\n${items.map(item => `- ${item}`).join('\n')}` : '',
  operationsTable: (operations: Array<{ operation: string, description: string, riskLevel?: string }>): string => {
    const rows = operations.map(op => {
      const risk = op.riskLevel ? `<td>${op.riskLevel}</td>` : '';
      return `    <tr><td><strong>${op.operation}</strong></td><td>${op.description}</td>${risk}</tr>`;
    }).join('\n');

    const headers = operations[0]?.riskLevel
      ? '<tr><th style="text-align: left;">Operation</th><th style="text-align: left;">Description</th><th style="text-align: left;">Risk Level</th></tr>'
      : '<tr><th style="text-align: left;">Operation</th><th style="text-align: left;">Description</th></tr>';

    return `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    ${headers}
${rows}
</table>`;
  },
  propertiesTable: (properties: Record<string, string>): string => {
    const rows = Object.entries(properties).map(([key, value]) =>
      `    <tr><td><strong>${key}</strong></td><td>${value}</td></tr>`
    ).join('\n');

    return `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left; width: 30%;">Property</th><th style="text-align: left;">Value</th></tr>
${rows}
</table>`;
  },
  header: (title: string, subtitle?: string): string => {
    return subtitle ? `### ${title}\n\n${subtitle}\n\n` : `### ${title}\n\n`;
  }
};

/** PostgreSQL object utilities */
export const ObjectUtils = {
  getKindLabel: (kind: string): string => {
    const labels: Record<string, string> = {
      'r': '📊 Table',
      'v': '👁️ View',
      'm': '💾 Materialized View',
      'i': '🔍 Index',
      'S': '🔢 Sequence',
      'f': '🌍 Foreign Table',
      'p': '📂 Partitioned Table',
      's': '⚙️ Special',
      'c': '🔗 Composite Type',
      'e': '🏷️ Enum Type',
      't': '📑 TOAST Table'
    };
    return labels[kind] || kind;
  },
  getConstraintIcon: (type: string): string => {
    const icons: Record<string, string> = {
      'PRIMARY KEY': '🔑',
      'FOREIGN KEY': '🔗',
      'UNIQUE': '⭐',
      'CHECK': '✓',
      'EXCLUSION': '⊗'
    };
    return icons[type] || '📌';
  },
  getIndexIcon: (isPrimary: boolean, isUnique: boolean): string => {
    if (isPrimary) return '🔑';
    if (isUnique) return '⭐';
    return '🔍';
  }
};
/** Format helpers for display */
export const FormatHelpers = {
  formatBytes: (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  },
  formatBoolean: (value: boolean, trueText = 'Yes', falseText = 'No'): string =>
    value ? `✅ ${trueText}` : `🚫 ${falseText}`,
  escapeSqlString: (str: string): string => str.replace(/'/g, "''"),
  formatArray: (arr: any[], emptyText = '—'): string =>
    arr?.length ? arr.join(', ') : emptyText,
  formatNumber: (num: number): string => num.toLocaleString(),
  formatPercentage: (num: number): string => `${num}%`
};

/** Validation helpers */
export const ValidationHelpers = {
  validateColumnName: (value: string): string | null => {
    if (!value) return 'Column name cannot be empty';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      return 'Invalid column name. Use only letters, numbers, and underscores.';
    }
    return null;
  },
  validateIdentifier: (value: string, objectType = 'object'): string | null => {
    if (!value) return `${objectType} name cannot be empty`;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      return `Invalid ${objectType} name. Use only letters, numbers, and underscores.`;
    }
    return null;
  }
};
/** Error handling patterns */
export const ErrorHandlers = {
  showError: async (message: string, actionLabel?: string, actionCommand?: string): Promise<void> =>
    ErrorService.getInstance().showError(message, actionLabel, actionCommand),
  handleCommandError: async (err: any, operation: string): Promise<void> =>
    ErrorService.getInstance().handleCommandError(err, operation)
};

/** String cleaning utilities */
export const StringUtils = {
  cleanMarkdownCodeBlocks: (text: string): string =>
    text.replace(/^```sql\n/, '').replace(/^```\n/, '').replace(/\n```$/, ''),
  truncate: (text: string, maxLength: number): string =>
    text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text
};

