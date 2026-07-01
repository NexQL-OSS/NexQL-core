import * as vscode from 'vscode';
import { BaseLoader, LoaderContext } from './BaseLoader';
import { DatabaseTreeItem } from '../../DatabaseTreeProvider';
import { PG_VERSION_10, PG_VERSION_11 } from '../../../lib/postgresServerVersion';
import { capabilityTagsForProfile } from '../../../lib/platform/PlatformProfile';
import { getSchemaCache, SchemaCache } from '../../../lib/schema-cache';

export class SchemaLoader extends BaseLoader {
  async getChildren(ctx: LoaderContext): Promise<DatabaseTreeItem[]> {
    const { provider, client, element, pgVer } = ctx;

    switch (element.type) {
      case 'schema': {
        const cacheKey = SchemaCache.buildKey(element.connectionId!, element.databaseName!, element.schema!, 'schema-counts');
        const countResult = await getSchemaCache().getOrFetch(cacheKey, async () => {
          const sql = `
            SELECT
              (SELECT COUNT(*)
               FROM information_schema.tables t
               JOIN pg_class c ON c.relname = t.table_name
               JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
               WHERE t.table_schema = $1
                 AND t.table_type = 'BASE TABLE'
                 ${pgVer >= PG_VERSION_10 ? 'AND NOT c.relispartition' : ''}
                 AND t.table_name NOT LIKE 'pg\\_%' ESCAPE E'\\\\'
                 AND t.table_name NOT LIKE 'sql\\_%' ESCAPE E'\\\\') AS tables_count,
              (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND (table_name LIKE 'pg\\_%' ESCAPE E'\\\\' OR table_name LIKE 'sql\\_%' ESCAPE E'\\\\')) AS system_tables_count,
              (SELECT COUNT(*) FROM information_schema.views WHERE table_schema = $1) AS views_count,
              (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION') AS functions_count,
              ${pgVer >= PG_VERSION_11
                ? `(SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind = 'p')`
                : '0'} AS procedures_count,
              (SELECT COUNT(*) FROM pg_matviews WHERE schemaname = $1) AS materialized_views_count,
              (SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = $1 AND t.typtype = 'c') AS types_count,
              (SELECT COUNT(*) FROM information_schema.foreign_tables WHERE foreign_table_schema = $1) AS foreign_tables_count,
              ${pgVer >= PG_VERSION_10
                ? '(SELECT COUNT(*) FROM pg_sequences WHERE schemaname = $1)'
                : '(SELECT COUNT(*) FROM information_schema.sequences WHERE sequence_schema = $1)'} AS sequences_count,
              (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = $1) AS triggers_count,
              (SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE t.typtype = 'd' AND n.nspname = $1) AS domains_count,
              ${pgVer >= PG_VERSION_11
                ? "(SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.prokind = 'a' AND n.nspname = $1)"
                : "(SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proisagg AND n.nspname = $1)"} AS aggregates_count,
              (SELECT COUNT(*) FROM pg_rules WHERE schemaname = $1) AS rules_count
          `;
          const res = await client.query(sql, [element.schema]);
          return res.rows[0];
        });

        const schemaItems: DatabaseTreeItem[] = [
          new DatabaseTreeItem('Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.tables_count || 0)),
          new DatabaseTreeItem('Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.views_count || 0)),
          new DatabaseTreeItem('Functions', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.functions_count || 0)),
          new DatabaseTreeItem('Procedures', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.procedures_count || 0)),
          new DatabaseTreeItem('Materialized Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.materialized_views_count || 0)),
          new DatabaseTreeItem('Types', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.types_count || 0)),
          new DatabaseTreeItem('Foreign Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.foreign_tables_count || 0)),
          new DatabaseTreeItem('Sequences', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.sequences_count || 0)),
          new DatabaseTreeItem('Triggers', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.triggers_count || 0)),
          new DatabaseTreeItem('Domains', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.domains_count || 0)),
          new DatabaseTreeItem('Aggregates', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.aggregates_count || 0)),
          new DatabaseTreeItem('Rules', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, Number(countResult.rules_count || 0))
        ];

        const systemTableCount = Number(countResult.system_tables_count || 0);
        if (systemTableCount > 0) {
          schemaItems.splice(1, 0, new DatabaseTreeItem(
            'System Tables',
            vscode.TreeItemCollapsibleState.Collapsed,
            'category',
            element.connectionId,
            element.databaseName,
            element.schema,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            systemTableCount
          ));
        }

