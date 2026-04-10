import * as vscode from 'vscode';

import { DatabaseTreeItem, DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { CommandBase } from '../common/commands/CommandBase';
import {
  MarkdownUtils,
  FormatHelpers,
  ErrorHandlers,
  ObjectUtils,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder
} from './helper';
import { FunctionSQL } from './sql';



/**
 * cmdFunctionOperations - Operations_Notebook for a function.
 * Cell order: read (metadata, definition) → write/modify (call, create or replace) → destructive (drop)
 */
export async function cmdFunctionOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const functionResult = await client.query(QueryBuilder.functionInfo(item.schema!, item.label));
    if (functionResult.rows.length === 0) {
      throw new Error('Function not found');
    }

    const functionInfo = functionResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ⚡ Function Operations: \`${item.schema}.${item.label}\`\n\nCommon operations for this PostgreSQL function.`)
      .addMarkdown('##### 📊 Metadata')
      .addSql(FunctionSQL.metadata(item.schema!, item.label))
      .addMarkdown('##### 📝 Definition')
      .addSql(`-- Current function definition\n${functionInfo.definition} `)
      .addMarkdown('##### 📞 Call')
      .addSql(FunctionSQL.call(item.schema!, item.label, functionInfo.arguments || ''))
      .addMarkdown('##### ✏️ Create or Replace')
      .addSql(FunctionSQL.createOrReplace(item.schema!))
      .addMarkdown('##### ❌ DROP — ⚠️ Warning: permanently deletes the function')
      .addSql(FunctionSQL.drop(item.schema!, item.label, functionInfo.arguments || ''))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create function operations notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdEditFunction - Fetches the actual function definition from the DB and opens it for editing.
 * Kept as-is: it queries the live definition, not a template.
 */
export async function cmdEditFunction(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const functionResult = await client.query(QueryBuilder.functionDefinition(item.schema!, item.label));
    if (functionResult.rows.length === 0) {
      throw new Error('Function not found');
    }

    const functionInfo = functionResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ✏️ Edit Function: \`${item.schema}.${item.label}\`\n\nModify the function definition below and execute to update.`)
      .addMarkdown('##### 📝 Function Definition')
      .addSql(functionInfo.definition)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create function edit notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdCallFunction - Single-operation notebook: CALL function.
 */
export async function cmdCallFunction(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create function call notebook', async (conn: any, client: any, metadata: any) => {
    const functionResult = await client.query(QueryBuilder.functionSignature(item.schema!, item.label));
    if (functionResult.rows.length === 0) {
      throw new Error('Function not found');
    }

    const functionInfo = functionResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 📞 Call Function: \`${item.schema}.${item.label}\`\n\nExecute the function with the arguments below.`)
      .addSql(FunctionSQL.call(item.schema!, item.label, functionInfo.arguments || ''))
      .show();
  });
}

/**
 * cmdDropFunction - Single-operation notebook: DROP function.
 */
export async function cmdDropFunction(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create drop function notebook', async (conn: any, client: any, metadata: any) => {
    const functionResult = await client.query(QueryBuilder.functionArguments(item.schema!, item.label));
    if (functionResult.rows.length === 0) {
      throw new Error('Function not found');
    }

    const functionInfo = functionResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ❌ Drop Function: \`${item.schema}.${item.label}\`\n\n⚠️ **Warning:** This permanently deletes the function and cannot be undone.`)
      .addSql(FunctionSQL.drop(item.schema!, item.label, functionInfo.arguments || ''))
      .show();
  });
}

/**
 * cmdShowFunctionProperties - Properties panel for a function. Kept as-is.
 */
