import * as vscode from 'vscode';

import { DatabaseTreeItem, DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { CommandBase } from '../common/commands/CommandBase';
import {
  MarkdownUtils,
  ErrorHandlers,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder
} from './helper';
import { ViewSQL } from './sql';

/**
 * cmdScriptSelect - Single-operation notebook: SELECT from view
 */
export async function cmdScriptSelect(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create SELECT script', async (conn: any, client: any, metadata: any) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(`### 📖 SELECT Script: \`${item.schema}.${item.label}\`\n\nQuery data from the view.`)
      .addSql(ViewSQL.select(item.schema!, item.label))
      .show();
  });
}

/**
 * cmdScriptCreate - Delegates to cmdEditView to fetch the actual view definition
 */
export async function cmdScriptCreate(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await cmdEditView(item, context);
}

/**
 * cmdEditView - Fetches the actual view definition from the DB and opens it for editing.
 * Kept as-is: it queries the live definition, not a template.
 */
export async function cmdEditView(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create view edit notebook', async (conn: any, client: any, metadata: any) => {
    const viewResult = await client.query(QueryBuilder.viewDefinition(item.schema!, item.label));
    if (!viewResult.rows[0]?.definition) {
      throw new Error('View definition not found');
    }

    const createViewStatement = `CREATE OR REPLACE VIEW ${item.schema}.${item.label} AS\n${viewResult.rows[0].definition} `;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ✏️ Edit View: \`${item.schema}.${item.label}\`\n\nModify the view definition below and execute to update.`)
      .addMarkdown('##### 📝 View Definition')
      .addSql(createViewStatement)
      .show();
  });
}

/**
 * cmdViewData - Single-operation notebook: SELECT from view
 */
export async function cmdViewData(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create view data notebook', async (conn: any, client: any, metadata: any) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(`### 📖 View Data: \`${item.schema}.${item.label}\`\n\nQuery data from the view.`)
      .addSql(ViewSQL.select(item.schema!, item.label))
      .show();
  });
}

/**
 * cmdDropView - Single-operation notebook: DROP view
 */
export async function cmdDropView(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create drop view notebook', async (conn: any, client: any, metadata: any) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(`### ❌ Drop View: \`${item.schema}.${item.label}\`\n\n⚠️ **Warning:** This permanently deletes the view and cannot be undone.`)
      .addSql(ViewSQL.drop(item.schema!, item.label))
      .show();
  });
}

/**
 * cmdViewOperations - Operations_Notebook for a view.
 * Cell order: read (SELECT, definition) → write/modify (CREATE OR REPLACE) → destructive (DROP)
 */
export async function cmdViewOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create view operations notebook', async (conn: any, client: any, metadata: any) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(`### 👁️ View Operations: \`${item.schema}.${item.label}\`\n\nCommon operations for this PostgreSQL view.`)
      .addMarkdown('##### 📖 SELECT')
      .addSql(ViewSQL.select(item.schema!, item.label))
      .addMarkdown('##### 📝 Definition')
      .addSql(ViewSQL.definition(item.schema!, item.label))
      .addMarkdown('##### ✏️ CREATE OR REPLACE')
      .addSql(ViewSQL.createOrReplace(item.schema!, item.label))
      .addMarkdown('##### ❌ DROP — ⚠️ Warning: permanently deletes the view')
      .addSql(ViewSQL.drop(item.schema!, item.label))
      .show();
  });
}

/**
 * cmdShowViewProperties - Properties panel for a view. Kept as-is.
 */
