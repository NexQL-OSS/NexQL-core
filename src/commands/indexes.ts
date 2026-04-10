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
import { IndexSQL } from './sql';

/**
 * Show index properties in a notebook
 */
export async function showIndexProperties(treeItem: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(treeItem);
    const { client, metadata } = dbConn;

    const schema = treeItem.schema!;
    const tableName = treeItem.tableName!;
    const indexName = treeItem.label;

    // Get detailed index information
    const result = await client.query(`
            SELECT 
                i.relname as index_name,
                ix.indisunique as is_unique,
                ix.indisprimary as is_primary,
                ix.indisclustered as is_clustered,
                ix.indisvalid as is_valid,
                ix.indisready as is_ready,
                ix.indislive as is_live,
                am.amname as access_method,
                pg_size_pretty(pg_relation_size(i.oid)) as index_size,
                pg_relation_size(i.oid) as index_size_bytes,
                pg_get_indexdef(ix.indexrelid) as index_definition,
                obj_description(i.oid) as comment,
                t.reltuples::bigint as estimated_rows,
                string_agg(a.attname, ', ' ORDER BY array_position(ix.indkey, a.attnum)) as columns
            FROM pg_index ix
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_class t ON t.oid = ix.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_am am ON am.oid = i.relam
            LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
            WHERE i.relname = $1
                AND n.nspname = $2
                AND t.relname = $3
            GROUP BY i.relname, ix.indisunique, ix.indisprimary, ix.indisclustered, ix.indisvalid,
                     ix.indisready, ix.indislive, am.amname, i.oid, ix.indexrelid, t.reltuples
        `, [indexName, schema, tableName]);

    if (result.rows.length === 0) {
      vscode.window.showErrorMessage('Index not found');
      return;
    }

    const idx = result.rows[0];

    // Get index statistics - combining pg_stat and pg_statio views
    const statsResult = await client.query(`
            SELECT 
                s.idx_scan as scans,
                s.idx_tup_read as tuples_read,
                s.idx_tup_fetch as tuples_fetched,
                COALESCE(io.idx_blks_hit, 0) as cache_hits,
                COALESCE(io.idx_blks_read, 0) as disk_reads,
                CASE 
                    WHEN (COALESCE(io.idx_blks_hit, 0) + COALESCE(io.idx_blks_read, 0)) = 0 THEN 0
                    ELSE ROUND(100.0 * io.idx_blks_hit / (io.idx_blks_hit + io.idx_blks_read), 2)
                END as cache_hit_ratio
            FROM pg_stat_user_indexes s
            LEFT JOIN pg_statio_user_indexes io 
                ON s.indexrelid = io.indexrelid
            WHERE s.indexrelname = $1
                AND s.schemaname = $2
                AND s.relname = $3
        `, [indexName, schema, tableName]);

    const stats = statsResult.rows[0] || {};

    // Build index type icon
    const typeIcon = ObjectUtils.getIndexIcon(idx.is_primary, idx.is_unique);

    const attributes = [];
    if (idx.is_primary) attributes.push('🔑 PRIMARY KEY');
    if (idx.is_unique && !idx.is_primary) attributes.push('⭐ UNIQUE');
    if (idx.is_clustered) attributes.push('📍 CLUSTERED');
    if (!idx.is_valid) attributes.push('⚠️ INVALID');
    if (!idx.is_ready) attributes.push('⏳ NOT READY');

    let markdown = MarkdownUtils.header(`${typeIcon} Index Properties: \`${indexName}\``) +
      MarkdownUtils.infoBox(`Index on table <strong>${schema}.${tableName}</strong>`) +
      '\n\n#### 📊 Index Statistics\n\n' +
      MarkdownUtils.propertiesTable({
        'Access Method': idx.access_method.toUpperCase(),
        'Size': idx.index_size,
        'Columns': idx.columns,
        'Scans': FormatHelpers.formatNumber(stats.scans || 0),
        'Tuples Read': FormatHelpers.formatNumber(stats.tuples_read || 0),
        'Tuples Fetched': FormatHelpers.formatNumber(stats.tuples_fetched || 0),
        'Cache Hit Ratio': FormatHelpers.formatPercentage(stats.cache_hit_ratio || 0),
        'Estimated Rows': FormatHelpers.formatNumber(idx.estimated_rows || 0)
      });

    if (attributes.length > 0) {
      markdown += '\n\n#### 🏷️ Attributes\n\n' + attributes.join(' | ');
    }

    if (idx.comment) {
      markdown += `\n\n#### 📝 Comment\n\n${idx.comment}`;
    }

    await new NotebookBuilder(metadata)
      .addMarkdown(markdown)
      .addMarkdown('##### 📝 Index Definition')
      .addSql(`-- Index Definition\n${idx.index_definition};`)
      .addMarkdown('##### 📊 Usage Statistics')
      .addSql(IndexSQL.usageStats(schema, indexName))
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show index properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Copy index name to clipboard
 */
export async function copyIndexName(treeItem: DatabaseTreeItem): Promise<void> {
  const indexName = treeItem.label;
  await vscode.env.clipboard.writeText(indexName);
  vscode.window.showInformationMessage(`Copied: ${indexName}`);
}

/**
 * Generate DROP INDEX script
 */
export async function generateDropIndexScript(treeItem: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(treeItem);
    const { metadata } = dbConn;
    const schema = treeItem.schema!;
    const indexName = treeItem.label.replace(/^[🔑⭐🔍]\s+/, '');

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🗑️ Drop Index: \`${schema}.${indexName}\`\n\n⚠️ **Warning:** Dropping this index is permanent and may affect query performance.`)
      .addSql(IndexSQL.drop(schema, indexName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate drop index script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Generate REINDEX script
 */
export async function generateReindexScript(treeItem: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(treeItem);
    const { metadata } = dbConn;
    const schema = treeItem.schema!;
    const indexName = treeItem.label;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🔄 Reindex: \`${schema}.${indexName}\`\n\nRebuild the index to reclaim space and improve performance.`)
      .addSql(IndexSQL.reindex(schema, indexName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate reindex script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Generate CREATE INDEX template script
 */
export async function generateCreateIndexScript(treeItem: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(treeItem);
    const { metadata } = dbConn;
    const schema = treeItem.schema!;
    const tableName = treeItem.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 📐 Create Index: \`${schema}.${tableName}\`\n\nCreate a new index on the table using the template below.`)
      .addSql(`-- Create B-tree index (default)
CREATE INDEX idx_${tableName}_column_name
ON "${schema}"."${tableName}" (column_name);

-- Use CONCURRENTLY to avoid locking the table during creation
-- CREATE INDEX CONCURRENTLY idx_${tableName}_column_name
-- ON "${schema}"."${tableName}" (column_name);

-- Use UNIQUE to enforce uniqueness
-- CREATE UNIQUE INDEX idx_${tableName}_column_name_unique
-- ON "${schema}"."${tableName}" (column_name);

-- Use WHERE to create a partial index
-- CREATE INDEX idx_${tableName}_partial
-- ON "${schema}"."${tableName}" (column_name)
-- WHERE condition;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate create index script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Analyze index usage
 */
export async function analyzeIndexUsage(treeItem: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(treeItem);
    const { metadata } = dbConn;
    const schema = treeItem.schema!;
    const indexName = treeItem.label;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 📊 Index Usage Analysis: \`${schema}.${indexName}\`\n\nQuery usage statistics for this index.`)
      .addSql(IndexSQL.usageStats(schema, indexName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'analyze index usage');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Generate ALTER INDEX script
 */
export async function generateAlterIndexScript(treeItem: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(treeItem);
    const { metadata } = dbConn;
    const schema = treeItem.schema!;
    const indexName = treeItem.label;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ✏️ Alter Index: \`${schema}.${indexName}\`\n\nModify index properties using the template below.`)
      .addSql(IndexSQL.alter(schema, indexName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate alter index script');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Add comment to index
 */
export async function addIndexComment(treeItem: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(treeItem);
    const { metadata } = dbConn;
    const schema = treeItem.schema!;
    const indexName = treeItem.label;

    const comment = await vscode.window.showInputBox({
      prompt: 'Enter comment for index',
      placeHolder: 'Index description...'
    });

    if (comment === undefined) return;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`💬 Add Comment: \`${indexName}\``) +
        MarkdownUtils.infoBox(`Schema: \`${schema}\``)
      )
      .addSql(`-- Add comment to index
COMMENT ON INDEX "${schema}"."${indexName}" IS '${FormatHelpers.escapeSqlString(comment)}';`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'add index comment');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Alias for generateCreateIndexScript to match extension.ts import
 */
export { generateCreateIndexScript as generateScriptCreate };

/**
 * Show index operations notebook
 */
export async function cmdIndexOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const schema = item.schema!;
    const indexName = item.label;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🔧 Index Operations: \`${schema}.${indexName}\`\n\nCommon operations for managing this index.`)
      .addMarkdown('##### 📊 Usage Statistics')
      .addSql(IndexSQL.usageStats(schema, indexName))
      .addMarkdown('##### 🔄 Reindex')
      .addSql(IndexSQL.reindex(schema, indexName))
      .addMarkdown('##### ✏️ Alter Index')
      .addSql(IndexSQL.alter(schema, indexName))
      .addMarkdown('##### 🗑️ Drop Index\n\n⚠️ **Warning:** Dropping this index is permanent and may affect query performance.')
      .addSql(IndexSQL.drop(schema, indexName))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show index operations');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Add new index to table - generates a notebook with a CREATE INDEX template
 */
export async function cmdAddIndex(item: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item);
    const { metadata } = dbConn;
    const schema = item.schema!;
    const tableName = item.tableName!;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Add Index to \`${schema}.${tableName}\`\n\nCreate a new index using the template below.`)
      .addSql(`-- Create B-tree index (default)
CREATE INDEX idx_${tableName}_column_name
ON "${schema}"."${tableName}" (column_name);

-- Use CONCURRENTLY to avoid locking the table during creation
-- CREATE INDEX CONCURRENTLY idx_${tableName}_column_name
-- ON "${schema}"."${tableName}" (column_name);

-- Use UNIQUE to enforce uniqueness
-- CREATE UNIQUE INDEX idx_${tableName}_column_name_unique
-- ON "${schema}"."${tableName}" (column_name);

-- Use WHERE to create a partial index
-- CREATE INDEX idx_${tableName}_partial
-- ON "${schema}"."${tableName}" (column_name)
-- WHERE condition;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'add index');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}