        return schemaItems;
      }

      case 'category': {
        if (!element.schema || element.tableName) return [];

        const categoryName = element.label.split(' • ')[0];
        const cacheKey = SchemaCache.buildKey(element.connectionId!, element.databaseName!, element.schema!, `cat:${categoryName}`);
        return await getSchemaCache().getOrFetch(cacheKey, async () => {
          switch (categoryName) {
          case 'Tables': {
            const tableResult = await client.query(
              `SELECT 
                 t.table_name,
                 c.reltuples::bigint as estimated_rows,
                 pg_size_pretty(pg_total_relation_size(c.oid)) as size
               FROM information_schema.tables t
               JOIN pg_class c ON c.relname = t.table_name
               JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
               WHERE t.table_schema = $1
                 AND t.table_type = 'BASE TABLE'
                 ${pgVer >= PG_VERSION_10 ? 'AND NOT c.relispartition\n                 ' : ''}AND t.table_name NOT LIKE 'pg\_%' ESCAPE '\\'
                 AND t.table_name NOT LIKE 'sql\_%' ESCAPE '\\'
               ORDER BY t.table_name`,
              [element.schema]
            );
            const tableCapabilityTags = capabilityTagsForProfile(ctx.platformProfile);
            return tableResult.rows.map(row => {
              const isFav = (provider as any).isFavoriteItem('table', element.connectionId, element.databaseName, element.schema, row.table_name);
              return new DatabaseTreeItem(
                row.table_name,
                vscode.TreeItemCollapsibleState.Collapsed,
                'table',
                element.connectionId,
                element.databaseName,
                element.schema,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                isFav,
                undefined,
                row.estimated_rows,
                row.size,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                tableCapabilityTags,
              );
            });
          }

          case 'System Tables': {
            const systemTableResult = await client.query(
              `SELECT 
                 t.table_name,
                 c.reltuples::bigint as estimated_rows,
                 pg_size_pretty(pg_total_relation_size(c.oid)) as size
               FROM information_schema.tables t
               JOIN pg_class c ON c.relname = t.table_name
               JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
               WHERE t.table_schema = $1
                 AND t.table_type = 'BASE TABLE'
                 AND (t.table_name LIKE 'pg\_%' ESCAPE '\\' OR t.table_name LIKE 'sql\_%' ESCAPE '\\')
               ORDER BY t.table_name`,
              [element.schema]
            );

            return systemTableResult.rows.map((row: any) => new DatabaseTreeItem(
              row.table_name,
              vscode.TreeItemCollapsibleState.Collapsed,
              'table',
              element.connectionId,
              element.databaseName,
              element.schema,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              false,
              undefined,
              row.estimated_rows,
              row.size
            ));
          }

          case 'Views': {
            const viewResult = await client.query(
              "SELECT table_name FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name",
              [element.schema]
            );
            return viewResult.rows.map(row => {
              const isFav = (provider as any).isFavoriteItem('view', element.connectionId, element.databaseName, element.schema, row.table_name);
              return new DatabaseTreeItem(
                row.table_name,
                vscode.TreeItemCollapsibleState.Collapsed,
                'view',
                element.connectionId,
                element.databaseName,
                element.schema,
                undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                isFav
              );
            });
          }

          case 'Functions': {
            const functionResult = await client.query(
              "SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION' ORDER BY routine_name",
              [element.schema]
            );
            return functionResult.rows.map(row => {
              const isFav = (provider as any).isFavoriteItem('function', element.connectionId, element.databaseName, element.schema, row.routine_name);
              return new DatabaseTreeItem(
                row.routine_name,
                vscode.TreeItemCollapsibleState.None,
                'function',
                element.connectionId,
                element.databaseName,
                element.schema,
                undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                isFav
              );
            });
          }

          case 'Procedures': {
            if (pgVer < PG_VERSION_11) {
              return [];
            }
            const procedureResult = await client.query(
              `SELECT p.proname AS procedure_name
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = $1 AND p.prokind = 'p'
               ORDER BY p.proname`,
              [element.schema]
            );
            return procedureResult.rows.map(row => {
              const isFav = (provider as any).isFavoriteItem('procedure', element.connectionId, element.databaseName, element.schema, row.procedure_name);
              return new DatabaseTreeItem(
                row.procedure_name,
                vscode.TreeItemCollapsibleState.None,
                'procedure',
                element.connectionId,
                element.databaseName,
                element.schema,
                undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                isFav
              );
            });
          }

          case 'Materialized Views': {
            const materializedViewResult = await client.query(
              `SELECT 
                 m.matviewname as name,
                 c.reltuples::bigint as estimated_rows,
                 pg_size_pretty(pg_total_relation_size(c.oid)) as size
               FROM pg_matviews m
               JOIN pg_class c ON c.relname = m.matviewname
               JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = m.schemaname
               WHERE m.schemaname = $1 
               ORDER BY m.matviewname`,
              [element.schema]
            );
            return materializedViewResult.rows.map(row => {
              const isFav = (provider as any).isFavoriteItem('materialized-view', element.connectionId, element.databaseName, element.schema, row.name);
              return new DatabaseTreeItem(
                row.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                'materialized-view',
                element.connectionId,
                element.databaseName,
                element.schema,
                undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                isFav,
                undefined,
                row.estimated_rows,
                row.size
              );
            });
          }

          case 'Types': {
            const typeResult = await client.query(
              `SELECT t.typname as name
               FROM pg_type t
               JOIN pg_namespace n ON t.typnamespace = n.oid
               WHERE n.nspname = $1
               AND t.typtype = 'c'
               ORDER BY t.typname`,
              [element.schema]
            );
            return typeResult.rows.map(row => new DatabaseTreeItem(
              row.name,
              vscode.TreeItemCollapsibleState.None,
              'type',
              element.connectionId,
              element.databaseName,
              element.schema
            ));
          }

          case 'Foreign Tables': {
            const foreignTableResult = await client.query(
              `SELECT c.relname as name
               FROM pg_foreign_table ft
               JOIN pg_class c ON ft.ftrelid = c.oid
               JOIN pg_namespace n ON c.relnamespace = n.oid
               WHERE n.nspname = $1
               ORDER BY c.relname`,
              [element.schema]
            );
            return foreignTableResult.rows.map(row => new DatabaseTreeItem(
              row.name,
              vscode.TreeItemCollapsibleState.None,
              'foreign-table',
              element.connectionId,
              element.databaseName,
              element.schema
            ));
          }

          case 'Sequences': {
            const seqResult = await client.query(
              pgVer >= PG_VERSION_10
                ? 'SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename'
                : `SELECT sequence_name AS sequencename, NULL::bigint AS last_value
                   FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name`,
              [element.schema]
            );
            return seqResult.rows.map((row: any) => new DatabaseTreeItem(
              row.sequencename,
              vscode.TreeItemCollapsibleState.None,
              'sequence',
              element.connectionId,
              element.databaseName,
              element.schema
            ));
          }

          case 'Triggers': {
            const schemaTrigResult = await client.query(
              `SELECT DISTINCT t.trigger_name, t.event_object_table, t.event_manipulation, t.action_timing
               FROM information_schema.triggers t
               WHERE t.trigger_schema = $1
               ORDER BY t.trigger_name`,
              [element.schema]
            );
            return schemaTrigResult.rows.map((row: any) => new DatabaseTreeItem(
              row.trigger_name,
              vscode.TreeItemCollapsibleState.None,
              'trigger',
              element.connectionId,
              element.databaseName,
              element.schema,
              row.event_object_table,
              undefined,
              `${row.action_timing} ${row.event_manipulation} on ${row.event_object_table}`
            ));
          }

          case 'Domains': {
            const domResult = await client.query(
              `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE t.typtype = 'd' AND n.nspname = $1 ORDER BY t.typname`,
              [element.schema]
            );
            return domResult.rows.map((row: any) => new DatabaseTreeItem(
              row.typname,
              vscode.TreeItemCollapsibleState.None,
              'domain',
              element.connectionId,
              element.databaseName,
              element.schema
            ));
          }

          case 'Aggregates': {
            const aggListSql =
              pgVer >= PG_VERSION_11
                ? `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.prokind = 'a' AND n.nspname = $1 ORDER BY p.proname`
                : `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proisagg AND n.nspname = $1 ORDER BY p.proname`;
            const aggResult = await client.query(aggListSql, [element.schema]);
            return aggResult.rows.map((row: any) => new DatabaseTreeItem(
              row.proname,
              vscode.TreeItemCollapsibleState.None,
              'aggregate',
              element.connectionId,
              element.databaseName,
              element.schema
            ));
          }

          case 'Rules': {
            const schemaRulesResult = await client.query(
              "SELECT rulename, tablename FROM pg_rules WHERE schemaname = $1 ORDER BY tablename, rulename",
              [element.schema]
            );
            return schemaRulesResult.rows.map((row: any) => new DatabaseTreeItem(
              row.rulename,
              vscode.TreeItemCollapsibleState.None,
              'rule',
              element.connectionId,
              element.databaseName,
              element.schema,
              row.tablename
            ));
          }
        }
        return [];
      });
    }

      default:
        return [];
    }
  }
}
