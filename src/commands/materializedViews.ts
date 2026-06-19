import * as vscode from 'vscode';

import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import {
  MarkdownUtils,
  FormatHelpers,
  ErrorHandlers,
  ObjectUtils,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder
} from './helper';
import { MaterializedViewSQL } from './sql';



/**
 * cmdRefreshMatView - Single-operation notebook: REFRESH materialized view
 */
export async function cmdRefreshMatView(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(MarkdownUtils.header(`🔄 Refresh Materialized View: \`${item.schema}.${item.label}\``, 'Refresh the materialized view data from underlying tables.'))
      .addMarkdown('##### 🔄 REFRESH')
      .addSql(MaterializedViewSQL.refresh(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create refresh materialized view notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function cmdEditMatView(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    try {
      const result = await client.query(QueryBuilder.matViewDefinition(item.schema!, item.label));
      if (!result.rows[0]?.definition) {
        throw new Error('Materialized view definition not found');
      }

      const viewDef = (result.rows[0].definition || '').replace(/;\s*$/, '');
      const createMatViewStatement = `CREATE MATERIALIZED VIEW ${item.schema}.${item.label} AS\n${viewDef}\nWITH DATA;`;

      await new NotebookBuilder(metadata)
          .addMarkdown(
            MarkdownUtils.header(`✏️ Edit Materialized View: \`${item.schema}.${item.label}\``, 'Modify the materialized view definition below and execute the cell to update it.') +
            MarkdownUtils.warningBox('This will drop and recreate the materialized view.')
          )
        .addMarkdown('##### 📝 View Definition')
        .addSql(`DROP MATERIALIZED VIEW IF EXISTS ${item.schema}.${item.label};\n\n${createMatViewStatement}`)
        .show();
    } finally {
      // Connection is managed by ConnectionManager
    }
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create materialized view edit notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdViewMatViewData - Single-operation notebook: SELECT from materialized view
 */
export async function cmdViewMatViewData(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(MarkdownUtils.header(`📖 View Data: \`${item.schema}.${item.label}\``, 'Query data from the materialized view.'))
      .addMarkdown('##### 📖 SELECT')
      .addSql(MaterializedViewSQL.select(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create view data notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function cmdViewMatViewProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;

    try {
      // Gather comprehensive materialized view information
      const matviewInfo = await client.query(QueryBuilder.matViewInfo(item.schema!, item.label));
      const columnInfo = await client.query(QueryBuilder.tableColumns(item.schema!, item.label));
      const indexInfo = await client.query(QueryBuilder.tableIndexes(item.schema!, item.label));
      const dependenciesInfo = await client.query(QueryBuilder.objectDependencies(item.schema!, item.label));
      const referencedInfo = await client.query(QueryBuilder.objectReferences(item.schema!, item.label));
      const statsInfo = await client.query(QueryBuilder.matViewStats(item.schema!, item.label));

      if (matviewInfo.rows.length === 0) {
        throw new Error('Materialized view not found');
      }

      const matview = matviewInfo.rows[0];
      const columns = columnInfo.rows;
      const indexes = indexInfo.rows;
      const dependents = dependenciesInfo.rows;
      const references = referencedInfo.rows;
      const stats = statsInfo.rows[0] || {};

      // Get definition
      const viewDefResult = await client.query(QueryBuilder.matViewDefinition(item.schema!, item.label));
      const viewDefinition = (viewDefResult.rows[0]?.definition || '').replace(/;\s*$/, '');

      // Build column table HTML
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
        <td>${FormatHelpers.formatBoolean(col.is_nullable === 'YES')}</td>
        <td>${col.default_value ? `<code>${col.default_value}</code>` : '—'}</td>
        <td>${col.description || '—'}</td>
    </tr>`;
      }).join('\n');

      // Build indexes table HTML
      const indexRows = indexes.map((idx: any) => {
        const badges = [];
        if (idx.is_primary) badges.push('🔑 PRIMARY');
        if (idx.is_unique) badges.push('⭐ UNIQUE');
        return `    <tr>
        <td><strong>${idx.index_name}</strong>${badges.length > 0 ? ` <span style="font-size: 9px;">${badges.join(' ')}</span>` : ''}</td>
        <td>${idx.columns || ''}</td>
        <td>${idx.index_size}</td>
    </tr>`;
      }).join('\n');

      // Build dependencies table HTML
      const dependencyRows = dependents.map((dep: any) => {
        return `    <tr>
        <td>${ObjectUtils.getKindLabel(dep.kind)}</td>
        <td><code>${dep.schema}.${dep.name}</code></td>
    </tr>`;
      }).join('\n');

      // Build references table HTML
      const referenceRows = references.map((ref: any) => {
        return `    <tr>
        <td>${ObjectUtils.getKindLabel(ref.kind)}</td>
        <td><code>${ref.schema}.${ref.name}</code></td>
    </tr>`;
      }).join('\n');

      const ownerInfo = `${matview.owner} | <strong>Populated:</strong> ${FormatHelpers.formatBoolean(matview.ispopulated, 'Yes', 'No')}${matview.comment ? ` | <strong>Comment:</strong> ${matview.comment}` : ''}`;

      await new NotebookBuilder(metadata)
        .addMarkdown(
          MarkdownUtils.header(`💾 Materialized View Properties: \`${item.schema}.${item.label}\``) +
          MarkdownUtils.infoBox(`<strong>Owner:</strong> ${ownerInfo}`) +
          `\n\n#### 📊 General Information\n\n` +
          MarkdownUtils.propertiesTable({
            'Schema': matview.schema_name,
            'Name': matview.matview_name,
            'Owner': matview.owner,
            'Is Populated': FormatHelpers.formatBoolean(matview.ispopulated, 'Yes', 'No'),
            'Total Size': matview.total_size,
            'Table Size': matview.table_size,
            'Indexes Size': matview.indexes_size,
            'Row Estimate': matview.row_estimate?.toLocaleString() || 'N/A',
            'Live Tuples': stats.live_tuples?.toLocaleString() || 'N/A',
            'Dead Tuples': stats.dead_tuples?.toLocaleString() || 'N/A'
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
          (indexes.length > 0 ? `#### 🔍 Indexes (${indexes.length})

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 35%;">Index Name</th>
        <th style="text-align: left; width: 40%;">Columns</th>
        <th style="text-align: left;">Size</th>
    </tr>
${indexRows}
</table>

` : '') +
          (references.length > 0 ? `#### 🔗 Referenced Objects (${references.length})

${MarkdownUtils.infoBox('Objects that this materialized view depends on:', 'Info')}

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 20%;">Type</th>
        <th style="text-align: left;">Object</th>
    </tr>
${referenceRows}
</table>

` : '') +
          (dependents.length > 0 ? `#### 🔄 Dependent Objects (${dependents.length})

${MarkdownUtils.infoBox('Objects that depend on this materialized view:', 'Info')}

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 20%;">Type</th>
        <th style="text-align: left;">Object</th>
    </tr>
${dependencyRows}
</table>

` : '') +
          '---'
        )
        .addMarkdown('##### 📝 CREATE MATERIALIZED VIEW Script')
        .addSql(`-- DROP MATERIALIZED VIEW IF EXISTS ${item.schema}.${item.label};\n\nCREATE MATERIALIZED VIEW ${item.schema}.${item.label} AS\n${viewDefinition}\nWITH DATA;\n\n-- Materialized view comment\n${matview.comment ? `COMMENT ON MATERIALIZED VIEW ${item.schema}.${item.label} IS '${matview.comment.replace(/'/g, "''")}';` : `-- COMMENT ON MATERIALIZED VIEW ${item.schema}.${item.label} IS 'view description';`}\n\n-- Indexes\n${indexes.map((idx: any) => idx.definition).join('\n')}`)
        .addMarkdown('##### 🔄 Refresh Materialized View')
        .addSql(MaterializedViewSQL.refresh(item.schema!, item.label))
        .addMarkdown('##### 📖 Query Materialized View Data')
        .addSql(MaterializedViewSQL.select(item.schema!, item.label))
        .addMarkdown('##### 📊 Statistics and Metadata')
        .addSql(`-- Get detailed statistics\nSELECT \n    schemaname,\n    matviewname,\n    matviewowner,\n    tablespace,\n    hasindexes,\n    ispopulated,\n    pg_size_pretty(pg_total_relation_size(schemaname||'.'||matviewname)) as total_size\nFROM pg_matviews\nWHERE schemaname = '${item.schema}' AND matviewname = '${item.label}';\n\n-- Check when it was last refreshed\nSELECT \n    schemaname,\n    relname,\n    last_vacuum,\n    last_autovacuum,\n    last_analyze,\n    last_autoanalyze,\n    n_live_tup,\n    n_dead_tup\nFROM pg_stat_user_tables\nWHERE schemaname = '${item.schema}' AND relname = '${item.label}';`)
        .addMarkdown('##### 🗑️ DROP Materialized View Script')
        .addSql(MaterializedViewSQL.drop(item.schema!, item.label))
        .show();
    } finally {
      // Do not close shared client
    }
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show materialized view properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdDropMatView - Single-operation notebook: DROP materialized view
 */
export async function cmdDropMatView(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🗑️ Drop Materialized View: \`${item.schema}.${item.label}\``, 'Drop the materialized view from the database.') +
        MarkdownUtils.dangerBox(`Dropping \`${item.schema}.${item.label}\` is permanent and will fail if dependent objects exist.`)
      )
      .addMarkdown('##### 🗑️ DROP')
      .addSql(MaterializedViewSQL.drop(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create drop materialized view notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdMatViewOperations - Operations_Notebook for a materialized view.
 * Cell order: read (SELECT, ANALYZE) → write/modify (REFRESH, CREATE INDEX) → destructive (DROP)
 */
export async function cmdMatViewOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 💾 Materialized View Operations: \`${item.schema}.${item.label}\`\n\nCommon operations for this PostgreSQL materialized view.`)
      .addMarkdown('##### 📖 SELECT')
      .addSql(MaterializedViewSQL.select(item.schema!, item.label))
      .addMarkdown('##### 📊 ANALYZE')
      .addSql(MaterializedViewSQL.analyze(item.schema!, item.label))
      .addMarkdown('##### 🔄 REFRESH')
      .addSql(MaterializedViewSQL.refresh(item.schema!, item.label))
      .addMarkdown('##### 🔍 CREATE INDEX')
      .addSql(MaterializedViewSQL.createIndex(item.schema!, item.label))
      .addMarkdown('##### ❌ DROP — ⚠️ Warning: permanently deletes the materialized view')
      .addSql(MaterializedViewSQL.drop(item.schema!, item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show materialized view operations');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdCreateMaterializedView - Single-cell notebook with CREATE MATERIALIZED VIEW template.
 */
export async function cmdCreateMaterializedView(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;

    const schema = item.schema!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Create New Materialized View in Schema: \`${schema}\`\n\nCreate a materialized view using the template below.`)
      .addMarkdown('##### 📝 CREATE MATERIALIZED VIEW')
      .addSql(MaterializedViewSQL.create(schema, 'new_matview'))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create materialized view notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}
