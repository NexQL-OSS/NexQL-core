import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../../providers/DatabaseTreeProvider';
import { DatabaseTreeProvider } from '../../providers/DatabaseTreeProvider';
import { CommandBase } from '../../common/commands/CommandBase';
import {
  MarkdownUtils,
  ErrorHandlers,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder
} from '../helper';
import { TableSQL } from '../sql';
import { queryServerVersionNum } from '../../lib/postgresServerVersion';

export async function cmdTableOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create table operations notebook', async (conn, client, metadata) => {
    const [columnsResult, constraintsResult] = await Promise.all([
      client.query(QueryBuilder.tableColumns(item.schema!, item.label)),
      client.query(QueryBuilder.tableConstraintDefinitions(item.schema!, item.label))
    ]);
    const tableDefinition = buildTableDefinition(item.schema!, item.label, columnsResult.rows, constraintsResult.rows);

    const notebook = new NotebookBuilder(metadata)
      .addMarkdown(`### 📊 Table Operations: \`${item.schema}.${item.label}\`\n\nCommon operations for the \`${item.schema}.${item.label}\` table.`)
      // Read operations
      .addMarkdown('##### Table Definition')
      .addSql(`-- Table definition\n${tableDefinition}`)
      .addMarkdown('##### SELECT')
      .addSql(TableSQL.select(item.schema!, item.label))
      // Write/modify operations
      .addMarkdown('##### INSERT')
      .addSql(TableSQL.insert(item.schema!, item.label))
      .addMarkdown('##### UPDATE')
      .addSql(TableSQL.update(item.schema!, item.label))
      // Destructive operations
      .addMarkdown('##### DELETE\n\n⚠️ Warning: This operation modifies or removes data permanently.')
      .addSql(TableSQL.delete(item.schema!, item.label))
      .addMarkdown('##### TRUNCATE\n\n⚠️ Warning: This operation removes all rows permanently and cannot be filtered.')
      .addSql(TableSQL.truncate(item.schema!, item.label))
      .addMarkdown('##### DROP\n\n⚠️ Warning: This operation permanently deletes the table and all its data.')
      .addSql(TableSQL.drop(item.schema!, item.label));

    await notebook.show();
  });
}

export async function cmdEditTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create table edit notebook', async (conn, client, metadata) => {
    const [columnsResult, constraintsResult] = await Promise.all([
      client.query(QueryBuilder.tableColumns(item.schema!, item.label)),
      client.query(QueryBuilder.tableConstraintDefinitions(item.schema!, item.label))
    ]);
    const tableDefinition = buildTableDefinition(item.schema!, item.label, columnsResult.rows, constraintsResult.rows);

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Edit Table: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('Modify the table definition below and execute the cell to update the table structure. This will create a new table.')
      )
      .addMarkdown('##### 📝 Table Definition')
      .addSql(tableDefinition)
      .show();
  });
}

export async function cmdInsertTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create insert notebook', async (conn, client, metadata) => {
    const result = await client.query(QueryBuilder.columns(item.schema!, item.label));
    const columns = result.rows.map((col: any) => col.column_name);
    const placeholders = result.rows.map((col: any) => {
      if (col.column_default) {
        return `DEFAULT`;
      }
      switch (col.data_type.toLowerCase()) {
        case 'text':
        case 'character varying':
        case 'varchar':
        case 'char':
        case 'uuid':
        case 'date':
        case 'timestamp':
        case 'timestamptz':
          return `'value'`;
        case 'integer':
        case 'bigint':
        case 'smallint':
        case 'decimal':
        case 'numeric':
        case 'real':
        case 'double precision':
          return '0';
        case 'boolean':
          return 'false';
        case 'json':
        case 'jsonb':
          return `'{}'`;
        default:
          return 'NULL';
      }
    });

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Insert Data: \`${item.schema}.${item.label}\`\n\nInsert a new row into the \`${item.schema}.${item.label}\` table.`)
      .addMarkdown('##### INSERT')
      .addSql(`-- Insert single row\nINSERT INTO ${item.schema}.${item.label} (\n    ${columns.join(',\n    ')}\n)\nVALUES (\n    ${placeholders.join(',\n    ')}\n)\nRETURNING *;\n\n-- Insert multiple rows (example)\n/*\nINSERT INTO ${item.schema}.${item.label} (\n    ${columns.join(',\n    ')}\n)\nVALUES\n    (${placeholders.join(', ')}),\n    (${placeholders.join(', ')})\nRETURNING *;\n*/`)
      .show();
  });
}

