import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../../providers/DatabaseTreeProvider';
import { CommandBase } from '../../common/commands/CommandBase';
import { NotebookBuilder, MarkdownUtils } from '../helper';
import { TableSQL } from '../sql';

export async function cmdMaintenanceVacuum(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create VACUUM notebook', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🧹 VACUUM: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('VACUUM reclaims storage occupied by dead tuples and updates statistics for the query planner.') +
        `\n\n#### 🎯 What VACUUM Does\n\n` +
        MarkdownUtils.operationsTable([
          { operation: 'Dead Tuple Cleanup', description: 'Removes obsolete row versions' },
          { operation: 'Update Statistics', description: 'Refreshes table statistics' },
          { operation: 'Prevent Wraparound', description: 'Freezes old transaction IDs' },
          { operation: 'Update Visibility Map', description: 'Marks pages as all-visible' }
        ]) +
        `\n\n#### 📊 VACUUM Options\n\n` +
        `- **VACUUM**: Standard maintenance, doesn't lock table\n` +
        `- **VACUUM FULL**: Reclaims more space but requires exclusive lock\n` +
        `- **VACUUM ANALYZE**: Combines cleanup with statistics update (recommended)\n` +
        `- **VACUUM VERBOSE**: Shows detailed progress information\n\n` +
        `#### ⏱️ When to Run\n\n` +
        `- After large batch DELETE or UPDATE operations\n` +
        `- Regularly on high-transaction tables\n` +
        `- When query performance degrades\n` +
        `- Before major reporting operations\n\n` +
        MarkdownUtils.successBox('PostgreSQL has autovacuum running automatically, but manual VACUUM can be useful after bulk operations. Use VACUUM FULL only during maintenance windows as it locks the table.')
      )
      .addSql(TableSQL.vacuum(item.schema!, item.label))
      .show();
  });
}

export async function cmdMaintenanceAnalyze(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create ANALYZE notebook', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📊 ANALYZE: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('ANALYZE collects statistics about the contents of tables for the query planner to optimize query execution plans.') +
        `\n\n#### 🎯 What ANALYZE Does\n\n` +
        MarkdownUtils.propertiesTable({
          'Row Count': 'Estimates total rows in table',
          'Most Common Values': 'Identifies frequently occurring values',
          'Value Distribution': 'Analyzes value ranges and histograms',
          'NULL Frequency': 'Counts NULL values per column',
          'Column Correlation': 'Measures correlation between columns'
        }) +
        `\n\n#### 📈 Impact on Performance\n\n` +
        `**Before ANALYZE:**\n` +
        `- Query planner uses outdated statistics\n` +
        `- May choose suboptimal execution plans\n` +
        `- Queries might use wrong indexes or scan methods\n\n` +
        `**After ANALYZE:**\n` +
        `- ✅ Accurate table statistics\n` +
        `- ✅ Better query plan selection\n` +
        `- ✅ Improved query performance\n` +
        `- ✅ More efficient index usage\n\n` +
        `#### ⏱️ When to Run\n\n` +
        `- ✅ After bulk INSERT, UPDATE, or DELETE operations\n` +
        `- ✅ After importing large datasets\n` +
        `- ✅ When query performance suddenly degrades\n` +
        `- ✅ After creating or modifying indexes\n` +
        `- ✅ When table size changes significantly\n\n` +
        MarkdownUtils.successBox('ANALYZE is fast and non-blocking. Run it frequently, especially after data changes. Use VERBOSE to see detailed statistics updates.')
      )
      .addSql(TableSQL.analyze(item.schema!, item.label))
      .show();
  });
}

export async function cmdMaintenanceReindex(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create REINDEX notebook', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🔄 REINDEX: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.warningBox('REINDEX rebuilds all indexes on the table. This operation locks the table and can take significant time on large tables.') +
        `\n\n#### 🎯 What REINDEX Does\n\n` +
        MarkdownUtils.operationsTable([
          { operation: 'Rebuild Indexes', description: 'Creates fresh index structures' },
          { operation: 'Fix Corruption', description: 'Repairs damaged indexes' },
          { operation: 'Remove Bloat', description: 'Eliminates index bloat' },
          { operation: 'Update Statistics', description: 'Refreshes index statistics' }
        ]) +
        `\n\n#### 🔍 When to Use REINDEX\n\n` +
        `**Use REINDEX when:**\n` +
        `- ✅ Indexes are corrupted (rare, but can happen after crashes)\n` +
        `- ✅ Index bloat is significant (check with pg_stat_all_indexes)\n` +
        `- ✅ Query performance degraded despite VACUUM\n` +
        `- ✅ After PostgreSQL version upgrades (sometimes recommended)\n\n` +
        `**Don't use REINDEX when:**\n` +
        `- ❌ Normal maintenance (use VACUUM instead)\n` +
        `- ❌ On production during peak hours (requires locks)\n` +
        `- ❌ Trying to fix query performance (analyze query plans first)\n\n` +
        `#### ⚠️ Performance Impact\n\n` +
        MarkdownUtils.propertiesTable({
          'Duration': 'Can be long on large tables/indexes',
          'Locking': 'Table locked during rebuild',
          'I/O': 'High disk I/O activity',
          'Space': 'Requires disk space for new index'
        }) +
        `\n\n#### 🔄 Alternatives\n\n` +
        `- **REINDEX CONCURRENTLY** (PostgreSQL 12+): Rebuilds without locking, but slower\n` +
        `- **CREATE INDEX CONCURRENTLY + DROP**: Manual rebuild without exclusive locks\n` +
        `- **VACUUM FULL**: May be sufficient if bloat is the issue\n\n` +
        MarkdownUtils.dangerBox('REINDEX locks the table for writes. Schedule during maintenance windows or use REINDEX CONCURRENTLY if supported.', 'Caution')
      )
      .addSql(TableSQL.reindex(item.schema!, item.label))
      .show();
  });
}
