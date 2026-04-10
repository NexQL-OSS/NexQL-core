import * as vscode from 'vscode';

import { DatabaseTreeItem, DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import {
  MarkdownUtils,
  ErrorHandlers,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder
} from './helper';
import { ForeignTableSQL } from './sql';



/**
 * cmdAllForeignTableOperations - Command to create a notebook with all foreign table operations
 * @param {DatabaseTreeItem} item - The selected foreign table item in the database tree.
 * @param {vscode.ExtensionContext} context - The extension context.
 */
export async function cmdForeignTableOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const result = await client.query(QueryBuilder.foreignTableInfo(item.schema!, item.label));
    if (result.rows.length === 0) {
      throw new Error('Foreign table not found');
    }

    const serverName = result.rows[0].server_name;
    const options = result.rows[0].options || [];
    const columnDefinitions = result.rows.map((row: any) =>
      `    ${row.column_name} ${row.data_type}${row.is_nullable === 'NO' ? ' NOT NULL' : ''}${row.column_default ? ' DEFAULT ' + row.column_default : ''}`
    ).join(',\n');

    const createTableStatement = `CREATE FOREIGN TABLE ${item.schema}.${item.label} (\n${columnDefinitions}\n) SERVER ${serverName}${options.length > 0 ? '\nOPTIONS (' + options.map((opt: any) => `${opt}`).join(', ') + ')' : ''};`;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🔗 Foreign Table Operations: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('This notebook contains operations for managing the PostgreSQL foreign table. Run the cells below to execute the operations.') +
        `\n\n#### 🎯 Available Operations\n\n` +
        MarkdownUtils.operationsTable([
          { operation: '<strong>View Definition</strong>', description: 'Show the CREATE FOREIGN TABLE statement' },
          { operation: '<strong>Query Data</strong>', description: 'Select the first 100 rows' },
          { operation: '<strong>Edit Table</strong>', description: 'Template for modifying the table (requires recreation)' },
          { operation: '<strong>Drop Table</strong>', description: 'Delete the table (Warning: Irreversible)' }
        ])
      )
      .addMarkdown('##### 📝 Table Definition')
      .addSql(`-- Current table definition\n${createTableStatement}`)
      .addMarkdown('##### 📖 Query Data')
      .addSql(ForeignTableSQL.queryData(item.schema!, item.label))
      .addMarkdown('##### ✏️ Edit Table')
      .addSql(ForeignTableSQL.edit(item.schema!, item.label))
      .addMarkdown('##### ❌ Drop Foreign Table')
      .addSql(ForeignTableSQL.drop(item.schema!, item.label))
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create foreign table operations notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdEditForeignTable - Command to create a notebook for editing a foreign table
 * @param {DatabaseTreeItem} item - The selected foreign table item in the database tree.
 * @param {vscode.ExtensionContext} context - The extension context.
 */
export async function cmdEditForeignTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const result = await client.query(QueryBuilder.foreignTableDefinition(item.schema!, item.label));
    if (result.rows.length === 0) {
      throw new Error('Foreign table not found');
    }

    const tableInfo = result.rows[0];
    const createStatement = `CREATE FOREIGN TABLE ${item.schema}.${item.label} (\n${tableInfo.columns.map((col: string) => '    ' + col).join(',\n')}\n) SERVER ${tableInfo.server_name}${tableInfo.options ? '\nOPTIONS (\n    ' + tableInfo.options.map((opt: string) => opt).join(',\n    ') + '\n)' : ''};`;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`✏️ Edit Foreign Table: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('Modify the foreign table definition below and execute the cells to update it.')
      )
      .addMarkdown('##### 📝 Table Definition')
      .addSql(`-- Drop existing foreign table\nDROP FOREIGN TABLE IF EXISTS ${item.schema}.${item.label};\n\n-- Create foreign table with new definition\n${createStatement}`)
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create foreign table edit notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdRefreshForeignTable - Refreshes the foreign table item in the tree view.
 */
export async function cmdRefreshForeignTable(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider) {
  databaseTreeProvider?.refresh(item);
}

/**
 * cmdCreateForeignTable - Command to create a new foreign table in the database.
 */
export async function cmdCreateForeignTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    const schemaName = item.schema || 'public';

    const markdown = MarkdownUtils.header(`➕ Create New Foreign Table in Schema: \`${schemaName}\``) +
      MarkdownUtils.infoBox('This notebook provides templates for creating foreign tables. Modify the templates below and execute to create foreign tables.') +
      `\n\n#### 📋 Foreign Table Design Guidelines\n\n` +
      MarkdownUtils.operationsTable([
        { operation: '<strong>Server Setup</strong>', description: 'Foreign tables require a foreign server. Create one using CREATE SERVER before creating the table.' },
        { operation: '<strong>Column Mapping</strong>', description: 'Map local columns to remote columns. Data types should be compatible.' },
        { operation: '<strong>Options</strong>', description: 'Use OPTIONS to specify remote schema, table name, and other connection parameters.' },
        { operation: '<strong>Permissions</strong>', description: 'Ensure user has USAGE privilege on the foreign server and appropriate permissions on the remote database.' },
        { operation: '<strong>Performance</strong>', description: 'Foreign tables can be slower than local tables. Consider materialized views for frequently accessed data.' }
      ]) +
      `\n\n#### 🏷️ Common Foreign Table Patterns\n\n` +
      MarkdownUtils.propertiesTable({
        'Remote PostgreSQL': 'Connect to another PostgreSQL database',
        'Remote MySQL': 'Connect to MySQL/MariaDB database',
        'Remote SQL Server': 'Connect to Microsoft SQL Server',
        'File-based': 'Access CSV or other file-based data sources',
        'Custom FDW': 'Use custom Foreign Data Wrapper extensions'
      }) +
      MarkdownUtils.successBox('Foreign tables provide transparent access to remote data sources. They are read-only by default but can support writes with appropriate FDW support.') +
      `\n\n---`;

    await new NotebookBuilder(metadata)
      .addMarkdown(markdown)
      .addMarkdown('##### 📝 Basic Foreign Table (Recommended Start)')
      .addSql(ForeignTableSQL.create.basic(schemaName))
      .addMarkdown('##### 🔗 PostgreSQL-to-PostgreSQL')
      .addSql(ForeignTableSQL.create.postgresRemote(schemaName))
      .addMarkdown('##### 📊 File-based Foreign Table (file_fdw)')
      .addSql(ForeignTableSQL.create.fileBased(schemaName))
      .addMarkdown('##### 🔍 Query Foreign Table')
      .addSql(ForeignTableSQL.queryWithJoin(schemaName))
      .addMarkdown('##### 🛠️ Manage Foreign Server')
      .addSql(ForeignTableSQL.manageForeignServer())
      .addMarkdown(MarkdownUtils.warningBox('Foreign tables require proper network connectivity and authentication. Ensure firewall rules allow connections and credentials are correct. Performance may vary based on network latency.'))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create foreign table notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdViewForeignTableData - Single-operation notebook: SELECT from foreign table
 */
