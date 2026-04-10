import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';

import {
  MarkdownUtils,
  ValidationHelpers,
  ErrorHandlers,
  SQL_TEMPLATES,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder
} from './helper';
import { ColumnSQL } from './sql';

export async function showColumnProperties(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { client, metadata } = dbConn;
    const schema = item.schema!;
    const tableName = item.tableName!;
    const columnName = item.columnName!;

    const result = await client.query(QueryBuilder.columnDetails(schema, tableName, columnName));

    if (result.rows.length === 0) {
      vscode.window.showErrorMessage('Column not found');
      return;
    }

    const col = result.rows[0];

    const dataTypeDetails = col.character_maximum_length
      ? `${col.data_type}(${col.character_maximum_length})`
      : col.numeric_precision
        ? `${col.data_type}(${col.numeric_precision}${col.numeric_scale ? ',' + col.numeric_scale : ''})`
        : col.data_type;

    const constraints = [];
    if (col.is_primary_key) constraints.push('🔑 PRIMARY KEY');
    if (col.is_foreign_key) constraints.push(`🔗 FOREIGN KEY → ${col.foreign_table_schema}.${col.foreign_table_name}.${col.foreign_column_name}`);
    if (col.is_unique) constraints.push('⭐ UNIQUE');
    if (col.is_nullable === 'NO') constraints.push('🚫 NOT NULL');

    const nb = new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📋 Column Properties: \`${col.column_name}\``) +
        MarkdownUtils.infoBox(`Table: \`${item.schema}.${tableName}\``) +
        `\n\n#### 📊 Basic Information\n\n` +
        MarkdownUtils.propertiesTable({
          'Column Name': `<code>${col.column_name}</code>`,
          'Data Type': `<code>${dataTypeDetails}</code>`,
          'UDT Name': `<code>${col.udt_name}</code>`,
          'Position': `${col.ordinal_position}`,
          'Nullable': col.is_nullable === 'YES' ? 'Yes' : 'No',
          'Default Value': col.column_default ? `<code>${col.column_default}</code>` : '—'
        })
      );

    if (constraints.length > 0) {
      nb.addMarkdown(`#### 🔒 Constraints\n\n${constraints.map(c => `- ${c}`).join('\n')}`);
    }

    if (col.column_comment) {
      nb.addMarkdown(`#### 💬 Comment\n\n\`\`\`\n${col.column_comment}\n\`\`\``);
    }

    nb.addMarkdown('##### 📖 Query Column')
      .addSql(ColumnSQL.select(item.schema!, tableName, columnName));

    await nb.show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'get column properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function copyColumnName(item: DatabaseTreeItem) {
  const columnName = item.columnName!;
  await vscode.env.clipboard.writeText(columnName);
  vscode.window.showInformationMessage(`Copied: ${columnName}`);
}

export async function copyColumnNameQuoted(item: DatabaseTreeItem) {
  const columnName = item.columnName!;
  await vscode.env.clipboard.writeText(`"${columnName}"`);
  vscode.window.showInformationMessage(`Copied: "${columnName}"`);
}