export async function cmdUpdateTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create update notebook', async (conn, client, metadata) => {
    const [columnsResult, constraintsResult] = await Promise.all([
      client.query(QueryBuilder.columns(item.schema!, item.label)),
      client.query(QueryBuilder.tableConstraints(item.schema!, item.label))
    ]);

    const pkConstraint = constraintsResult.rows.find((c: any) => c.constraint_type === 'PRIMARY KEY');
    const pkColumns = pkConstraint ? pkConstraint.columns.split(', ') : [];
    const whereClause = pkColumns.length > 0 ?
      `WHERE ${pkColumns.map((col: any) => `${col} = value`).join(' AND ')}` :
      '-- Add your WHERE clause here to identify rows to update';

    const updateCaseExample = columnsResult.rows.map((col: any) => {
      const isText = col.data_type.toLowerCase().includes('char') || col.data_type.toLowerCase() === 'text';
      const value = isText ? "'new_value'" : "0";
      return `${col.column_name} = CASE \n        WHEN condition THEN ${value}\n        ELSE ${col.column_name}\n    END`;
    }).join(',\n    ');

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ✏️ Update Data: \`${item.schema}.${item.label}\`\n\nUpdate rows in the \`${item.schema}.${item.label}\` table.`)
      .addMarkdown('##### UPDATE')
      .addSql(`-- Update data\nUPDATE ${item.schema}.${item.label}\nSET\n    -- List columns to update:\n    column_name = new_value\n${whereClause}\nRETURNING *;\n\n-- Example of updating multiple columns with CASE\n/*\nUPDATE ${item.schema}.${item.label}\nSET\n    ${updateCaseExample}\n${whereClause}\nRETURNING *;\n*/`)
      .show();
  });
}

export async function cmdViewTableData(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create view data notebook', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`View Table Data: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('Modify the query below to filter or transform the data as needed.')
      )
      .addMarkdown('##### 📖 Query Data')
      .addSql(`-- View table data\nSELECT *\nFROM ${item.schema}.${item.label}\nLIMIT 100;`)
      .show();
  });
}

export async function cmdDropTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create drop table notebook', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(`### ❌ Drop Table: \`${item.schema}.${item.label}\`\n\nPermanently delete the \`${item.schema}.${item.label}\` table.`)
      .addMarkdown('##### Check Dependencies')
      .addSql(QueryBuilder.objectDependencies(item.schema!, item.label))
      .addMarkdown('##### DROP\n\n⚠️ Warning: This operation permanently deletes the table and all its data.')
      .addSql(TableSQL.drop(item.schema!, item.label))
      .show();
  });
}

export async function cmdTruncateTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create truncate notebook', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🧹 Truncate Table: \`${item.schema}.${item.label}\`\n\nRemove all rows from the \`${item.schema}.${item.label}\` table.`)
      .addMarkdown('##### TRUNCATE\n\n⚠️ Warning: This operation removes all rows permanently and cannot be filtered.')
      .addSql(TableSQL.truncate(item.schema!, item.label))
      .show();
  });
}

