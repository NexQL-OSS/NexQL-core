import * as vscode from 'vscode';

import { DatabaseTreeItem, DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { CommandBase } from '../common/commands/CommandBase';
import {
  MarkdownUtils,
  ErrorHandlers,
  ObjectUtils,
  getDatabaseConnection,
  NotebookBuilder,
} from './helper';
import { ProcedureSQL } from './sql';

function procedureInfoSql(schema: string, name: string): string {
  return `SELECT p.proname,
    pg_get_function_arguments(p.oid) as arguments,
    pg_get_functiondef(p.oid) as definition,
    d.description
FROM pg_proc p
LEFT JOIN pg_description d ON p.oid = d.objoid
WHERE p.proname = '${name}'
AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}')
AND p.prokind = 'p'`;
}

function procedureDefinitionSql(schema: string, name: string): string {
  return `SELECT pg_get_functiondef(p.oid) as definition
FROM pg_proc p
WHERE p.proname = '${name}'
AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}')
AND p.prokind = 'p'`;
}

function procedureArgumentsSql(schema: string, name: string): string {
  return `SELECT pg_get_function_arguments(p.oid) as arguments
FROM pg_proc p
WHERE p.proname = '${name}'
AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}')
AND p.prokind = 'p'`;
}

/**
 * cmdProcedureOperations - Operations notebook for a procedure.
 */
export async function cmdProcedureOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const procedureResult = await client.query(procedureInfoSql(item.schema!, item.label));
    if (procedureResult.rows.length === 0) {
      throw new Error('Procedure not found');
    }

    const procedureInfo = procedureResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(MarkdownUtils.header(`⚡ Procedure Operations: \`${item.schema}.${item.label}\``, 'Common operations for this PostgreSQL procedure.'))
      .addMarkdown('##### 📊 Metadata')
      .addSql(ProcedureSQL.metadata(item.schema!, item.label))
      .addMarkdown('##### 📝 Definition')
      .addSql(`-- Current procedure definition\n${procedureInfo.definition} `)
      .addMarkdown('##### 📞 Call')
      .addSql(ProcedureSQL.call(item.schema!, item.label, procedureInfo.arguments || ''))
      .addMarkdown('##### ✏️ Create or Replace')
      .addSql(ProcedureSQL.createOrReplace(item.schema!))
      .addMarkdown('##### 🗑️ DROP')
      .addSql(ProcedureSQL.drop(item.schema!, item.label, procedureInfo.arguments || ''))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create procedure operations notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdEditProcedure - Fetches the procedure definition and opens it for editing.
 */
export async function cmdEditProcedure(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const procedureResult = await client.query(procedureDefinitionSql(item.schema!, item.label));
    if (procedureResult.rows.length === 0) {
      throw new Error('Procedure not found');
    }

    const procedureInfo = procedureResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(MarkdownUtils.header(`✏️ Edit Procedure: \`${item.schema}.${item.label}\``, 'Modify the procedure definition below and execute to update.'))
      .addMarkdown('##### 📝 Procedure Definition')
      .addSql(procedureInfo.definition)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create procedure edit notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdCallProcedure - Single-operation notebook: CALL procedure.
 */
export async function cmdCallProcedure(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create procedure call notebook', async (conn: any, client: any, metadata: any) => {
    const procedureResult = await client.query(procedureArgumentsSql(item.schema!, item.label));
    if (procedureResult.rows.length === 0) {
      throw new Error('Procedure not found');
    }

    const procedureInfo = procedureResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(MarkdownUtils.header(`📞 Call Procedure: \`${item.schema}.${item.label}\``, 'Execute the procedure with the arguments below.'))
      .addSql(ProcedureSQL.call(item.schema!, item.label, procedureInfo.arguments || ''))
      .show();
  });
}

/**
 * cmdDropProcedure - Single-operation notebook: DROP procedure.
 */
export async function cmdDropProcedure(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create drop procedure notebook', async (conn: any, client: any, metadata: any) => {
    const procedureResult = await client.query(procedureArgumentsSql(item.schema!, item.label));
    if (procedureResult.rows.length === 0) {
      throw new Error('Procedure not found');
    }

    const procedureInfo = procedureResult.rows[0];

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🗑️ Drop Procedure: \`${item.schema}.${item.label}\``, 'Drop the procedure from the database.') +
        MarkdownUtils.dangerBox(`Dropping \`${item.schema}.${item.label}\` is permanent and will fail if dependent objects exist.`)
      )
      .addSql(ProcedureSQL.drop(item.schema!, item.label, procedureInfo.arguments || ''))
      .show();
  });
}

/**
 * cmdShowProcedureProperties - Properties panel for a procedure.
 */
