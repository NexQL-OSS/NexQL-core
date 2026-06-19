import * as vscode from 'vscode';
import { DatabaseTreeItem, DatabaseTreeProvider } from '../../providers/DatabaseTreeProvider';
import {
  MarkdownUtils,
  ErrorHandlers,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder,
  validateCategoryItem,
} from '../helper';
import { SchemaSQL } from '../sql';
import { queryServerVersionNum } from '../../lib/postgresServerVersion';



/**
 * cmdCreateSchema - Command to create a new schema in the database
 * @param {DatabaseTreeItem} item - The selected database item in the tree
 * @param {vscode.ExtensionContext} context - The extension context
 */
export async function cmdCreateSchema(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateCategoryItem);
    const { metadata } = dbConn;

    const databaseName = item.label;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Create New Schema in Database: \`${databaseName}\`\n\nCreate a new schema using the template below.`)
      .addSql(SchemaSQL.create())
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create schema notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdCreateObjectInSchema - Command to create a new object (table, view, function, etc.) in the selected schema
 * @param {DatabaseTreeItem} item - The selected schema item in the tree
 * @param {vscode.ExtensionContext} context - The extension context
 */
export async function cmdCreateObjectInSchema(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    const items = [
      { label: 'Table', detail: 'Create a new table in this schema', query: `CREATE TABLE ${item.schema}.table_name(\n    id serial PRIMARY KEY, \n    column_name data_type, \n    created_at timestamptz DEFAULT current_timestamp\n); ` },
      { label: 'View', detail: 'Create a new view in this schema', query: `CREATE VIEW ${item.schema}.view_name AS\nSELECT column1, column2\nFROM some_table\nWHERE condition; ` },
      { label: 'Function', detail: 'Create a new function in this schema', query: `CREATE OR REPLACE FUNCTION ${item.schema}.function_name(\n    param1 data_type, \n    param2 data_type\n) RETURNS return_type AS $\nBEGIN\n-- Function logic here\n    RETURN result; \nEND; \n$ LANGUAGE plpgsql; ` },
      { label: 'Procedure', detail: 'Create a new procedure in this schema', query: `CREATE OR REPLACE PROCEDURE ${item.schema}.procedure_name(\n    IN param1 data_type,\n    IN param2 data_type\n)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    -- Procedure logic here\n    RAISE NOTICE 'param1: %, param2: %', param1, param2;\nEND;\n$$; ` },
      { label: 'Materialized View', detail: 'Create a new materialized view in this schema', query: `CREATE MATERIALIZED VIEW ${item.schema}.matview_name AS\nSELECT column1, column2\nFROM source_table\nWHERE condition\nWITH DATA; ` },
      { label: 'Type', detail: 'Create a new composite type in this schema', query: `CREATE TYPE ${item.schema}.type_name AS(\n    field1 data_type, \n    field2 data_type\n); ` },
      { label: 'Foreign Table', detail: 'Create a new foreign table in this schema', query: `CREATE FOREIGN TABLE ${item.schema}.foreign_table_name(\n    column1 data_type, \n    column2 data_type\n) SERVER foreign_server_name\nOPTIONS(schema_name 'remote_schema', table_name 'remote_table'); ` }
    ];

    const selection = await vscode.window.showQuickPick(items, {
      title: 'Create in Schema',
      placeHolder: 'Select what to create'
    });

    if (selection) {
      await new NotebookBuilder(metadata)
        .addMarkdown(
          MarkdownUtils.header(`➕ Create New ${selection.label} in Schema: \`${item.schema}\``) +
          MarkdownUtils.infoBox(`Modify the definition below and execute the cell to create the ${selection.label.toLowerCase()}.`)
        )
        .addMarkdown('##### 📝 Object Definition')
        .addSql(selection.query)
        .show();
    }
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdSchemaOperations - Operations_Notebook for a schema.
 * Cell order: read (listObjects) → write/modify (grant) → destructive (drop)
 */
export async function cmdSchemaOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🗂️ Schema Operations: \`${item.schema}\`\n\nCommon operations for managing this PostgreSQL schema.`)
      .addMarkdown('##### 📦 List Objects')
      .addSql(SchemaSQL.listObjects(item.schema!))
      .addMarkdown('##### 🛡️ Grant Privileges')
      .addSql(SchemaSQL.grant(item.schema!))
      .addMarkdown('##### ❌ Drop Schema\n\n⚠️ **Warning:** Dropping this schema is permanent and will remove all contained objects if CASCADE is used.')
      .addSql(SchemaSQL.drop(item.schema!))
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create schema operations notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdRefreshSchema - Refreshes the schema item in the tree view.
 */