export async function cmdShowTableProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'view table properties', async (conn, client, metadata) => {
    const serverVersionNum = await queryServerVersionNum(client);
    // Gather comprehensive table information
    const [tableInfo, columnInfo, constraintInfo, indexInfo, statsInfo, sizeInfo] = await Promise.all([
      client.query(QueryBuilder.tableInfo(item.schema!, item.label, serverVersionNum)),
      client.query(QueryBuilder.tableColumns(item.schema!, item.label)),
      client.query(QueryBuilder.tableConstraints(item.schema!, item.label)),
      client.query(QueryBuilder.tableIndexes(item.schema!, item.label)),
      client.query(QueryBuilder.tableStats(item.schema!, item.label)),
      client.query(QueryBuilder.tableSize(item.schema!, item.label))
    ]);

    const table = tableInfo.rows[0];
    const columns = columnInfo.rows;
    const constraints = constraintInfo.rows;
    const indexes = indexInfo.rows;
    const stats = statsInfo.rows[0] || {};
    const sizes = sizeInfo.rows[0];



    // Build CREATE TABLE script
    const columnDefs = columns.map((col: any) => {
      // Check if column uses a sequence (auto-increment)
      const hasSequence = col.column_default && col.column_default.includes('nextval(');

      // Build proper data type
      let dataType = col.data_type;

      // Convert integer types with sequences to serial types
      if (hasSequence) {
        if (col.data_type === 'integer') {
          dataType = 'serial';
        } else if (col.data_type === 'bigint') {
          dataType = 'bigserial';
        } else if (col.data_type === 'smallint') {
          dataType = 'smallserial';
        }
      } else if (col.character_maximum_length && (col.data_type === 'character varying' || col.data_type === 'character' || col.data_type === 'varchar' || col.data_type === 'char')) {
        dataType = `${col.data_type}(${col.character_maximum_length})`;
      } else if (col.numeric_precision && (col.data_type === 'numeric' || col.data_type === 'decimal')) {
        dataType = `${col.data_type}(${col.numeric_precision}${col.numeric_scale ? ',' + col.numeric_scale : ''})`;
      }

      let colDef = `    ${col.column_name} ${dataType}`;

      // For serial types, NOT NULL is implicit, don't add DEFAULT
      if (hasSequence && (dataType === 'serial' || dataType === 'bigserial' || dataType === 'smallserial')) {
        // NOT NULL is automatic for serial types
      } else {
        if (col.is_nullable === 'NO') colDef += ' NOT NULL';
        if (col.column_default) colDef += ` DEFAULT ${col.column_default}`;
      }

      return colDef;
    }).join(',\n');

    // Build constraint definitions
    const constraintDefs = constraints.map((c: any) => {
      if (c.constraint_type === 'PRIMARY KEY') {
        return `    CONSTRAINT ${c.constraint_name} PRIMARY KEY (${c.columns})`;
      } else if (c.constraint_type === 'FOREIGN KEY') {
        return `    CONSTRAINT ${c.constraint_name} FOREIGN KEY (${c.columns}) REFERENCES ${c.referenced_table}`;
      } else if (c.constraint_type === 'UNIQUE') {
        return `    CONSTRAINT ${c.constraint_name} UNIQUE (${c.columns})`;
      }
      return null;
    }).filter((c: any) => c !== null);

    const createTableScript = `-- DROP TABLE IF EXISTS ${item.schema}.${item.label};

CREATE TABLE ${item.schema}.${item.label} (
${columnDefs}${constraintDefs.length > 0 ? ',\n' + constraintDefs.join(',\n') : ''}
);

-- Table comment
${table.comment ? `COMMENT ON TABLE ${item.schema}.${item.label} IS '${table.comment.replace(/'/g, "''")}';` : `-- COMMENT ON TABLE ${item.schema}.${item.label} IS 'table description';`}

