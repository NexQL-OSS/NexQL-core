import * as vscode from 'vscode';
import { ErrorHandlers } from '../commands/helper';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { resolveTreeItemConnection } from './connectionHelper';
import { TelemetryService } from '../services/TelemetryService';

/**
 * Visual Table Designer Panel
 *
 * Opens an interactive webview for designing/editing a PostgreSQL table.
 * Supports both "Edit" mode (existing table) and "Create" mode (new table).
 * Generates ALTER TABLE / CREATE TABLE DDL and opens it in a notebook for review.
 */
export class TableDesignerPanel {
  public static readonly viewType = 'pgStudio.tableDesigner';

  private static _panels = new Map<string, TableDesignerPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    TelemetryService.getInstance().trackDesignerOpened('table');
  }

  /**
   * Open Table Designer for an existing table (Edit mode)
   */
  public static async openForTable(
    item: DatabaseTreeItem,
    context: vscode.ExtensionContext
  ): Promise<void> {
    let dbConn;
    try {
      dbConn = await resolveTreeItemConnection(item);
      if (!dbConn) return; // user cancelled
      const { client, metadata, connection } = dbConn;
      const schema = item.schema!;
      const tableName = item.label;

      // Fetch columns
      const colResult = await client.query(`
        SELECT
          a.attnum as ordinal,
          a.attname as column_name,
          pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
          a.attnotnull as not_null,
          pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_value,
          CASE WHEN pk.contype = 'p' THEN true ELSE false END as is_primary_key,
          CASE WHEN uq.contype = 'u' THEN true ELSE false END as is_unique,
          col_description(a.attrelid, a.attnum) as comment
        FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d
          ON d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef
        LEFT JOIN pg_catalog.pg_constraint pk
          ON pk.conrelid = a.attrelid AND a.attnum = ANY(pk.conkey) AND pk.contype = 'p'
        LEFT JOIN pg_catalog.pg_constraint uq
          ON uq.conrelid = a.attrelid AND a.attnum = ANY(uq.conkey) AND uq.contype = 'u'
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [`"${schema}"."${tableName}"`]);

      const columns = colResult.rows;

      // Fetch table comment
      const commentResult = await client.query(`
        SELECT obj_description(c.oid, 'pg_class') as comment
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = $2
      `, [tableName, schema]);
      const tableComment = commentResult.rows[0]?.comment || '';

      // Fetch constraints
      const conResult = await client.query(`
        SELECT
          conname as name,
          CASE contype
            WHEN 'p' THEN 'PRIMARY KEY'
            WHEN 'f' THEN 'FOREIGN KEY'
            WHEN 'u' THEN 'UNIQUE'
            WHEN 'c' THEN 'CHECK'
            ELSE contype
          END as type,
          pg_get_constraintdef(oid) as definition
        FROM pg_constraint
        WHERE conrelid = $1::regclass
        ORDER BY conname
      `, [`"${schema}"."${tableName}"`]);
      const constraints = conResult.rows;

      // Fetch indexes
      const idxResult = await client.query(`
        SELECT
          i.relname as name,
          pg_get_indexdef(ix.indexrelid) as definition,
          ix.indisunique as is_unique,
          ix.indisprimary as is_primary
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = $1 AND n.nspname = $2
        ORDER BY i.relname
      `, [tableName, schema]);
      const indexes = idxResult.rows;

      const panelKey = `${item.connectionId}:${item.databaseName}:${schema}.${tableName}`;

      if (TableDesignerPanel._panels.has(panelKey)) {
        TableDesignerPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        TableDesignerPanel.viewType,
        `🎨 ${schema}.${tableName}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')]
        }
      );

      const designer = new TableDesignerPanel(panel, context.extensionUri, context);
      TableDesignerPanel._panels.set(panelKey, designer);

      panel.onDidDispose(() => {
        TableDesignerPanel._panels.delete(panelKey);
      });

      panel.webview.html = TableDesignerPanel._getHtml(
        panel.webview,
        schema,
        tableName,
        columns,
        constraints,
        indexes,
        tableComment,
        false
      );

      // Handle messages from the webview
      panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
          case 'applyChanges': {
            await TableDesignerPanel._applyChanges(
              message.original,
              message.modified,
              message.constraints || [],
              message.indexes || [],
              schema,
              tableName,
              metadata
            );
            break;
          }
          case 'copySQL': {
            await vscode.env.clipboard.writeText(message.sql);
            vscode.window.showInformationMessage('SQL copied to clipboard');
            break;
          }
        }
      }, null, designer._disposables);

    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'open table designer');
    } finally {
      if (dbConn && dbConn.release) dbConn.release();
    }
  }

  /**
   * Open Table Designer in Create mode (new table)
   */
  public static async openForCreate(
    item: DatabaseTreeItem,
    context: vscode.ExtensionContext
  ): Promise<void> {
    let dbConn;
    try {
      dbConn = await resolveTreeItemConnection(item);
      if (!dbConn) return; // user cancelled
      const { metadata } = dbConn;
      const labelStr = typeof item.label === 'string' ? item.label : (item.label as any)?.label ?? '';
      const schema = item.schema || labelStr || 'public';

      const panelKey = `create:${item.connectionId}:${item.databaseName}:${schema}`;

      if (TableDesignerPanel._panels.has(panelKey)) {
        TableDesignerPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        TableDesignerPanel.viewType,
        `🎨 New Table in ${schema}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      const designer = new TableDesignerPanel(panel, context.extensionUri, context);
      TableDesignerPanel._panels.set(panelKey, designer);

      panel.onDidDispose(() => {
        TableDesignerPanel._panels.delete(panelKey);
      });

      // Start with a default id column
      const defaultColumns = [
        {
          ordinal: 1,
          column_name: 'id',
          data_type: 'bigserial',
          not_null: true,
          default_value: null,
          is_primary_key: true,
          is_unique: false,
          comment: ''
        }
      ];

      panel.webview.html = TableDesignerPanel._getHtml(
        panel.webview,
        schema,
        '',
        defaultColumns,
        [], // constraints
        [], // indexes
        '',
        true
      );

      panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
          case 'applyChanges': {
            await TableDesignerPanel._createTable(
              message.tableName,
              schema,
              message.modified,
              message.tableComment,
              message.constraints || [],
              message.indexes || [],
              metadata
            );
            break;
          }
          case 'copySQL': {
            await vscode.env.clipboard.writeText(message.sql);
            vscode.window.showInformationMessage('SQL copied to clipboard');
            break;
          }
        }
      }, null, designer._disposables);

    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'open table designer (create)');
    } finally {
      if (dbConn && dbConn.release) dbConn.release();
    }
  }

  /**
   * Generate ALTER TABLE SQL from diff and open in notebook
   */
  private static async _applyChanges(
    original: any[],
    modified: any[],
    constraints: any[],
    indexes: any[],
    schema: string,
    tableName: string,
    metadata: any
  ): Promise<void> {
    const statements: string[] = [];

    // 1. Drop/Add Constraints
    for (const con of constraints) {
      if (con._deleted) {
        statements.push(`-- Drop Constraint\nALTER TABLE "${schema}"."${tableName}"\n  DROP CONSTRAINT IF EXISTS "${con.name}";`);
      } else if (con._new) {
        statements.push(`-- Add Constraint\nALTER TABLE "${schema}"."${tableName}"\n  ADD CONSTRAINT "${con.name}" ${con.rawDef};`);
      }
    }

    // 2. Drop/Add Indexes
    for (const idx of indexes) {
      if (idx._deleted) {
        statements.push(`-- Drop Index\nDROP INDEX IF EXISTS "${schema}"."${idx.name}";`);
      } else if (idx._new) {
        const unique = idx.is_unique ? 'UNIQUE ' : '';
        const cols = idx.columns.map((c: string) => '"' + c + '"').join(', ');
        statements.push(`-- Create Index\nCREATE ${unique}INDEX "${idx.name}" ON "${schema}"."${tableName}" USING ${idx.method} (${cols});`);
      }
    }

    const originalMap = new Map(original.map((c: any) => [c.column_name, c]));
    const modifiedMap = new Map(modified.map((c: any) => [c.column_name, c]));

    // Detect dropped columns
    for (const [name, col] of originalMap) {
      if (!modifiedMap.has(name) && !col._deleted) {
        // column was removed from the list
      }
      if (col._deleted) {
        statements.push(`-- Drop column\nALTER TABLE "${schema}"."${tableName}"\n  DROP COLUMN "${name}";`);
      }
    }

    // Detect added columns
    for (const col of modified) {
      if (col._new) {
        const notNull = col.not_null ? ' NOT NULL' : '';
        const defaultVal = col.default_value ? ` DEFAULT ${col.default_value}` : '';
        statements.push(
          `-- Add column\nALTER TABLE "${schema}"."${tableName}"\n  ADD COLUMN "${col.column_name}" ${col.data_type}${notNull}${defaultVal};`
        );
        if (col.is_primary_key) {
          statements.push(
            `-- Add primary key\nALTER TABLE "${schema}"."${tableName}"\n  ADD PRIMARY KEY ("${col.column_name}");`
          );
        }
        if (col.comment) {
          statements.push(
            `-- Add column comment\nCOMMENT ON COLUMN "${schema}"."${tableName}"."${col.column_name}" IS '${col.comment.replace(/'/g, "''")}';`
          );
        }
      } else {
        // Detect modified columns
        const orig = originalMap.get(col.column_name);
        if (!orig) continue;

        if (orig.data_type !== col.data_type) {
          statements.push(
            `-- Change column type\nALTER TABLE "${schema}"."${tableName}"\n  ALTER COLUMN "${col.column_name}" TYPE ${col.data_type};`
          );
        }
        if (orig.not_null !== col.not_null) {
          if (col.not_null) {
            statements.push(
              `-- Set NOT NULL\nALTER TABLE "${schema}"."${tableName}"\n  ALTER COLUMN "${col.column_name}" SET NOT NULL;`
            );
          } else {
            statements.push(
              `-- Drop NOT NULL\nALTER TABLE "${schema}"."${tableName}"\n  ALTER COLUMN "${col.column_name}" DROP NOT NULL;`
            );
          }
        }
        if ((orig.default_value || '') !== (col.default_value || '')) {
          if (col.default_value) {
            statements.push(
              `-- Set default\nALTER TABLE "${schema}"."${tableName}"\n  ALTER COLUMN "${col.column_name}" SET DEFAULT ${col.default_value};`
            );
          } else {
            statements.push(
              `-- Drop default\nALTER TABLE "${schema}"."${tableName}"\n  ALTER COLUMN "${col.column_name}" DROP DEFAULT;`
            );
          }
        }
        if ((orig.comment || '') !== (col.comment || '')) {
          statements.push(
            `-- Update column comment\nCOMMENT ON COLUMN "${schema}"."${tableName}"."${col.column_name}" IS '${(col.comment || '').replace(/'/g, "''")}';`
          );
        }
      }
    }

    if (statements.length === 0) {
      vscode.window.showInformationMessage('No changes detected.');
      return;
    }

    const { createAndShowNotebook } = await import('../commands/connection');
    const cells: vscode.NotebookCellData[] = [
      new vscode.NotebookCellData(
        vscode.NotebookCellKind.Markup,
        `### 🎨 Table Designer: \`${schema}.${tableName}\`\n\n` +
        `<div style="font-size:12px;background:rgba(52,152,219,0.1);border-left:3px solid #3498db;padding:6px 10px;margin-bottom:15px;border-radius:3px;">` +
        `<strong>ℹ️ Review:</strong> Review each statement carefully before executing. Run them in a transaction for safety.</div>\n\n` +
        `Generated **${statements.length}** change(s).`,
        'markdown'
      ),
      new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        `-- Generated by NexQL Table Designer\n-- Review carefully before executing!\n\nBEGIN;\n\n${statements.join('\n\n')}\n\n-- COMMIT; -- Uncomment to apply changes\n-- ROLLBACK; -- Uncomment to cancel`,
        'sql'
      )
    ];

    await createAndShowNotebook(cells, metadata);
  }

  /**
   * Generate CREATE TABLE SQL and open in notebook
   */
  private static async _createTable(
    tableName: string,
    schema: string,
    columns: any[],
    tableComment: string,
    constraints: any[],
    indexes: any[],
    metadata: any
  ): Promise<void> {
    if (!tableName || !tableName.trim()) {
      vscode.window.showWarningMessage('Please enter a table name.');
      return;
    }

    const pkCols = columns.filter(c => c.is_primary_key).map(c => `"${c.column_name}"`);
    const colDefs = columns.map(c => {
      const notNull = c.not_null ? ' NOT NULL' : '';
      const defaultVal = c.default_value ? ` DEFAULT ${c.default_value}` : '';
      return `  "${c.column_name}" ${c.data_type}${notNull}${defaultVal}`;
    });

    if (pkCols.length > 0) {
      colDefs.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    }

    const createSQL = `CREATE TABLE "${schema}"."${tableName}" (\n${colDefs.join(',\n')}\n);`;

    const constraintStatements: string[] = [];
    for (const con of constraints) {
      if (con?._deleted) continue;
      if (!con?.name || !con?.rawDef) continue;
      constraintStatements.push(
        `ALTER TABLE "${schema}"."${tableName}"\n  ADD CONSTRAINT "${con.name}" ${con.rawDef};`
      );
    }

    const indexStatements: string[] = [];
    for (const idx of indexes) {
      if (idx?._deleted) continue;
      if (!idx?.name || !idx?.method || !Array.isArray(idx?.columns) || idx.columns.length === 0) continue;
      const unique = idx.is_unique ? 'UNIQUE ' : '';
      const cols = idx.columns.map((c: string) => `"${c}"`).join(', ');
      indexStatements.push(
        `CREATE ${unique}INDEX "${idx.name}" ON "${schema}"."${tableName}" USING ${idx.method} (${cols});`
      );
    }

    const commentStatements: string[] = [];
    if (tableComment) {
      commentStatements.push(`COMMENT ON TABLE "${schema}"."${tableName}" IS '${tableComment.replace(/'/g, "''")}';`);
    }
    for (const col of columns) {
      if (col.comment) {
        commentStatements.push(`COMMENT ON COLUMN "${schema}"."${tableName}"."${col.column_name}" IS '${col.comment.replace(/'/g, "''")}';`);
      }
    }

    const { createAndShowNotebook } = await import('../commands/connection');
    const cells: vscode.NotebookCellData[] = [
      new vscode.NotebookCellData(
        vscode.NotebookCellKind.Markup,
        `### 🎨 Create Table: \`${schema}.${tableName}\`\n\n` +
        `<div style="font-size:12px;background:rgba(46,204,113,0.1);border-left:3px solid #2ecc71;padding:6px 10px;margin-bottom:15px;border-radius:3px;">` +
        `<strong>💡 Tip:</strong> Review the generated SQL, then execute to create the table.</div>`,
        'markdown'
      ),
      new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        `-- Generated by NexQL Table Designer\n${createSQL}` +
        `${constraintStatements.length > 0 ? '\n\n-- Additional constraints\n' + constraintStatements.join('\n\n') : ''}` +
        `${indexStatements.length > 0 ? '\n\n-- Additional indexes\n' + indexStatements.join('\n\n') : ''}` +
        `${commentStatements.length > 0 ? '\n\n' + commentStatements.join('\n') : ''}`,
        'sql'
      )
    ];

    await createAndShowNotebook(cells, metadata);
  }

  private static _getHtml(
    webview: vscode.Webview,
    schema: string,
    tableName: string,
    columns: any[],
    constraints: any[],
    indexes: any[],
    tableComment: string,
    isCreate: boolean
  ): string {
    const columnsJson = JSON.stringify(columns);
    const constraintsJson = JSON.stringify(constraints);
    const indexesJson = JSON.stringify(indexes);
    const mode = isCreate ? 'create' : 'edit';

    const pgTypes = [
      'bigint', 'bigserial', 'boolean', 'bytea', 'char', 'character varying',
      'date', 'double precision', 'integer', 'interval', 'json', 'jsonb',
      'numeric', 'real', 'serial', 'smallint', 'smallserial', 'text',
      'time', 'timestamp', 'timestamptz', 'uuid', 'varchar'
    ];
    const typeOptions = pgTypes.map(t => `<option value="${t}">${t}</option>`).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Table Designer</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-editor-font-family, 'Segoe UI', sans-serif);
      font-size: 13px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
    }
    .header {
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-tabs {
      display: flex;
      gap: 2px;
      margin-left: 20px;
    }
    .tab-btn {
      padding: 6px 16px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid transparent;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      opacity: 0.7;
    }
    .tab-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .tab-btn.active {
      opacity: 1;
      border-bottom-color: var(--vscode-panelTitle-activeBorder);
      color: var(--vscode-panelTitle-activeForeground);
      background: var(--vscode-editor-background);
    }
    .tab-content { display: none; padding: 0; height: 100%; overflow: hidden; }
    .tab-content.active { display: block; }
    .header h1 {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
      color: var(--vscode-editor-foreground);
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .main {
      display: flex;
      height: calc(100vh - 57px);
    }
    .left-pane {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      border-right: 1px solid var(--vscode-panel-border);
    }
    .right-pane {
      width: 380px;
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
    }
    .right-pane-header {
      padding: 10px 16px;
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .sql-preview {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    .sql-preview pre {
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 4px;
      min-height: 100px;
    }
    .right-pane-actions {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0 0 8px 0;
    }
    .table-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 20px;
    }
    .field-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field-group label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
    }
    input[type="text"], select, textarea {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      width: 100%;
    }
    input[type="text"]:focus, select:focus, textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    textarea { resize: vertical; min-height: 40px; }
    .columns-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 12px;
    }
    .columns-table th {
      text-align: left;
      padding: 6px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      background: var(--vscode-sideBar-background);
      border-bottom: 2px solid var(--vscode-panel-border);
      white-space: nowrap;
    }
    .columns-table td {
      padding: 4px 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
      vertical-align: middle;
    }
    .columns-table tr:hover td {
      background: var(--vscode-list-hoverBackground);
    }
    .columns-table tr.deleted td {
      opacity: 0.4;
      text-decoration: line-through;
    }
    .columns-table tr.new-row td {
      background: rgba(46, 204, 113, 0.05);
    }
    .col-input {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-editor-foreground);
      padding: 3px 6px;
      font-size: 12px;
      font-family: inherit;
      border-radius: 3px;
      width: 100%;
    }
    .col-input:focus {
      background: var(--vscode-input-background);
      border-color: var(--vscode-focusBorder);
      outline: none;
    }
    .col-select {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-editor-foreground);
      padding: 3px 4px;
      font-size: 12px;
      font-family: inherit;
      border-radius: 3px;
      width: 100%;
    }
    .col-select:focus {
      background: var(--vscode-input-background);
      border-color: var(--vscode-focusBorder);
      outline: none;
    }
    .col-checkbox {
      width: 14px;
      height: 14px;
      cursor: pointer;
    }
    .drag-handle {
      cursor: grab;
      color: var(--vscode-descriptionForeground);
      padding: 0 4px;
      font-size: 14px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border: none;
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-danger {
      background: transparent;
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-errorForeground);
      padding: 3px 6px;
      font-size: 11px;
    }
    .btn-add {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border: 1px dashed var(--vscode-textLink-foreground);
      padding: 5px 12px;
      width: 100%;
      justify-content: center;
      margin-bottom: 16px;
    }
    .pk-badge {
      font-size: 10px;
      color: var(--vscode-symbolIcon-keyForeground, #e5c07b);
    }
    .info-box {
      font-size: 11px;
      background: rgba(52,152,219,0.1);
      border-left: 3px solid #3498db;
      padding: 6px 10px;
      margin-bottom: 16px;
      border-radius: 3px;
      color: var(--vscode-editor-foreground);
    }
    .no-changes {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 8px;
    }
    .modal-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 100;
      display: flex; align-items: center; justify-content: center;
    }
    .modal {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 20px;
      width: 400px;
      border-radius: 5px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .checkbox-list label { display: block; margin-bottom: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎨 Table Designer</h1>
    <span class="badge">${isCreate ? 'CREATE MODE' : 'EDIT MODE'}</span>
    <span style="color:var(--vscode-descriptionForeground);font-size:12px;">${isCreate ? schema : `${schema}.${tableName}`}</span>
    <div class="header-tabs">
      <button class="tab-btn active" onclick="switchTab('columns')">Columns</button>
      <button class="tab-btn" onclick="switchTab('constraints')">Constraints</button>
      <button class="tab-btn" onclick="switchTab('indexes')">Indexes</button>
    </div>
  </div>

  <div class="main">
    <div class="left-pane">
      <div id="tab-columns" class="tab-content active">
      ${isCreate ? `
      <p class="section-title">Table Properties</p>
      <div class="table-meta">
        <div class="field-group">
          <label>Table Name *</label>
          <input type="text" id="tableName" placeholder="e.g. users" oninput="updateSQL()">
        </div>
        <div class="field-group">
          <label>Schema</label>
          <input type="text" id="schemaName" value="${schema}" readonly style="opacity:0.6;">
        </div>
        <div class="field-group" style="grid-column:1/-1;">
          <label>Comment</label>
          <textarea id="tableComment" rows="2" placeholder="Optional table description..." oninput="updateSQL()"></textarea>
        </div>
      </div>
      ` : `
      <div class="info-box">
        ℹ️ <strong>Edit mode:</strong> Modify columns below. Changes generate safe ALTER TABLE statements for review before execution.
      </div>
      `}

      <p class="section-title">Columns</p>
      <table class="columns-table" id="columnsTable">
        <thead>
          <tr>
            ${isCreate ? '<th style="width:28px;" title="Create mode: drag rows to set column order in CREATE TABLE"></th>' : ''}
            <th style="width:160px;">Column Name</th>
            <th style="width:150px;">Data Type</th>
            <th style="width:70px;">Not Null</th>
            <th style="width:130px;">Default</th>
            <th style="width:40px;">PK</th>
            <th style="width:40px;">UQ</th>
            <th style="width:130px;">Comment</th>
            <th style="width:50px;"></th>
          </tr>
        </thead>
        <tbody id="columnRows">
        </tbody>
      </table>

      <button class="btn btn-add" onclick="addColumn()">+ Add Column</button>
      </div>

      <div id="tab-constraints" class="tab-content">
        <p class="section-title">Constraints</p>
        <div class="info-box">Manage Foreign Keys, Check constraints, etc. PK/Unique on single columns are managed in the Columns tab.</div>
        <table class="columns-table">
          <thead>
            <tr>
              <th style="width:150px;">Name</th>
              <th style="width:100px;">Type</th>
              <th>Definition</th>
              <th style="width:50px;"></th>
            </tr>
          </thead>
          <tbody id="constraintRows"></tbody>
        </table>
        <div class="btn-group" style="display:flex;gap:5px;">
          <button class="btn btn-add" onclick="openAddConstraintModal('check')">+ Check</button>
          <button class="btn btn-add" onclick="openAddConstraintModal('unique')">+ Unique</button>
          <button class="btn btn-add" onclick="openAddConstraintModal('fk')">+ Foreign Key</button>
        </div>
      </div>

      <div id="tab-indexes" class="tab-content">
        <p class="section-title">Indexes</p>
        <table class="columns-table">
          <thead>
            <tr>
              <th style="width:150px;">Name</th>
              <th>Definition</th>
              <th style="width:60px;">Unique</th>
              <th style="width:60px;">Primary</th>
              <th style="width:50px;"></th>
            </tr>
          </thead>
          <tbody id="indexRows"></tbody>
        </table>
        <button class="btn btn-add" onclick="openAddIndexModal()">+ Add Index</button>
      </div>
    </div>
    
    <!-- Modals -->
    <div id="modal-overlay" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3 id="modal-title">Add Index</h3>
        <div class="field-group">
          <label>Index Name</label>
          <input type="text" id="idxName" placeholder="idx_name">
        </div>
        <div class="field-group">
          <label>Access Method</label>
          <select id="idxMethod">
            <option value="btree">btree</option>
            <option value="hash">hash</option>
            <option value="gist">gist</option>
            <option value="gin">gin</option>
            <option value="brin">brin</option>
          </select>
        </div>
        <div class="field-group">
          <label>Columns</label>
          <div id="idxColumns" class="checkbox-list" style="max-height:150px;overflow-y:auto;border:1px solid var(--vscode-input-border);padding:5px;"></div>
        </div>
        <div class="field-group">
          <label style="display:flex;gap:5px;align-items:center;cursor:pointer;">
            <input type="checkbox" id="idxUnique"> Unique Index
          </label>
        </div>
        <div class="modal-actions" style="margin-top:15px;display:flex;justify-content:flex-end;gap:10px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveIndex()">Save</button>
        </div>
      </div>
    </div>
    
    <div id="modal-constraint-overlay" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3 id="con-modal-title">Add Constraint</h3>
        
        <!-- Common -->
        <div class="field-group">
          <label>Constraint Name (Optional)</label>
          <input type="text" id="conName" placeholder="auto-generated">
        </div>

        <!-- Check (hidden by default) -->
        <div id="form-check" style="display:none;">
          <div class="field-group">
            <label>Check Expression</label>
            <textarea id="conCheckExpr" placeholder="e.g. age > 18"></textarea>
          </div>
        </div>

        <!-- Unique (hidden by default) -->
        <div id="form-unique" style="display:none;">
          <div class="field-group">
            <label>Columns</label>
            <div id="conUniqueCols" class="checkbox-list" style="max-height:150px;overflow-y:auto;border:1px solid var(--vscode-input-border);padding:5px;"></div>
          </div>
        </div>

        <!-- FK (hidden by default) -->
        <div id="form-fk" style="display:none;">
          <div class="field-group">
            <label>Local Column</label>
             <!-- Simplified to single column FK for now, or multi? Let's do single for simplicity first, or multi-select -->
            <div id="conFkLocalCols" class="checkbox-list" style="max-height:100px;overflow-y:auto;border:1px solid var(--vscode-input-border);padding:5px;"></div>
          </div>
          <div class="field-group">
            <label>Target Table (schema.table)</label>
            <input type="text" id="conFkTargetTable" placeholder="public.users">
          </div>
          <div class="field-group">
            <label>Target Column(s) (comma separated)</label>
            <input type="text" id="conFkTargetCols" placeholder="id">
          </div>
        </div>

        <div class="modal-actions" style="margin-top:15px;display:flex;justify-content:flex-end;gap:10px;">
          <button class="btn btn-secondary" onclick="closeConstraintModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveConstraint()">Save</button>
        </div>
      </div>
    </div>

    <div class="right-pane">
      <div class="right-pane-header">📋 SQL Preview</div>
      <div class="sql-preview">
        <pre id="sqlPreview"><span style="color:var(--vscode-descriptionForeground);font-style:italic;">Make changes to see SQL preview...</span></pre>
      </div>
      <div class="right-pane-actions">
        <button class="btn btn-primary" onclick="applyChanges()" style="flex:1;">
          ▶ Open in Notebook
        </button>
        <button class="btn btn-secondary" onclick="copySQL()">
          📋 Copy
        </button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    
    // Debug logging
    window.onerror = function(message, source, lineno, colno, error) {
      console.error('TableDesigner Script Error:', message, 'at', source, ':', lineno, ':', colno, error);
      const errDiv = document.createElement('div');
      errDiv.style.color = 'red';
      errDiv.style.padding = '10px';
      errDiv.innerText = 'Script Error: ' + message;
      document.body.prepend(errDiv);
    };

    console.log('TableDesigner: Initializing...');

    const MODE = '${mode}';
    const ALLOW_COL_REORDER = (MODE === 'create');
    let columnDragSourceIndex = null;
    const SCHEMA = '${schema}';
    const TABLE_NAME = '${tableName}';
    const PG_TYPES = ${JSON.stringify(pgTypes)};

    console.log('PG_TYPES:', PG_TYPES);
    console.log('Columns Data:', ${columnsJson});

    let columns = ${columnsJson};
    let constraints = ${constraintsJson};
    let indexes = ${indexesJson};
    let nextId = columns.length + 1;

    // Initialize
    try {
      renderColumns();
      renderConstraints();
      renderIndexes();
      updateSQL();
    } catch (e) {
      console.error('Initialization Error:', e);
      document.body.innerHTML += '<div style="color:red;padding:20px;">Initialization Failed: ' + e.message + '</div>';
    }

    function switchTab(tabName) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      
      document.getElementById('tab-' + tabName).classList.add('active');
      // Find button with onclick="switchTab('tabName')" - simplified selector
      const btns = document.querySelectorAll('.tab-btn');
      if (tabName === 'columns') btns[0].classList.add('active');
      if (tabName === 'constraints') btns[1].classList.add('active');
      if (tabName === 'indexes') btns[2].classList.add('active');
    }

    function columnDragStart(e) {
      if (!ALLOW_COL_REORDER) return;
      const h = e.target.closest('.drag-handle');
      if (!h) return;
      e.stopPropagation();
      const idx = parseInt(h.getAttribute('data-col-idx'), 10);
      if (Number.isNaN(idx)) return;
      columnDragSourceIndex = idx;
      e.dataTransfer.setData('text/plain', String(idx));
      e.dataTransfer.effectAllowed = 'move';
    }

    function columnDragOver(e) {
      if (!ALLOW_COL_REORDER) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }

    function columnDrop(e, toIdx) {
      if (!ALLOW_COL_REORDER) return;
      e.preventDefault();
      const from = columnDragSourceIndex;
      if (from === null || from === undefined) return;
      if (columns[from]._deleted || columns[toIdx]._deleted) return;
      if (from === toIdx) return;
      const [moved] = columns.splice(from, 1);
      let dest = toIdx;
      if (from < toIdx) dest = toIdx - 1;
      columns.splice(dest, 0, moved);
      columnDragSourceIndex = null;
      renderColumns();
      updateSQL();
    }

    function columnDragEnd() {
      columnDragSourceIndex = null;
    }

    function renderColumns() {
      const tbody = document.getElementById('columnRows');
      tbody.innerHTML = '';
      columns.forEach((col, idx) => {
        if (col._deleted) {
          const tr = document.createElement('tr');
          tr.className = 'deleted';
          if (ALLOW_COL_REORDER) {
            tr.innerHTML = \`
            <td></td>
            <td colspan="7" style="padding:4px 8px;font-size:12px;">\${col.column_name} <em style="font-size:11px;">(will be dropped)</em></td>
            <td><button class="btn btn-secondary" style="padding:2px 6px;font-size:11px;" onclick="restoreColumn(\${idx})">Restore</button></td>
          \`;
          } else {
            tr.innerHTML = \`
            <td colspan="8" style="padding:4px 8px;font-size:12px;">\${col.column_name} <em style="font-size:11px;">(will be dropped)</em></td>
            <td><button class="btn btn-secondary" style="padding:2px 6px;font-size:11px;" onclick="restoreColumn(\${idx})">Restore</button></td>
          \`;
          }
          tbody.appendChild(tr);
          return;
        }

        const typeOptions = PG_TYPES.map(t =>
          \`<option value="\${t}" \${col.data_type === t ? 'selected' : ''}>\${t}</option>\`
        ).join('');

        const tr = document.createElement('tr');
        tr.className = col._new ? 'new-row' : '';
        const dragCell = ALLOW_COL_REORDER
          ? \`<td><span class="drag-handle" draggable="true" data-col-idx="\${idx}" ondragstart="columnDragStart(event)" ondragend="columnDragEnd(event)" title="Drag to reorder">⠿</span></td>\`
          : '';
        tr.innerHTML = dragCell + \`
          <td>
            <input class="col-input" type="text" value="\${col.column_name || ''}"
              onchange="updateCol(\${idx}, 'column_name', this.value)"
              oninput="updateSQL()" placeholder="column_name">
          </td>
          <td>
            <select class="col-select" onchange="updateCol(\${idx}, 'data_type', this.value)">
              \${typeOptions}
              <option value="\${col.data_type}" \${!PG_TYPES.includes(col.data_type) ? 'selected' : ''}>\${col.data_type}</option>
            </select>
          </td>
          <td style="text-align:center;">
            <input class="col-checkbox" type="checkbox" \${col.not_null ? 'checked' : ''}
              onchange="updateCol(\${idx}, 'not_null', this.checked)">
          </td>
          <td>
            <input class="col-input" type="text" value="\${col.default_value || ''}"
              onchange="updateCol(\${idx}, 'default_value', this.value || null)"
              oninput="updateSQL()" placeholder="NULL">
          </td>
          <td style="text-align:center;">
            <input class="col-checkbox" type="checkbox" \${col.is_primary_key ? 'checked' : ''}
              onchange="updateCol(\${idx}, 'is_primary_key', this.checked)">
          </td>
          <td style="text-align:center;">
            <input class="col-checkbox" type="checkbox" \${col.is_unique ? 'checked' : ''}
              onchange="updateCol(\${idx}, 'is_unique', this.checked)">
          </td>
          <td>
            <input class="col-input" type="text" value="\${(col.comment || '').replace(/"/g, '&quot;')}"
              onchange="updateCol(\${idx}, 'comment', this.value)"
              oninput="updateSQL()" placeholder="Optional...">
          </td>
          <td>
            <button class="btn btn-danger" onclick="deleteColumn(\${idx})">✕</button>
          </td>
        \`;
        if (ALLOW_COL_REORDER) {
          tr.ondragover = columnDragOver;
          tr.ondrop = function(ev) { columnDrop(ev, idx); };
        }
        tbody.appendChild(tr);
      });
    }

    let currentConstraintType = '';

    function renderConstraints() {
      const tbody = document.getElementById('constraintRows');
      tbody.innerHTML = '';
      if (constraints.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="no-changes">No additional constraints defined.</td></tr>';
        return;
      }
      constraints.forEach((con, idx) => {
        if (con._deleted) {
          const tr = document.createElement('tr');
          tr.className = 'deleted';
          tr.innerHTML = \`
            <td colspan="3" style="padding:4px 8px;font-size:12px;">\${con.name} <em style="font-size:11px;">(will be dropped)</em></td>
            <td style="text-align:center;"><button class="btn btn-secondary" style="padding:2px 6px;font-size:11px;" onclick="restoreConstraint(\${idx})">Restore</button></td>
          \`;
          tbody.appendChild(tr);
          return;
        }

        let defDisplay = con.definition;
        if (con._new) {
           defDisplay = \`<span class="badge">NEW</span> \${con.description}\`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${con.name}</td>
          <td><span class="badge">\${con.type}</span></td>
          <td style="font-family:monospace;font-size:11px;">\${defDisplay}</td>
          <td style="text-align:center;">
             \${!con._new ? \`<button class="btn btn-secondary copy-btn" data-def="\${(con.definition || '').replace(/"/g, '&quot;')}" title="Copy Definition">📋</button>\` : ''}
             <button class="btn btn-danger" onclick="deleteConstraint(\${idx})">✕</button>
          </td>
        \`;
        tbody.appendChild(tr);
      });
      // Attach copy handlers
      document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.onclick = (e) => {
          copyText(e.target.getAttribute('data-def'));
        };
      });
    }

    function renderIndexes() {
      const tbody = document.getElementById('indexRows');
      tbody.innerHTML = '';
      if (indexes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="no-changes">No indexes defined.</td></tr>';
        return;
      }
      indexes.forEach((idx, i) => {
        if (idx._deleted) {
          const tr = document.createElement('tr');
          tr.className = 'deleted';
          tr.innerHTML = \`
            <td colspan="4" style="padding:4px 8px;font-size:12px;">\${idx.name} <em style="font-size:11px;">(will be dropped)</em></td>
            <td style="text-align:center;"><button class="btn btn-secondary" style="padding:2px 6px;font-size:11px;" onclick="restoreIndex(\${i})">Restore</button></td>
          \`;
          tbody.appendChild(tr);
          return;
        }

        let defDisplay = idx.definition;
        if (idx._new) {
           defDisplay = \`<span class="badge">NEW</span> \${idx.method} (\${idx.columns.join(', ')})\`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${idx.name}</td>
          <td style="font-family:monospace;font-size:11px;">\${defDisplay}</td>
          <td style="text-align:center;">\${idx.is_unique ? '✅' : ''}</td>
          <td style="text-align:center;">\${idx.is_primary ? '🔑' : ''}</td>
          <td style="text-align:center;">
             \${!idx._new ? \`<button class="btn btn-secondary copy-btn" data-def="\${(idx.definition || '').replace(/"/g, '&quot;')}" title="Copy Definition">📋</button>\` : ''}
             <button class="btn btn-danger" onclick="deleteIndex(\${i})">✕</button>
          </td>
        \`;
        tbody.appendChild(tr);
      });
       // Attach copy handlers again for indexes
       document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.onclick = (e) => {
          copyText(e.target.getAttribute('data-def'));
        };
      });
    }

    function openAddIndexModal() {
      const overlay = document.getElementById('modal-overlay');
      const colDiv = document.getElementById('idxColumns');
      colDiv.innerHTML = '';
      
      // Populate columns
      const activeCols = columns.filter(c => !c._deleted);
      activeCols.forEach(c => {
        const lbl = document.createElement('label');
        lbl.innerHTML = \`<input type="checkbox" value="\${c.column_name}"> \${c.column_name}\`;
        colDiv.appendChild(lbl);
      });

      // Auto-name
      document.getElementById('idxName').value = \`\${TABLE_NAME}_idx\`;
      document.getElementById('idxMethod').value = 'btree';
      document.getElementById('idxUnique').checked = false;
      
      overlay.style.display = 'flex';
      document.getElementById('idxName').focus();
    }

    function closeModal() {
      document.getElementById('modal-overlay').style.display = 'none';
    }

    function saveIndex() {
      const name = document.getElementById('idxName').value.trim();
      const method = document.getElementById('idxMethod').value;
      const isUnique = document.getElementById('idxUnique').checked;
      
      const selectedCols = Array.from(document.querySelectorAll('#idxColumns input:checked')).map(cb => cb.value);
      
      if (!name) { alert('Index Name is required'); return; }
      if (selectedCols.length === 0) { alert('Select at least one column'); return; }

      // Check name uniqueness locally
      if (indexes.find(i => i.name === name && !i._deleted)) {
        alert('Index name already exists');
        return;
      }

      indexes.push({
        name,
        method,
        columns: selectedCols,
        is_unique: isUnique,
        is_primary: false,
        definition: '', // Generated on server
        _new: true
      });
      
      closeModal();
      renderIndexes();
      updateSQL();
    }
    
    function openAddConstraintModal(type) {
      currentConstraintType = type;
      const overlay = document.getElementById('modal-constraint-overlay');
      
      // Reset forms
      document.getElementById('conName').value = '';
      document.getElementById('form-check').style.display = 'none';
      document.getElementById('form-unique').style.display = 'none';
      document.getElementById('form-fk').style.display = 'none';

      const activeCols = columns.filter(c => !c._deleted);

      if (type === 'check') {
        document.getElementById('con-modal-title').innerText = 'Add Check Constraint';
        document.getElementById('form-check').style.display = 'block';
        document.getElementById('conCheckExpr').value = '';
        document.getElementById('conCheckExpr').focus();
      } else if (type === 'unique') {
        document.getElementById('con-modal-title').innerText = 'Add Unique Constraint';
        document.getElementById('form-unique').style.display = 'block';
        const colDiv = document.getElementById('conUniqueCols');
        colDiv.innerHTML = '';
        activeCols.forEach(c => {
          const lbl = document.createElement('label');
          lbl.innerHTML = \`<input type="checkbox" value="\${c.column_name}"> \${c.column_name}\`;
          colDiv.appendChild(lbl);
        });
      } else if (type === 'fk') {
        document.getElementById('con-modal-title').innerText = 'Add Foreign Key';
        document.getElementById('form-fk').style.display = 'block';
        const colDiv = document.getElementById('conFkLocalCols');
        colDiv.innerHTML = '';
        activeCols.forEach(c => {
          const lbl = document.createElement('label');
          lbl.innerHTML = \`<input type="checkbox" value="\${c.column_name}"> \${c.column_name}\`;
          colDiv.appendChild(lbl);
        });
        document.getElementById('conFkTargetTable').value = '';
        document.getElementById('conFkTargetCols').value = '';
      }

      overlay.style.display = 'flex';
    }

    function closeConstraintModal() {
      document.getElementById('modal-constraint-overlay').style.display = 'none';
    }

    function saveConstraint() {
      const name = document.getElementById('conName').value.trim(); // Optional, can be auto-generated
      let def = '';
      let desc = '';
      let typeLabel = '';
      let constraintTypeKey = ''; // for backend

      if (currentConstraintType === 'check') {
        const expr = document.getElementById('conCheckExpr').value.trim();
        if (!expr) { alert('Check expression required'); return; }
        def = \`CHECK (\${expr})\`;
        desc = expr;
        typeLabel = 'CHECK';
        constraintTypeKey = 'c';
      } else if (currentConstraintType === 'unique') {
        const selectedCols = Array.from(document.querySelectorAll('#conUniqueCols input:checked')).map(cb => cb.value);
        if (selectedCols.length === 0) { alert('Select at least one column'); return; }
        const cols = selectedCols.map(c => '"' + c + '"').join(', ');
        def = \`UNIQUE (\${cols})\`;
        desc = \`(\${selectedCols.join(', ')})\`;
        typeLabel = 'UNIQUE';
        constraintTypeKey = 'u';
      } else if (currentConstraintType === 'fk') {
        const selectedCols = Array.from(document.querySelectorAll('#conFkLocalCols input:checked')).map(cb => cb.value);
        const targetTable = document.getElementById('conFkTargetTable').value.trim();
        const targetCols = document.getElementById('conFkTargetCols').value.trim();
        
        if (selectedCols.length === 0) { alert('Select local column(s)'); return; }
        if (!targetTable) { alert('Target table required'); return; }
        if (!targetCols) { alert('Target column(s) required'); return; }

        const cols = selectedCols.map(c => '"' + c + '"').join(', ');
        def = \`FOREIGN KEY (\${cols}) REFERENCES \${targetTable} (\${targetCols})\`;
        desc = \`(\${selectedCols.join(', ')}) -> \${targetTable}(\${targetCols})\`;
        typeLabel = 'FOREIGN KEY';
        constraintTypeKey = 'f';
      }

      // Generate name if empty
      const finalName = name || \`\${TABLE_NAME}_\${currentConstraintType}_\${Date.now()}\`;

      constraints.push({
        name: finalName,
        type: typeLabel,
        definition: '', // Generated on server
        description: desc, // For display
        rawDef: def,      // For SQL generation
        _new: true
      });

      closeConstraintModal();
      renderConstraints();
      updateSQL();
      renderConstraints();
      updateSQL();
    }
    
    function deleteConstraint(idx) {
      constraints[idx]._deleted = true;
      renderConstraints();
      updateSQL();
    }
    function restoreConstraint(idx) {
      delete constraints[idx]._deleted;
      renderConstraints();
      updateSQL();
    }
    
    function deleteIndex(idx) {
      indexes[idx]._deleted = true;
      renderIndexes();
      updateSQL();
    }
    function restoreIndex(idx) {
      delete indexes[idx]._deleted;
      renderIndexes();
      updateSQL();
    }
    
    function copyText(text) {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }

    function updateCol(idx, field, value) {
      columns[idx][field] = value;
      updateSQL();
    }

    function addColumn() {
      columns.push({
        ordinal: nextId++,
        column_name: '',
        data_type: 'text',
        not_null: false,
        default_value: null,
        is_primary_key: false,
        is_unique: false,
        comment: '',
        _new: true
      });
      renderColumns();
      updateSQL();
      // Focus the new column name input
      const inputs = document.querySelectorAll('.col-input');
      if (inputs.length > 0) {
        inputs[inputs.length - 9]?.focus();
      }
    }

    function deleteColumn(idx) {
      if (columns[idx]._new) {
        columns.splice(idx, 1);
      } else {
        columns[idx]._deleted = true;
      }
      renderColumns();
      updateSQL();
    }

    function restoreColumn(idx) {
      delete columns[idx]._deleted;
      renderColumns();
      updateSQL();
    }

    function generateSQL() {
      if (MODE === 'create') {
        return generateCreateSQL();
      } else {
        return generateAlterSQL();
      }
    }

    function generateCreateSQL() {
      const tblName = document.getElementById('tableName')?.value?.trim() || '<table_name>';
      const comment = document.getElementById('tableComment')?.value?.trim() || '';
      const activeCols = columns.filter(c => !c._deleted);
      const activeConstraints = constraints.filter(c => !c._deleted && c.name && c.rawDef);
      const activeIndexes = indexes.filter(i => !i._deleted && i.name && i.method && Array.isArray(i.columns) && i.columns.length > 0);

      if (activeCols.length === 0) {
        return '-- Add at least one column';
      }

      const pkCols = activeCols.filter(c => c.is_primary_key).map(c => '"' + c.column_name + '"');
      const colDefs = activeCols.map(c => {
        const nn = c.not_null ? ' NOT NULL' : '';
        const def = c.default_value ? ' DEFAULT ' + c.default_value : '';
        return '  "' + (c.column_name || 'column_name') + '" ' + c.data_type + nn + def;
      });

      if (pkCols.length > 0) {
        colDefs.push('  PRIMARY KEY (' + pkCols.join(', ') + ')');
      }

      let sql = 'CREATE TABLE "' + SCHEMA + '"."' + tblName + '" (\\n' + colDefs.join(',\\n') + '\\n);';

      for (const con of activeConstraints) {
        sql += '\\n\\nALTER TABLE "' + SCHEMA + '"."' + tblName + '"\\n  ADD CONSTRAINT "' + con.name + '" ' + con.rawDef + ';';
      }

      for (const idx of activeIndexes) {
        const unique = idx.is_unique ? 'UNIQUE ' : '';
        const cols = idx.columns.map(c => '"' + c + '"').join(', ');
        sql += '\\n\\nCREATE ' + unique + 'INDEX "' + idx.name + '" ON "' + SCHEMA + '"."' + tblName + '" USING ' + idx.method + ' (' + cols + ');';
      }

      if (comment) {
        sql += '\\n\\nCOMMENT ON TABLE "' + SCHEMA + '"."' + tblName + '" IS \\'' + comment.replace(/'/g, "''") + '\\';';
      }

      for (const c of activeCols) {
        if (c.comment) {
          sql += '\\nCOMMENT ON COLUMN "' + SCHEMA + '"."' + tblName + '"."' + c.column_name + '" IS \\'' + c.comment.replace(/'/g, "''") + '\\';';
        }
      }

      return sql;
    }

    function generateAlterSQL() {
      const originalCols = ${columnsJson};
      const origMap = {};
      originalCols.forEach(c => { origMap[c.column_name] = c; });

      const stmts = [];

      // 1. Drop Constraints
      for (const con of constraints) {
        if (con._deleted) {
          stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  DROP CONSTRAINT IF EXISTS "' + con.name + '";');
        } else if (con._new) {
          stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  ADD CONSTRAINT "' + con.name + '" ' + con.rawDef + ';');
        }
      }

      // 2. Drop Indexes
      for (const idx of indexes) {
        if (idx._deleted) {
          stmts.push('DROP INDEX IF EXISTS "' + SCHEMA + '"."' + idx.name + '";');
        } else if (idx._new) {
          const unique = idx.is_unique ? 'UNIQUE ' : '';
          const cols = idx.columns.map(c => '"' + c + '"').join(', ');
          stmts.push('CREATE ' + unique + 'INDEX "' + idx.name + '" ON "' + SCHEMA + '"."' + TABLE_NAME + '" USING ' + idx.method + ' (' + cols + ');');
        }
      }

      // 3. Handle Columns
      for (const col of columns) {
        if (col._deleted) {
          stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  DROP COLUMN "' + col.column_name + '";');
          continue;
        }
        if (col._new) {
          const nn = col.not_null ? ' NOT NULL' : '';
          const def = col.default_value ? ' DEFAULT ' + col.default_value : '';
          stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  ADD COLUMN "' + (col.column_name || 'column_name') + '" ' + col.data_type + nn + def + ';');
          if (col.comment) {
            stmts.push('COMMENT ON COLUMN "' + SCHEMA + '"."' + TABLE_NAME + '"."' + col.column_name + '" IS \\'' + col.comment.replace(/'/g, "''") + '\\';');
          }
          continue;
        }

        const orig = origMap[col.column_name];
        if (!orig) continue;

        if (orig.data_type !== col.data_type) {
          stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  ALTER COLUMN "' + col.column_name + '" TYPE ' + col.data_type + ';');
        }
        if (orig.not_null !== col.not_null) {
          stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  ALTER COLUMN "' + col.column_name + '" ' + (col.not_null ? 'SET' : 'DROP') + ' NOT NULL;');
        }
        if ((orig.default_value || '') !== (col.default_value || '')) {
          if (col.default_value) {
            stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  ALTER COLUMN "' + col.column_name + '" SET DEFAULT ' + col.default_value + ';');
          } else {
            stmts.push('ALTER TABLE "' + SCHEMA + '"."' + TABLE_NAME + '"\\n  ALTER COLUMN "' + col.column_name + '" DROP DEFAULT;');
          }
        }
        if ((orig.comment || '') !== (col.comment || '')) {
          stmts.push('COMMENT ON COLUMN "' + SCHEMA + '"."' + TABLE_NAME + '"."' + col.column_name + '" IS \\'' + (col.comment || '').replace(/'/g, "''") + '\\';');
        }
      }

      if (stmts.length === 0) {
        return '-- No changes detected';
      }

      return '-- Generated by NexQL Table Designer\\n-- Wrap in BEGIN/COMMIT for safety\\n\\n' + stmts.join('\\n\\n');
    }

    function updateSQL() {
      const sql = generateSQL();
      const pre = document.getElementById('sqlPreview');
      pre.textContent = sql;
    }

    function applyChanges() {
      const sql = generateSQL();
      if (sql === '-- No changes detected' || sql === '-- Add at least one column') {
        return;
      }

      if (MODE === 'create') {
        const tblName = document.getElementById('tableName')?.value?.trim();
        const comment = document.getElementById('tableComment')?.value?.trim() || '';
        vscode.postMessage({
          type: 'applyChanges',
          tableName: tblName,
          modified: columns.filter(c => !c._deleted),
          constraints: constraints,
          indexes: indexes,
          tableComment: comment
        });
      } else {
        const originalCols = ${columnsJson};
        vscode.postMessage({
          type: 'applyChanges',
          original: originalCols,
          modified: columns,
          constraints: constraints, // Pass current constraints state (read-only for now)
          indexes: indexes          // Pass current indexes state (read-only for now)
        });
      }
    }

    function copySQL() {
      const sql = generateSQL();
      vscode.postMessage({ type: 'copySQL', sql });
    }
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
}