export async function cmdRefreshSchema(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider) {
  databaseTreeProvider?.refresh(item);
}

export async function cmdShowSchemaProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const serverVersionNum = await queryServerVersionNum(client);
    // Gather comprehensive schema information
    const schemaInfo = await client.query(QueryBuilder.schemaDetails(item.schema!));
    const objectsInfo = await client.query(QueryBuilder.schemaObjectCounts(item.schema!, serverVersionNum));
    const sizeInfo = await client.query(QueryBuilder.schemaSize(item.schema!));
    const privilegesInfo = await client.query(QueryBuilder.schemaPrivileges(item.schema!));
    const dependenciesInfo = await client.query(QueryBuilder.schemaDependencies(item.schema!));
    const extensionsInfo = await client.query(QueryBuilder.schemaExtensions(item.schema!));

    const schema = schemaInfo.rows[0];
    const objects = objectsInfo.rows[0] || {};
    const sizes = sizeInfo.rows[0];
    const privileges = privilegesInfo.rows;
    const topObjects = dependenciesInfo.rows;
    const extensions = extensionsInfo.rows;

    // Build privileges HTML
    const privilegeRows = privileges.map((p: any) => {
      return `    <tr>
        <td><strong>${p.grantee}</strong></td>
        <td>${p.privileges || '—'}</td>
        <td style="font-size: 10px;">${p.grantable_privileges || '—'}</td>
    </tr>`;
    }).join('\n');

    // Build top objects HTML
    const objectRows = topObjects.map((obj: any) => {
      return `    <tr>
        <td><strong>${obj.object_name}</strong></td>
        <td>${obj.object_type}</td>
        <td>${obj.size}</td>
    </tr>`;
    }).join('\n');

    // Build extensions HTML
    const extensionRows = extensions.map((ext: any) => {
      return `    <tr>
        <td><strong>${ext.extension_name}</strong></td>
        <td>${ext.version}</td>
        <td>${ext.owner}</td>
    </tr>`;
    }).join('\n');

    // Calculate total object count
    const totalObjects = (parseInt(objects.table_count) || 0) +
      (parseInt(objects.view_count) || 0) +
      (parseInt(objects.matview_count) || 0) +
      (parseInt(objects.sequence_count) || 0) +
      (parseInt(objects.foreign_table_count) || 0) +
      (parseInt(objects.partitioned_table_count) || 0) +
      (parseInt(objects.function_count) || 0) +
      (parseInt(objects.procedure_count) || 0) +
      (parseInt(objects.type_count) || 0);

    const ownerInfo = `${schema.owner} | <strong>Database:</strong> ${item.databaseName}${schema.comment ? ` | <strong>Comment:</strong> ${schema.comment}` : ''}`;
    const markdown = MarkdownUtils.header(`🗂️ Schema Properties: \`${item.schema}\``) +
      MarkdownUtils.infoBox(`<strong>Owner:</strong> ${ownerInfo}`) +
      `\n\n#### 💾 Size & Statistics\n\n` +
      MarkdownUtils.propertiesTable({
        'Total Size': sizes.total_size || 'N/A',
        'Table Size': sizes.table_size || 'N/A',
        'Index Size': sizes.indexes_size || 'N/A',
        'Total Objects': totalObjects.toLocaleString()
      }) +
      `\n\n#### 📦 Object Breakdown\n\n` +
      MarkdownUtils.propertiesTable({
        '📊 Tables': `${objects.table_count || 0}`,
        '📋 Views': `${objects.view_count || 0}`,
        '📈 Materialized Views': `${objects.matview_count || 0}`,
        '🔢 Sequences': `${objects.sequence_count || 0}`,
        '🔗 Foreign Tables': `${objects.foreign_table_count || 0}`,
        '📂 Partitioned Tables': `${objects.partitioned_table_count || 0}`,
        '⚙️ Functions': `${objects.function_count || 0}`,
        '🧩 Procedures': `${objects.procedure_count || 0}`,
        '🏷️ Types': `${objects.type_count || 0}`,
        '⚡ Triggers': `${objects.trigger_count || 0}`
      });

    await new NotebookBuilder(metadata)
      .addMarkdown(markdown +
        (topObjects.length > 0 ? `\n\n#### 📊 Largest Objects (Top 10)

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 40%;">Name</th>
        <th style="text-align: left; width: 30%;">Type</th>
        <th style="text-align: left;">Size</th>
    </tr>
${objectRows}
</table>

` : '') +
        (privileges.length > 0 ? `#### 🔐 Privileges & Permissions (${privileges.length} grantees)

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 25%;">Grantee</th>
        <th style="text-align: left; width: 40%;">Privileges</th>
        <th style="text-align: left;">Grantable</th>
    </tr>
${privilegeRows}
</table>

` : '') +
        (extensions.length > 0 ? `#### 🧩 Extensions in Schema

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 40%;">Extension</th>
        <th style="text-align: left; width: 30%;">Version</th>
        <th style="text-align: left;">Owner</th>
    </tr>
${extensionRows}
</table>

` : '') +
        '---')
      .addMarkdown('##### 📋 List All Objects')
      .addSql(QueryBuilder.schemaAllObjects(item.schema!))
      .addMarkdown('##### 📝 CREATE SCHEMA Script')
      .addSql(`-- Create schema (if recreating)\nCREATE SCHEMA IF NOT EXISTS ${item.schema}\n    AUTHORIZATION ${schema.owner};\n\n-- Add comment\n${schema.comment ? `COMMENT ON SCHEMA ${item.schema} IS '${schema.comment.replace(/'/g, "''")}';` : `-- COMMENT ON SCHEMA ${item.schema} IS 'schema description';`}\n\n-- Grant basic privileges (modify as needed)\nGRANT USAGE ON SCHEMA ${item.schema} TO PUBLIC;\n-- GRANT CREATE ON SCHEMA ${item.schema} TO role_name;`)
      .addMarkdown('##### 🔐 Schema Privileges')
      .addSql(`-- View all schema privileges\nSELECT \n    nspname as schema_name,\n    nspacl as access_control_list,\n    pg_catalog.pg_get_userbyid(nspowner) as owner\nFROM pg_namespace\nWHERE nspname = '${item.schema}';\n\n-- Grant privileges (modify as needed)\n-- GRANT USAGE ON SCHEMA ${item.schema} TO role_name;\n-- GRANT CREATE ON SCHEMA ${item.schema} TO role_name;\n-- GRANT ALL ON SCHEMA ${item.schema} TO role_name;\n\n-- Revoke privileges\n-- REVOKE ALL ON SCHEMA ${item.schema} FROM role_name;`)
      .addMarkdown('##### 🔍 Schema Dependencies')
      .addSql(`-- Find all functions in schema\nSELECT \n    p.proname as function_name,\n    pg_get_function_arguments(p.oid) as arguments,\n    pg_get_function_result(p.oid) as return_type\nFROM pg_proc p\nJOIN pg_namespace n ON n.oid = p.pronamespace\nWHERE n.nspname = '${item.schema}';`)
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show schema properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}