-- Indexes
${indexes.map((idx: any) => idx.definition).join('\n')}`;

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
        <td>${col.is_nullable === 'YES' ? '✅' : '🚫'}</td>
        <td>${col.column_default ? `<code>${col.column_default}</code>` : '—'}</td>
    </tr>`;
    }).join('\n');

    // Build constraints HTML
    const constraintRows = constraints.map((c: any) => {
      const icon = c.constraint_type === 'PRIMARY KEY' ? '🔑' :
        c.constraint_type === 'FOREIGN KEY' ? '🔗' :
          c.constraint_type === 'UNIQUE' ? '⭐' : '✓';
      const ref = c.referenced_table ? ` → ${c.referenced_table}` : '';
      return `    <tr>
        <td>${icon} ${c.constraint_type}</td>
        <td><code>${c.constraint_name}</code></td>
        <td>${c.columns || ''}</td>
        <td>${c.referenced_table || '—'}</td>
    </tr>`;
    }).join('\n');

    // Build indexes HTML
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

    // Build maintenance history rows
    const maintenanceRows = [];
    if (stats.last_vacuum) {
      maintenanceRows.push(`    <tr>
        <td>Manual VACUUM</td>
        <td>${new Date(stats.last_vacuum).toLocaleString()}</td>
        <td>${stats.vacuum_count || 0}</td>
    </tr>`);
    }
    if (stats.last_autovacuum) {
      maintenanceRows.push(`    <tr>
        <td>Auto VACUUM</td>
        <td>${new Date(stats.last_autovacuum).toLocaleString()}</td>
        <td>${stats.autovacuum_count || 0}</td>
    </tr>`);
    }
    if (stats.last_analyze) {
      maintenanceRows.push(`    <tr>
        <td>Manual ANALYZE</td>
        <td>${new Date(stats.last_analyze).toLocaleString()}</td>
        <td>${stats.analyze_count || 0}</td>
    </tr>`);
    }
    if (stats.last_autoanalyze) {
      maintenanceRows.push(`    <tr>
        <td>Auto ANALYZE</td>
        <td>${new Date(stats.last_autoanalyze).toLocaleString()}</td>
        <td>${stats.autoanalyze_count || 0}</td>
    </tr>`);
    }

    const markdown = `### 📊 Table Properties: \`${item.schema}.${item.label}\`

<div style="font-size: 12px; background-color: rgba(52, 152, 219, 0.1); border-left: 3px solid #3498db; padding: 6px 10px; margin-bottom: 15px; border-radius: 3px; color: var(--vscode-editor-foreground);">
    <strong>ℹ️ Owner:</strong> ${table.owner} ${table.comment ? `| <strong>Comment:</strong> ${table.comment}` : ''}
</div>

#### 💾 Size & Statistics

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left; width: 30%;">Metric</th><th style="text-align: left;">Value</th></tr>
    <tr><td><strong>Total Size</strong></td><td>${sizes.total_size}</td></tr>
    <tr><td><strong>Table Size</strong></td><td>${sizes.table_size}</td></tr>
    <tr><td><strong>Indexes Size</strong></td><td>${sizes.indexes_size}</td></tr>
    <tr><td><strong>TOAST Size</strong></td><td>${sizes.toast_size}</td></tr>
    <tr><td><strong>Row Estimate</strong></td><td>${table.row_estimate?.toLocaleString() || 'N/A'}</td></tr>
    <tr><td><strong>Live Tuples</strong></td><td>${stats.live_tuples?.toLocaleString() || 'N/A'}</td></tr>
    <tr><td><strong>Dead Tuples</strong></td><td>${stats.dead_tuples?.toLocaleString() || 'N/A'}</td></tr>
</table>

#### 📋 Columns (${columns.length})

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 5%;">#</th>
        <th style="text-align: left; width: 25%;">Name</th>
        <th style="text-align: left; width: 25%;">Data Type</th>
        <th style="text-align: left; width: 10%;">Nullable</th>
        <th style="text-align: left;">Default</th>
    </tr>
${columnRows}
</table>

${constraints.length > 0 ? `#### 🔒 Constraints (${constraints.length})

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 20%;">Type</th>
        <th style="text-align: left; width: 30%;">Name</th>
        <th style="text-align: left; width: 25%;">Columns</th>
        <th style="text-align: left;">References</th>
    </tr>
${constraintRows}
</table>

` : ''}${indexes.length > 0 ? `#### 🔍 Indexes (${indexes.length})

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left; width: 35%;">Index Name</th>
        <th style="text-align: left; width: 40%;">Columns</th>
        <th style="text-align: left;">Size</th>
    </tr>
${indexRows}
</table>

` : ''}${maintenanceRows.length > 0 ? `#### 🧹 Maintenance History

<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr>
        <th style="text-align: left;">Operation</th>
        <th style="text-align: left;">Last Run</th>
        <th style="text-align: left;">Count</th>
    </tr>
${maintenanceRows.join('\n')}
</table>

