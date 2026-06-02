import * as vscode from 'vscode';
import { BaseLoader, LoaderContext } from './BaseLoader';
import { DatabaseTreeItem } from '../../DatabaseTreeProvider';
import { PG_VERSION_10, PG_VERSION_11 } from '../../../lib/postgresServerVersion';

export class SchemaLoader extends BaseLoader {
  async getChildren(ctx: LoaderContext): Promise<DatabaseTreeItem[]> {
    const { provider, client, element, pgVer } = ctx;

    switch (element.type) {
      case 'schema': {
        const tablesCountResult = await client.query(
          `SELECT COUNT(*)
           FROM information_schema.tables t
           JOIN pg_class c ON c.relname = t.table_name
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
           WHERE t.table_schema = $1
             AND t.table_type = 'BASE TABLE'
             ${pgVer >= PG_VERSION_10 ? 'AND NOT c.relispartition\n             ' : ''}AND t.table_name NOT LIKE 'pg\\_%' ESCAPE E'\\\\'
             AND t.table_name NOT LIKE 'sql\\_%' ESCAPE E'\\\\'`,
          [element.schema]
        );

        const systemTablesCountResult = await client.query(
          "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND (table_name LIKE 'pg\\_%' ESCAPE E'\\\\' OR table_name LIKE 'sql\\_%' ESCAPE E'\\\\')",
          [element.schema]
        );

        const viewsCountResult = await client.query(
          "SELECT COUNT(*) FROM information_schema.views WHERE table_schema = $1",
          [element.schema]
        );

        const functionsCountResult = await client.query(
          "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION'",
          [element.schema]
        );

        const proceduresCountResult =
          pgVer >= PG_VERSION_11
            ? await client.query(
                `SELECT COUNT(*)
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = $1 AND p.prokind = 'p'`,
                [element.schema]
              )
            : { rows: [{ count: 0 }] };

        const materializedViewsCountResult = await client.query(
          "SELECT COUNT(*) FROM pg_matviews WHERE schemaname = $1",
          [element.schema]
        );

        const typesCountResult = await client.query(
          "SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = $1 AND t.typtype = 'c'",
          [element.schema]
        );

        const foreignTablesCountResult = await client.query(
          "SELECT COUNT(*) FROM information_schema.foreign_tables WHERE foreign_table_schema = $1",
          [element.schema]
        );

        const seqCountResult = await client.query(
          pgVer >= PG_VERSION_10
            ? 'SELECT COUNT(*) FROM pg_sequences WHERE schemaname = $1'
            : 'SELECT COUNT(*) FROM information_schema.sequences WHERE sequence_schema = $1',
          [element.schema]
        );

        const trigCountResult = await client.query(
          "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = $1",
          [element.schema]
        );

        const domCountResult = await client.query(
          "SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE t.typtype = 'd' AND n.nspname = $1",
          [element.schema]
        );

        const aggCountResult = await client.query(
          pgVer >= PG_VERSION_11
            ? "SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.prokind = 'a' AND n.nspname = $1"
            : "SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proisagg AND n.nspname = $1",
          [element.schema]
        );

        const ruleCountResult = await client.query(
          "SELECT COUNT(*) FROM pg_rules WHERE schemaname = $1",
          [element.schema]
        );

        const schemaItems: DatabaseTreeItem[] = [
          new DatabaseTreeItem('Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tablesCountResult.rows[0].count),
          new DatabaseTreeItem('Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, viewsCountResult.rows[0].count),
          new DatabaseTreeItem('Functions', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, functionsCountResult.rows[0].count),
          new DatabaseTreeItem('Procedures', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, proceduresCountResult.rows[0].count),
          new DatabaseTreeItem('Materialized Views', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, materializedViewsCountResult.rows[0].count),
          new DatabaseTreeItem('Types', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, typesCountResult.rows[0].count),
          new DatabaseTreeItem('Foreign Tables', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, foreignTablesCountResult.rows[0].count),
          new DatabaseTreeItem('Sequences', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, seqCountResult.rows[0].count),
          new DatabaseTreeItem('Triggers', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, trigCountResult.rows[0].count),
          new DatabaseTreeItem('Domains', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, domCountResult.rows[0].count),
          new DatabaseTreeItem('Aggregates', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, aggCountResult.rows[0].count),
          new DatabaseTreeItem('Rules', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ruleCountResult.rows[0].count)
        ];

        const systemTableCount = Number(systemTablesCountResult.rows[0].count || 0);
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
                row.size
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
                vscode.TreeItemCollapsibleState.None,
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
      }

      default:
        return [];
    }
  }
}