export async function cmdShowViewProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'view properties', async (conn: any, client: any, metadata: any) => {
    const [viewInfo, columnInfo, dependenciesInfo, referencedInfo, sizeInfo] = await Promise.all([
      client.query(QueryBuilder.viewInfo(item.schema!, item.label)),
      client.query(QueryBuilder.tableColumns(item.schema!, item.label)),
      client.query(QueryBuilder.objectDependencies(item.schema!, item.label)),
      client.query(QueryBuilder.objectReferences(item.schema!, item.label)),
      client.query(QueryBuilder.viewSize(item.schema!, item.label))
    ]);

    const view = viewInfo.rows[0];
    const columns = columnInfo.rows;
    const dependents = dependenciesInfo.rows;
    const references = referencedInfo.rows;
    const sizes = sizeInfo.rows[0];

    const viewDefResult = await client.query(`SELECT pg_get_viewdef($1::regclass, true) as definition`, [`${item.schema}.${item.label}`]);
    const viewDefinition = viewDefResult.rows[0]?.definition || '';

    const columnRows = columns.map((col: any) => {
      const dataType = col.character_maximum_length
        ? `${col.data_type}(${col.character_maximum_length})`
        : col.numeric_precision
          ? `${col.data_type}(${col.numeric_precision}${col.numeric_scale ? ',' + col.numeric_scale : ''})`
          : col.data_type;
      return `    <tr>
        <td>${col.ordinal_position}</td>
        <td><strong>${col.column_name}</strong></td>
        <td><code>${dataType}</code></td>
        <td>${col.is_nullable === 'YES' ? 'YES' : 'NO'}</td>
        <td>${col.column_default ? `<code>${col.column_default}</code>` : '—'}</td>
        <td>${col.description || '—'}</td>
    </tr>`;
    }).join('\n');

    const dependencyRows = dependents.map((dep: any) =>
      `    <tr><td>${dep.kind}</td><td><code>${dep.schema}.${dep.name}</code></td></tr>`
    ).join('\n');

    const referenceRows = references.map((ref: any) =>
      `    <tr><td>${ref.kind}</td><td><code>${ref.schema}.${ref.name}</code></td></tr>`
    ).join('\n');

    const createViewScript = `-- DROP VIEW IF EXISTS ${item.schema}.${item.label};

CREATE OR REPLACE VIEW ${item.schema}.${item.label} AS
${viewDefinition};

${view.comment ? `COMMENT ON VIEW ${item.schema}.${item.label} IS '${view.comment.replace(/'/g, "''")}';` : `-- COMMENT ON VIEW ${item.schema}.${item.label} IS 'view description';`}`;

    const ownerInfo = view.owner + (view.comment ? ` | <strong>Comment:</strong> ${view.comment}` : '');
    const markdown = MarkdownUtils.header(`👁️ View Properties: \`${item.schema}.${item.label}\``) +
      MarkdownUtils.infoBox(`<strong>Owner:</strong> ${ownerInfo}`) +
      `\n\n#### 📊 General Information\n\n` +
      MarkdownUtils.propertiesTable({
        'Schema': view.schema_name,
        'View Name': view.view_name,
        'Owner': view.owner,
        'Size': sizes.view_size,
        'Row Estimate': view.row_estimate?.toLocaleString() || 'N/A',
        'Column Count': `${columns.length}`
      }) +
      `\n\n#### 📋 Columns (${columns.length})\n\n` +
      `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 5%;">#</th>
        <th style="text-align: left; width: 20%;">Name</th>
        <th style="text-align: left; width: 20%;">Data Type</th>
        <th style="text-align: left; width: 10%;">Nullable</th>
        <th style="text-align: left; width: 20%;">Default</th>
        <th style="text-align: left;">Description</th>
    </tr>
${columnRows}
</table>

` +
      (references.length > 0 ? `#### 🔗 Referenced Objects (${references.length})

${MarkdownUtils.infoBox('Objects that this view depends on (base tables and views):', 'Info')}

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 20%;">Type</th>
        <th style="text-align: left;">Object</th>
    </tr>
${referenceRows}
</table>

` : '') +
      (dependents.length > 0 ? `#### 🔄 Dependent Objects (${dependents.length})

${MarkdownUtils.infoBox('Objects that depend on this view (other views that reference this one):', 'Info')}

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 20%;">Type</th>
        <th style="text-align: left;">Object</th>
    </tr>
${dependencyRows}
</table>

` : '');

    await new NotebookBuilder(metadata)
      .addMarkdown(markdown)
      .addMarkdown('##### 📝 CREATE VIEW Script')
      .addSql(createViewScript)
      .addMarkdown('##### ❌ DROP VIEW Script — ⚠️ Warning: permanently deletes the view')
      .addSql(ViewSQL.drop(item.schema!, item.label))
      .addMarkdown('##### 📖 Query View Data')
      .addSql(ViewSQL.select(item.schema!, item.label))
      .addMarkdown('##### 📊 View Definition Details')
      .addSql(ViewSQL.definition(item.schema!, item.label))
      .show();
  });
}

/**
 * cmdRefreshView - Refreshes the view item in the tree view.
 */
export async function cmdRefreshView(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider) {
  databaseTreeProvider?.refresh(item);
}

/**
 * cmdCreateView - Single-cell notebook with CREATE OR REPLACE VIEW template.
 */
export async function cmdCreateView(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create view notebook', async (conn: any, client: any, metadata: any) => {
    const schema = item.schema!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Create New View in Schema: \`${schema}\`\n\nCreate or replace a view using the template below.`)
      .addSql(ViewSQL.createOrReplace(schema, 'new_view'))
      .show();
  });
}