` : ''}---`;

    const notebook = new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📊 Table Properties: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('Detailed information about the table structure, constraints, indexes, and statistics.')
      )
      .addMarkdown(
        `#### 📋 General Information\n\n` +
        MarkdownUtils.propertiesTable({
          'Owner': table.owner,
          'Row Estimate': table.row_estimate,
          'Total Size': sizes.total_size,
          'Table Size': sizes.table_size,
          'Index Size': sizes.indexes_size,
          'Toast Size': sizes.toast_size,
          'Comment': table.comment || '—'
        })
      )
      .addMarkdown(
        `#### 🏗️ Columns\n\n` +
        `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left;">#</th><th style="text-align: left;">Name</th><th style="text-align: left;">Type</th><th style="text-align: left;">Nullable</th><th style="text-align: left;">Default</th></tr>
${columnRows}
</table>`
      )
      .addMarkdown(
        `#### 🔒 Constraints\n\n` +
        (constraints.length > 0 ?
          `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left;">Type</th><th style="text-align: left;">Name</th><th style="text-align: left;">Columns</th><th style="text-align: left;">Reference</th></tr>
${constraintRows}
</table>` : '_No constraints defined_')
      )
      .addMarkdown(
        `#### 🔍 Indexes\n\n` +
        (indexes.length > 0 ?
          `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left;">Name</th><th style="text-align: left;">Columns</th><th style="text-align: left;">Size</th></tr>
${indexRows}
</table>` : '_No indexes defined_')
      )
      .addMarkdown(
        `#### 📈 Statistics & Maintenance\n\n` +
        MarkdownUtils.propertiesTable({
          'Live Tuples': stats.live_tuples || '0',
          'Dead Tuples': stats.dead_tuples || '0',
          'Modifications': stats.modifications_since_analyze || '0'
        }) +
        (maintenanceRows.length > 0 ?
          `\n\n**Maintenance History**\n` +
          `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left;">Operation</th><th style="text-align: left;">Last Run</th><th style="text-align: left;">Count</th></tr>
${maintenanceRows.join('\n')}
</table>` : '')
      )
      .addMarkdown('##### 📝 CREATE TABLE Script')
      .addSql(createTableScript)
      .addMarkdown('##### 🗑️ DROP TABLE Script')
      .addSql(`-- Drop table (with dependencies)\nDROP TABLE IF EXISTS ${item.schema}.${item.label} CASCADE;\n\n-- Drop table (without dependencies - will fail if referenced)\n-- DROP TABLE IF EXISTS ${item.schema}.${item.label} RESTRICT;`)
      .addMarkdown('##### 🔍 Query Table Data')
      .addSql(`-- Select all data\nSELECT * FROM ${item.schema}.${item.label}\nLIMIT 100;`)
      .addMarkdown('##### 📊 Detailed Statistics')
      .addSql(`-- Table bloat and statistics
SELECT 
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) as dead_tuple_percent,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = '${item.schema}' AND relname = '${item.label}';

-- Column statistics
SELECT 
    attname as column_name,
    n_distinct,
    ROUND((null_frac * 100)::numeric, 2) as null_percentage,
    avg_width,
    correlation
FROM pg_stats
WHERE schemaname = '${item.schema}' AND tablename = '${item.label}'
ORDER BY attname;`);

    await notebook.show();
  });
}

export function buildTableDefinition(schema: string, tableName: string, columns: any[], constraints: any[]): string {
  const columnDefs = columns.map((col: any) => {
    let def = `    ${col.column_name} ${col.data_type}`;
    if (col.character_maximum_length) def += `(${col.character_maximum_length})`;
    else if (col.numeric_precision) def += `(${col.numeric_precision}${col.numeric_scale ? ',' + col.numeric_scale : ''})`;

    if (col.is_nullable === 'NO') def += ' NOT NULL';
    if (col.column_default) def += ` DEFAULT ${col.column_default}`;
    return def;
  }).join(',\n');

  const constraintDefs = constraints.map((c: any) => `    CONSTRAINT ${c.constraint_name} ${c.definition}`).join(',\n');

  return `CREATE TABLE ${schema}.${tableName} (\n${columnDefs}${constraintDefs ? ',\n' + constraintDefs : ''}\n);`;
}