export async function cmdShowProcedureProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    const metadataWarnings: string[] = [];

    let procedureInfo;
    try {
      procedureInfo = await client.query(`
                    SELECT
                        p.proname as procedure_name,
                        n.nspname as schema_name,
                        pg_get_userbyid(p.proowner) as owner,
                        l.lanname as language,
                        pg_get_function_arguments(p.oid) as arguments,
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
                        pg_size_pretty(pg_relation_size(p.oid)) as size
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    LEFT JOIN pg_language l ON l.oid = p.prolang
                    WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'p'
                `, [item.schema, item.label]);
    } catch (err) {
      throw err;
    }

    let dependenciesInfo = { rows: [] as any[] };
    try {
      dependenciesInfo = await client.query(`
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
                        WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'p'
                    )
                    ORDER BY schema, name
                `, [item.schema, item.label]);
    } catch (err) {
      metadataWarnings.push('Dependent objects could not be loaded.');
    }

    if (procedureInfo.rows.length === 0) {
      throw new Error('Procedure not found');
    }

    const proc = procedureInfo.rows[0];
    const dependents = dependenciesInfo.rows;

    const argsList = proc.arguments ? proc.arguments.split(',').map((arg: string, idx: number) => {
      const trimmed = arg.trim();
      return `    <tr>
        <td>${idx + 1}</td>
        <td><code>${trimmed || '(no arguments)'}</code></td>
    </tr>`;
    }).join('\n') : '    <tr><td colspan="2" style="text-align: center;">No arguments</td></tr>';

    const dependencyRows = dependents.map((dep: any) => {
      return `    <tr>
        <td>${ObjectUtils.getKindLabel(dep.kind)}</td>
        <td><code>${dep.schema}.${dep.name}</code></td>
    </tr>`;
    }).join('\n');

    const ownerInfo = `${proc.owner} | <strong>Language:</strong> ${proc.language}${proc.comment ? ` | <strong>Comment:</strong> ${proc.comment}` : ''}`;
    const markdown = MarkdownUtils.header(`⚡ Procedure Properties: \`${item.schema}.${item.label}\``) +
      MarkdownUtils.infoBox(`<strong>Owner:</strong> ${ownerInfo}`) +
      (metadataWarnings.length > 0
        ? MarkdownUtils.warningBox(`Partial metadata loaded: ${metadataWarnings.join(' ')}`)
        : '') +
      `\n\n#### 📊 General Information\n\n` +
      MarkdownUtils.propertiesTable({
        'Schema': proc.schema_name,
        'Procedure Name': proc.procedure_name,
        'Owner': proc.owner,
        'Language': proc.language,
        'Volatility': proc.volatility,
        'Parallel Safety': proc.parallel,
        'Security': proc.security_definer ? '🔒 SECURITY DEFINER' : '👤 SECURITY INVOKER',
        'Strict (NULL handling)': proc.strict ? '✅ Returns NULL on NULL input' : '🚫 Processes NULL inputs'
      }) +
      `\n\n#### 📥 Arguments${proc.arguments ? ' (' + proc.arguments.split(',').length + ')' : ' (0)'}\n\n` +
      `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 10%;">#</th>
        <th style="text-align: left;">Argument</th>
    </tr>
${argsList}
</table>

` +
      (dependents.length > 0 ? `#### 🔄 Dependent Objects (${dependents.length})

${MarkdownUtils.infoBox('Objects that depend on this procedure:', 'Info')}

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
      .addMarkdown('##### 📝 Procedure Definition')
      .addSql(proc.definition)
      .addMarkdown('##### ⚡ Call Procedure')
      .addSql(ProcedureSQL.call(item.schema!, item.label, proc.arguments || ''))
      .addMarkdown('##### 🗑️ DROP Procedure Script')
      .addSql(ProcedureSQL.drop(item.schema!, item.label, proc.arguments || ''))
      .addMarkdown('##### 📊 Procedure Metadata')
      .addSql(ProcedureSQL.metadata(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show procedure properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdRefreshProcedure - Refreshes the procedure item in the tree view.
 */
export async function cmdRefreshProcedure(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider) {
  databaseTreeProvider?.refresh(item);
}

/**
 * cmdCreateProcedure - Single-cell notebook with CREATE OR REPLACE PROCEDURE template.
 */
export async function cmdCreateProcedure(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create procedure notebook', async (conn: any, client: any, metadata: any) => {
    const schema = item.schema!;

    await new NotebookBuilder(metadata)
      .addMarkdown(MarkdownUtils.header(`➕ Create New Procedure in Schema: \`${schema}\``, 'Create or replace a procedure using the template below.'))
      .addSql(ProcedureSQL.createOrReplace(schema))
      .show();
  });
}