export async function cmdShowFunctionProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    // Gather comprehensive function information
    const [functionInfo, dependenciesInfo] = await Promise.all([
      client.query(`
                    SELECT 
                        p.proname as function_name,
                        n.nspname as schema_name,
                        pg_get_userbyid(p.proowner) as owner,
                        l.lanname as language,
                        pg_get_function_arguments(p.oid) as arguments,
                        pg_get_function_result(p.oid) as return_type,
                        pg_get_functiondef(p.oid) as definition,
                        obj_description(p.oid, 'pg_proc') as comment,
                        CASE p.provolatile
                            WHEN 'i' THEN 'IMMUTABLE'
                            WHEN 's' THEN 'STABLE'
                            WHEN 'v' THEN 'VOLATILE'
                        END as volatility,
                        CASE p.proparallel
                            WHEN 's' THEN 'SAFE'
                            WHEN 'r' THEN 'RESTRICTED'
                            WHEN 'u' THEN 'UNSAFE'
                        END as parallel,
                        p.prosecdef as security_definer,
                        p.proisstrict as strict,
                        p.proretset as returns_set,
                        pg_size_pretty(pg_relation_size(p.oid)) as size
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    LEFT JOIN pg_language l ON l.oid = p.prolang
                    WHERE n.nspname = $1 AND p.proname = $2
                `, [item.schema, item.label]),

      client.query(`
                    SELECT DISTINCT
                        dependent_ns.nspname as schema,
                        dependent_view.relname as name,
                        dependent_view.relkind as kind
                    FROM pg_depend dep
                    JOIN pg_rewrite rew ON dep.objid = rew.oid
                    JOIN pg_class dependent_view ON rew.ev_class = dependent_view.oid
                    JOIN pg_namespace dependent_ns ON dependent_ns.oid = dependent_view.relnamespace
                    WHERE dep.refobjid = (
                        SELECT p.oid FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = $1 AND p.proname = $2
                    )
                    ORDER BY schema, name
                `, [item.schema, item.label])
    ]);

    if (functionInfo.rows.length === 0) {
      throw new Error('Function not found');
    }

    const func = functionInfo.rows[0];
    const dependents = dependenciesInfo.rows;

    // Parse arguments for display
    const argsList = func.arguments ? func.arguments.split(',').map((arg: string, idx: number) => {
      const trimmed = arg.trim();
      return `    <tr>
        <td>${idx + 1}</td>
        <td><code>${trimmed || '(no arguments)'}</code></td>
    </tr>`;
    }).join('\n') : '    <tr><td colspan="2" style="text-align: center;">No arguments</td></tr>';

    // Build dependencies table HTML
    const dependencyRows = dependents.map((dep: any) => {
      return `    <tr>
        <td>${ObjectUtils.getKindLabel(dep.kind)}</td>
        <td><code>${dep.schema}.${dep.name}</code></td>
    </tr>`;
    }).join('\n');

    const ownerInfo = `${func.owner} | <strong>Language:</strong> ${func.language}${func.comment ? ` | <strong>Comment:</strong> ${func.comment}` : ''}`;
    const markdown = MarkdownUtils.header(`⚡ Function Properties: \`${item.schema}.${item.label}\``) +
      MarkdownUtils.infoBox(`<strong>Owner:</strong> ${ownerInfo}`) +
      `\n\n#### 📊 General Information\n\n` +
      MarkdownUtils.propertiesTable({
        'Schema': func.schema_name,
        'Function Name': func.function_name,
        'Owner': func.owner,
        'Language': func.language,
        'Return Type': `<code>${func.return_type}</code>`,
        'Returns Set': FormatHelpers.formatBoolean(func.returns_set, 'Yes', 'No'),
        'Volatility': func.volatility,
        'Parallel Safety': func.parallel,
        'Security': func.security_definer ? '🔒 SECURITY DEFINER' : '👤 SECURITY INVOKER',
        'Strict (NULL handling)': func.strict ? '✅ Returns NULL on NULL input' : '🚫 Processes NULL inputs'
      }) +
      `\n\n#### 📥 Arguments${func.arguments ? ' (' + func.arguments.split(',').length + ')' : ' (0)'}\n\n` +
      `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 10%;">#</th>
        <th style="text-align: left;">Argument</th>
    </tr>
${argsList}
</table>

` +
      (dependents.length > 0 ? `#### 🔄 Dependent Objects (${dependents.length})

${MarkdownUtils.infoBox('Objects that depend on this function:', 'Info')}

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 20%;">Type</th>
        <th style="text-align: left;">Object</th>
    </tr>
${dependencyRows}
</table>

` : '') +
      '---';

    await new NotebookBuilder(metadata)
      .addMarkdown(markdown)
      .addMarkdown('##### 📝 Function Definition')
      .addSql(func.definition)
      .addMarkdown('##### ⚡ Call Function')
      .addSql(FunctionSQL.call(item.schema!, item.label, func.arguments || ''))
      .addMarkdown('##### ❌ DROP Function Script — ⚠️ Warning: permanently deletes the function')
      .addSql(FunctionSQL.drop(item.schema!, item.label, func.arguments || ''))
      .addMarkdown('##### 📊 Function Metadata')
      .addSql(FunctionSQL.metadata(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show function properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdRefreshFunction - Refreshes the function item in the tree view.
 */
export async function cmdRefreshFunction(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider) {
  databaseTreeProvider?.refresh(item);
}

/**
 * cmdCreateFunction - Single-cell notebook with CREATE OR REPLACE FUNCTION template.
 */
export async function cmdCreateFunction(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create function notebook', async (conn: any, client: any, metadata: any) => {
    const schema = item.schema!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Create New Function in Schema: \`${schema}\`\n\nCreate or replace a function using the template below.`)
      .addSql(FunctionSQL.createOrReplace(schema))
      .show();
  });
}