export async function generateSelectStatement(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 📖 SELECT Statement: \`${columnName}\`\n\nQuery specific column from \`${item.schema}.${tableName}\`.`)
      .addSql(ColumnSQL.select(item.schema!, tableName, columnName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate SELECT statement');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function generateWhereClause(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🔍 WHERE Clause: \`${columnName}\`\n\nFilter rows by \`${columnName}\` in \`${item.schema}.${tableName}\`.`)
      .addSql(`-- Filter by column value
SELECT *
FROM ${item.schema}.${tableName}
WHERE ${columnName} = 'value';

-- Use IS NULL / IS NOT NULL to filter nulls
-- SELECT * FROM ${item.schema}.${tableName} WHERE ${columnName} IS NULL;
-- SELECT * FROM ${item.schema}.${tableName} WHERE ${columnName} IS NOT NULL;

-- Use LIKE for pattern matching (text columns)
-- SELECT * FROM ${item.schema}.${tableName} WHERE ${columnName} LIKE '%pattern%';

-- Use BETWEEN for range filtering
-- SELECT * FROM ${item.schema}.${tableName} WHERE ${columnName} BETWEEN 'a' AND 'z';

-- Use IN for multiple values
-- SELECT * FROM ${item.schema}.${tableName} WHERE ${columnName} IN ('val1', 'val2');`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate WHERE clause');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function generateAlterColumnScript(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ✏️ ALTER COLUMN Script: \`${columnName}\`\n\nModify column structure in \`${item.schema}.${tableName}\`.`)
      .addSql(ColumnSQL.alter(item.schema!, tableName, columnName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate ALTER COLUMN script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function generateDropColumnScript(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🗑️ DROP COLUMN Script: \`${columnName}\`\n\n⚠️ **Danger:** This permanently deletes the column and all its data. This cannot be undone.`)
      .addSql(ColumnSQL.drop(item.schema!, tableName, columnName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate DROP COLUMN script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function generateRenameColumnScript(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new column name',
      value: columnName,
      validateInput: ValidationHelpers.validateColumnName
    });

    if (!newName || newName === columnName) {
      return;
    }

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🔄 RENAME COLUMN: \`${columnName}\` → \`${newName}\`\n\nRename column in \`${item.schema}.${tableName}\`.`)
      .addSql(ColumnSQL.rename(item.schema!, tableName, columnName, newName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate RENAME COLUMN script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function addColumnComment(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    const comment = await vscode.window.showInputBox({
      prompt: `Enter comment for column ${columnName}`,
      placeHolder: 'Column description...'
    });

    if (comment === undefined) {
      return;
    }

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 💬 Add Column Comment: \`${columnName}\`\n\nSet a comment on column \`${item.schema}.${tableName}.${columnName}\`.`)
      .addSql(`-- Add/update comment for column ${columnName}
${SQL_TEMPLATES.COMMENT.COLUMN(item.schema!, tableName, columnName, comment)}

-- To remove a comment, use:
-- COMMENT ON COLUMN ${item.schema}.${tableName}.${columnName} IS NULL;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate comment script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function generateIndexOnColumn(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    const indexName = await vscode.window.showInputBox({
      prompt: 'Enter index name',
      value: `idx_${tableName}_${columnName}`,
      validateInput: (value) => ValidationHelpers.validateIdentifier(value, 'index')
    });

    if (!indexName) {
      return;
    }

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🔍 CREATE INDEX: \`${indexName}\`\n\nCreate an index on \`${item.schema}.${tableName}.${columnName}\`.`)
      .addSql(ColumnSQL.createIndex(item.schema!, tableName, columnName, indexName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate CREATE INDEX script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function viewColumnStatistics(item: DatabaseTreeItem) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const columnName = item.columnName!;
    const tableName = item.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 📊 Column Statistics: \`${columnName}\`\n\nQuery planner statistics for \`${item.schema}.${tableName}.${columnName}\`.`)
      .addSql(`-- Column statistics from pg_stats
SELECT
    n_distinct,
    null_frac,
    avg_width,
    correlation,
    most_common_vals,
    most_common_freqs
FROM pg_stats
WHERE schemaname = '${item.schema}'
  AND tablename = '${tableName}'
  AND attname = '${columnName}';

-- Run ANALYZE to refresh statistics if missing
-- ANALYZE ${item.schema}.${tableName};`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'view column statistics');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Add new column to table
 */
export async function cmdAddColumn(item: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const schema = item.schema!;
    const tableName = item.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Add Column to \`${schema}.${tableName}\`\n\nAdd a new column using the template below.`)
      .addSql(`-- Add a new column
ALTER TABLE ${schema}.${tableName}
    ADD COLUMN column_name data_type;

-- Use NOT NULL with a DEFAULT to avoid locking on large tables
-- ALTER TABLE ${schema}.${tableName}
--     ADD COLUMN column_name data_type NOT NULL DEFAULT default_value;

-- Use IF NOT EXISTS to suppress error if column already exists
-- ALTER TABLE ${schema}.${tableName}
--     ADD COLUMN IF NOT EXISTS column_name data_type;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'add column');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}