export async function cmdRefreshTable(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider) {
  databaseTreeProvider?.refresh(item);
}

/**
 * cmdCreateTable - Command to create a new table in the database.
 */
export async function cmdCreateTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create table notebook', async (conn, client, metadata) => {
    const schema = item.schema!;

    const markdown = MarkdownUtils.header(`➕ Create New Table in Schema: \`${schema}\``) +
      MarkdownUtils.infoBox('This notebook provides templates for creating tables. Choose the template that best fits your use case.') +
      `\n\n#### 📋 Table Design Guidelines\n\n` +
      MarkdownUtils.operationsTable([
        { operation: '<strong>Naming</strong>', description: 'Use snake_case for table names (e.g., user_accounts, order_items)' },
        { operation: '<strong>Primary Key</strong>', description: 'Every table should have a primary key. Use SERIAL/BIGSERIAL or UUID' },
        { operation: '<strong>Timestamps</strong>', description: 'Include created_at and updated_at for audit trails' },
        { operation: '<strong>Constraints</strong>', description: 'Add NOT NULL, UNIQUE, CHECK constraints to enforce data integrity' },
        { operation: '<strong>Foreign Keys</strong>', description: 'Reference related tables with ON DELETE/UPDATE actions' }
      ]) +
      `\n\n#### 🏷️ Common Data Types Reference\n\n` +
      MarkdownUtils.propertiesTable({
        'SERIAL / BIGSERIAL': 'Auto-incrementing integer (4/8 bytes)',
        'UUID': 'Universally unique identifier (use gen_random_uuid())',
        'VARCHAR(n) / TEXT': 'Variable-length character strings',
        'INTEGER / BIGINT': 'Whole numbers (4/8 bytes)',
        'NUMERIC(p,s)': 'Exact decimal numbers for money/precision',
        'BOOLEAN': 'true/false values',
        'TIMESTAMPTZ': 'Timestamp with timezone (recommended)',
        'DATE / TIME': 'Date or time only',
        'JSONB': 'Binary JSON for flexible schema data',
        'ARRAY': 'Array of any type (e.g., TEXT[], INTEGER[])'
      }) +
      MarkdownUtils.successBox('Use TIMESTAMPTZ instead of TIMESTAMP for timezone-aware applications.') +
      `\n\n---`;

    await new NotebookBuilder(metadata)
      .addMarkdown(markdown)
      .addMarkdown(`##### 📝 Basic Table (Recommended Start)`)
      .addSql(`-- Create basic table with common patterns
CREATE TABLE ${schema}.table_name (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);

-- Add table comment
COMMENT ON TABLE ${schema}.table_name IS 'Description of what this table stores';`)
      .addMarkdown(`##### 🔑 Table with UUID Primary Key`)
      .addSql(`-- Table using UUID as primary key (better for distributed systems)
CREATE TABLE ${schema}.table_name (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);`)
      .addMarkdown(`##### 🔗 Table with Foreign Key References`)
      .addSql(`-- Table with foreign key relationships
CREATE TABLE ${schema}.order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES ${schema}.orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES ${schema}.products(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index on foreign key columns for better join performance
CREATE INDEX idx_order_items_order_id ON ${schema}.order_items(order_id);
CREATE INDEX idx_order_items_product_id ON ${schema}.order_items(product_id);`)
      .addMarkdown(`##### ⭐ Table with Unique Constraints`)
      .addSql(`-- Table with unique constraints
CREATE TABLE ${schema}.users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    username VARCHAR(50) NOT NULL,
    display_name VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Unique constraints
    CONSTRAINT users_email_unique UNIQUE (email),
    CONSTRAINT users_username_unique UNIQUE (username)
);

-- Partial unique index (unique only for non-deleted)
-- CREATE UNIQUE INDEX users_email_active_unique 
-- ON ${schema}.users(email) WHERE deleted_at IS NULL;`)
      .addMarkdown(`##### ✓ Table with CHECK Constraints`)
      .addSql(`-- Table with validation constraints
CREATE TABLE ${schema}.products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(50) NOT NULL UNIQUE,
    price NUMERIC(10,2) NOT NULL,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    weight_kg NUMERIC(6,3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Check constraints
    CONSTRAINT products_price_positive CHECK (price >= 0),
    CONSTRAINT products_stock_non_negative CHECK (stock_quantity >= 0),
    CONSTRAINT products_status_valid CHECK (status IN ('draft', 'active', 'discontinued', 'archived')),
    CONSTRAINT products_weight_positive CHECK (weight_kg IS NULL OR weight_kg > 0)
);`)
      .addMarkdown(`##### 📄 Table with JSONB Column`)
      .addSql(`-- Table with JSONB for flexible/dynamic data
CREATE TABLE ${schema}.events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create GIN index for efficient JSONB queries
CREATE INDEX idx_events_payload ON ${schema}.events USING GIN (payload);

-- Query examples:
-- SELECT * FROM events WHERE payload->>'user_id' = '123';
-- SELECT * FROM events WHERE payload @> '{"status": "completed"}';`)
      .addMarkdown(`##### 🕐 Table with Soft Delete Pattern`)
      .addSql(`-- Table with soft delete (keeps data, marks as deleted)
CREATE TABLE ${schema}.documents (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    created_by INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ  -- NULL = active, timestamp = deleted
);

-- Partial index for efficient queries on active records
CREATE INDEX idx_documents_active ON ${schema}.documents(created_at) 
WHERE deleted_at IS NULL;

-- View for only active documents
CREATE VIEW ${schema}.active_documents AS
SELECT * FROM ${schema}.documents WHERE deleted_at IS NULL;`)
      .addMarkdown(`##### 📊 Table with Composite Primary Key`)
      .addSql(`-- Many-to-many junction table with composite key
CREATE TABLE ${schema}.user_roles (
    user_id INTEGER NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES ${schema}.roles(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by INTEGER REFERENCES ${schema}.users(id),
    
    -- Composite primary key
    PRIMARY KEY (user_id, role_id)
);

-- Indexes for reverse lookups
CREATE INDEX idx_user_roles_role_id ON ${schema}.user_roles(role_id);`)
      .addMarkdown(`##### 📅 Partitioned Table (for large datasets)`)
      .addSql(`-- Partitioned table by date range (for time-series data)
CREATE TABLE ${schema}.logs (
    id BIGSERIAL,
    log_level VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    context JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create partitions for each month
CREATE TABLE ${schema}.logs_2024_01 PARTITION OF ${schema}.logs
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
    
CREATE TABLE ${schema}.logs_2024_02 PARTITION OF ${schema}.logs
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Create index on partitioned table
CREATE INDEX idx_logs_created_at ON ${schema}.logs(created_at);`)
      .addMarkdown(MarkdownUtils.warningBox('After creating a table, remember to: 1) Add appropriate indexes for query patterns, 2) Set up foreign key relationships, 3) Grant necessary permissions to roles.'))
      .show();
  });
}

