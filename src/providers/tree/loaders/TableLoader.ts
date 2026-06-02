import * as vscode from 'vscode';
import { BaseLoader, LoaderContext } from './BaseLoader';
import { DatabaseTreeItem } from '../../DatabaseTreeProvider';

export class TableLoader extends BaseLoader {
  async getChildren(ctx: LoaderContext): Promise<DatabaseTreeItem[]> {
    const { provider, client, element, pgVer } = ctx;

    switch (element.type) {
      case 'table': {
        let rlsPolicyCount = 0;
        try {
          const pc = await client.query(
            `SELECT COUNT(*)::int AS n FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
            [element.schema, element.label],
          );
          rlsPolicyCount = Number(pc.rows[0]?.n ?? 0);
        } catch {
          rlsPolicyCount = 0;
        }
        return [
          new DatabaseTreeItem('Columns', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
          new DatabaseTreeItem('Constraints', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
          new DatabaseTreeItem('Indexes', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
          new DatabaseTreeItem('Triggers', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
          new DatabaseTreeItem(
            'RLS Policies',
            vscode.TreeItemCollapsibleState.Collapsed,
            'category',
            element.connectionId,
            element.databaseName,
            element.schema,
            element.label,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            rlsPolicyCount,
          ),
          new DatabaseTreeItem('Rules', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
          new DatabaseTreeItem('Partitions', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label),
        ];
      }

      case 'view':
        return [
          new DatabaseTreeItem('Columns', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, element.schema, element.label)
        ];

      case 'foreign-data-wrapper': {
        const serversResult = await client.query(
          `SELECT srv.srvname as name
           FROM pg_foreign_server srv
           JOIN pg_foreign_data_wrapper fdw ON srv.srvfdw = fdw.oid
           WHERE fdw.fdwname = $1
           ORDER BY srv.srvname`,
          [element.label]
        );
        return serversResult.rows.map(row => new DatabaseTreeItem(
          row.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          'foreign-server',
          element.connectionId,
          element.databaseName,
          element.label
        ));
      }

      case 'foreign-server': {
        const mappingsResult = await client.query(
          `SELECT um.usename as name
           FROM pg_user_mappings um
           WHERE um.srvname = $1
           ORDER BY um.usename`,
          [element.label]
        );
        return mappingsResult.rows.map(row => new DatabaseTreeItem(
          row.name,
          vscode.TreeItemCollapsibleState.None,
          'user-mapping',
          element.connectionId,
          element.databaseName,
          element.label,
          element.label
        ));
      }

      case 'category': {
        if (!element.tableName) return [];

        switch (element.label) {
          case 'Columns': {
            const columnResult = await client.query(
              "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
              [element.schema, element.tableName]
            );
            return columnResult.rows.map(row => new DatabaseTreeItem(
              `${row.column_name} (${row.data_type})`,
              vscode.TreeItemCollapsibleState.None,
              'column',
              element.connectionId,
              element.databaseName,
              element.schema,
              element.tableName,
              row.column_name
            ));
          }

          case 'Constraints': {
            const constraintResult = await client.query(
              `SELECT tc.constraint_name, tc.constraint_type
               FROM information_schema.table_constraints tc
               WHERE tc.table_schema = $1 AND tc.table_name = $2
               ORDER BY tc.constraint_type, tc.constraint_name`,
              [element.schema, element.tableName]
            );
            return constraintResult.rows.map(row => {
              return new DatabaseTreeItem(
                row.constraint_name,
                vscode.TreeItemCollapsibleState.None,
                'constraint',
                element.connectionId,
                element.databaseName,
                element.schema,
                element.tableName
              );
            });
          }

          case 'Indexes': {
            const indexResult = await client.query(
              `SELECT i.relname as index_name,
                      ix.indisunique as is_unique,
                      ix.indisprimary as is_primary
               FROM pg_index ix
               JOIN pg_class i ON i.oid = ix.indexrelid
               JOIN pg_class t ON t.oid = ix.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               WHERE n.nspname = $1 AND t.relname = $2
               ORDER BY i.relname`,
              [element.schema, element.tableName]
            );
            return indexResult.rows.map(row => {
              return new DatabaseTreeItem(
                row.index_name,
                vscode.TreeItemCollapsibleState.None,
                'index',
                element.connectionId,
                element.databaseName,
                element.schema,
                element.tableName
              );
            });
          }

          case 'Triggers': {
            const tableTrigResult = await client.query(
              `SELECT DISTINCT t.trigger_name, t.event_manipulation, t.action_timing
               FROM information_schema.triggers t
               WHERE t.trigger_schema = $1 AND t.event_object_table = $2
               ORDER BY t.trigger_name`,
              [element.schema, element.tableName]
            );
            return tableTrigResult.rows.map((row: any) => new DatabaseTreeItem(
              row.trigger_name,
              vscode.TreeItemCollapsibleState.None,
              'trigger',
              element.connectionId,
              element.databaseName,
              element.schema,
              element.tableName,
              undefined,
              `${row.action_timing} ${row.event_manipulation}`
            ));
          }

          case 'RLS Policies': {
            try {
              const polResult = await client.query(
                `SELECT policyname, cmd, permissive
                 FROM pg_policies
                 WHERE schemaname = $1 AND tablename = $2
                 ORDER BY policyname`,
                [element.schema, element.tableName],
              );
              return polResult.rows.map(
                (row: { policyname: string; cmd: string; permissive: string }) =>
                  new DatabaseTreeItem(
                    row.policyname,
                    vscode.TreeItemCollapsibleState.None,
                    'policy',
                    element.connectionId,
                    element.databaseName,
                    element.schema,
                    element.tableName,
                    undefined,
                    `${row.cmd} · ${row.permissive === 'PERMISSIVE' ? 'permissive' : 'restrictive'}`,
                  ),
              );
            } catch {
              return [
                new DatabaseTreeItem(
                  'Cannot read pg_policies (permissions?)',
                  vscode.TreeItemCollapsibleState.None,
                  'policy',
                  element.connectionId,
                  element.databaseName,
                  element.schema,
                  element.tableName,
                  undefined,
                  'Your role may lack SELECT on pg_policies.',
                ),
              ];
            }
          }

          case 'Rules': {
            const tableRuleResult = await client.query(
              `SELECT rulename FROM pg_rules WHERE schemaname = $1 AND tablename = $2 ORDER BY rulename`,
              [element.schema, element.tableName]
            );
            return tableRuleResult.rows.map((row: any) => new DatabaseTreeItem(
              row.rulename,
              vscode.TreeItemCollapsibleState.None,
              'rule',
              element.connectionId,
              element.databaseName,
              element.schema,
              element.tableName
            ));
          }

          case 'Partitions': {
            const partResult = await client.query(
              `SELECT c.relname AS partition_name,
                      n.nspname AS partition_schema,
                      pg_get_expr(c.relpartbound, c.oid, true) AS partition_bound
               FROM pg_inherits i
               JOIN pg_class c ON i.inhrelid = c.oid
               JOIN pg_namespace n ON c.relnamespace = n.oid
               JOIN pg_class p ON i.inhparent = p.oid
               JOIN pg_namespace pn ON p.relnamespace = pn.oid
               WHERE pn.nspname = $1 AND p.relname = $2
               ORDER BY c.relname`,
              [element.schema, element.tableName]
            );
            return partResult.rows.map((row: any) => new DatabaseTreeItem(
              row.partition_name,
              vscode.TreeItemCollapsibleState.None,
              'partition',
              element.connectionId,
              element.databaseName,
              row.partition_schema,
              element.tableName,
              undefined,
              row.partition_bound
            ));
          }
        }
      }

      default:
        return [];
    }
  }
}