export async function cmdViewForeignTableData(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📖 Query Foreign Table Data: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('Runs a safe preview query so you can validate mapping and connectivity to the remote source.')
      )
      .addMarkdown('##### 📖 SELECT')
      .addSql(ForeignTableSQL.queryData(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'query foreign table data');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdShowForeignTableProperties - Properties notebook for a foreign table
 */
export async function cmdShowForeignTableProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const [infoResult, definitionResult] = await Promise.all([
      client.query(QueryBuilder.foreignTableInfo(item.schema!, item.label)),
      client.query(QueryBuilder.foreignTableDefinition(item.schema!, item.label))
    ]);

    if (infoResult.rows.length === 0 || definitionResult.rows.length === 0) {
      throw new Error('Foreign table not found');
    }

    const first = infoResult.rows[0];
    const serverName = first.server_name;
    const options = first.options || [];

    const columnRows = infoResult.rows.map((row: any, index: number) => {
      const defaultSql = row.column_default ? `<code>${row.column_default}</code>` : '—';
      return `    <tr>
      <td>${index + 1}</td>
      <td><strong>${row.column_name}</strong></td>
      <td><code>${row.data_type}</code></td>
      <td>${row.is_nullable === 'YES' ? 'YES' : 'NO'}</td>
      <td>${defaultSql}</td>
    </tr>`;
    }).join('\n');

    const tableInfo = definitionResult.rows[0];
    const createStatement = `CREATE FOREIGN TABLE ${item.schema}.${item.label} (\n${tableInfo.columns.map((col: string) => '    ' + col).join(',\n')}\n) SERVER ${tableInfo.server_name}${tableInfo.options ? '\nOPTIONS (\n    ' + tableInfo.options.map((opt: string) => opt).join(',\n    ') + '\n)' : ''};`;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🔗 Foreign Table Properties: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox(`<strong>Server:</strong> ${serverName}`) +
        `\n\n#### 📊 General Information\n\n` +
        MarkdownUtils.propertiesTable({
          'Schema': item.schema || 'public',
          'Name': item.label,
          'Server': serverName,
          'Column Count': `${infoResult.rows.length}`,
          'Options': options.length ? `<code>${options.join(', ')}</code>` : '—'
        }) +
        `\n\n#### 📋 Columns (${infoResult.rows.length})\n\n` +
        `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
      <th style="text-align: left; width: 5%;">#</th>
      <th style="text-align: left; width: 25%;">Name</th>
      <th style="text-align: left; width: 25%;">Data Type</th>
      <th style="text-align: left; width: 15%;">Nullable</th>
      <th style="text-align: left;">Default</th>
    </tr>
${columnRows}
</table>`
      )
      .addMarkdown('##### 📝 CREATE FOREIGN TABLE Script')
      .addSql(createStatement)
      .addMarkdown('##### 📖 Query Data')
      .addSql(ForeignTableSQL.queryData(item.schema!, item.label))
      .addMarkdown('##### ❌ DROP Foreign Table Script — ⚠️ Warning: permanently deletes the foreign table')
      .addSql(ForeignTableSQL.drop(item.schema!, item.label))
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show foreign table properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdDropForeignTable - Single-operation notebook: DROP foreign table
 */
export async function cmdDropForeignTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`❌ Drop Foreign Table: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.warningBox('This permanently deletes the foreign table mapping. Remote source data is not deleted, but local access via this object is removed.')
      )
      .addMarkdown('##### ❌ DROP')
      .addSql(ForeignTableSQL.drop(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'drop foreign table');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}