export async function cmdQuickCloneTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create quick clone notebook', async (conn, client, metadata) => {
    const schema = item.schema!;
    const table = item.label!;
    const newTableName = `${table}_copy`;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`👯 Quick Clone: \`${schema}.${table}\``) +
        MarkdownUtils.infoBox('This script creates a complete copy of the table structure (including indexes and constraints) and data.') +
        `\n\n#### 📝 Naming Collision\n\n` +
        MarkdownUtils.warningBox(`The script uses \`${newTableName}\` as the new table name. If this name already exists, the script will fail. Change the name in the script if needed.`)
      )
      .addMarkdown('##### 📋 Clone Structure & Data')
      .addSql(`-- 1. Create new table with same structure (indexes, constraints, defaults)
CREATE TABLE ${schema}.${newTableName} (LIKE ${schema}.${table} INCLUDING ALL);

-- 2. Copy all data
INSERT INTO ${schema}.${newTableName} 
SELECT * FROM ${schema}.${table};

-- 3. (Optional) Reset sequences if needed
-- If the original table used a sequence, the new table might point to the same sequence or need a new one.
-- 'INCLUDING ALL' copies defaults, so if default is nextval('seq'), both tables share the sequence.
-- You might want to create a new sequence for the copy.
`)
      .show();
  });
}
