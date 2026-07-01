import * as vscode from 'vscode';
import { BaseLoader, LoaderContext } from './BaseLoader';
import { DatabaseTreeItem } from '../../DatabaseTreeProvider';
import { PG_VERSION_10, PG_VERSION_11 } from '../../../lib/postgresServerVersion';
import { isSupabasePlatformSchema } from '../../../lib/platform/supabaseSchemas';
import { getSchemaCache, SchemaCache } from '../../../lib/schema-cache';

export class DatabaseLoader extends BaseLoader {
  async getChildren(ctx: LoaderContext): Promise<DatabaseTreeItem[]> {
    const { provider, client, element, pgVer } = ctx;

    switch (element.type) {
      case 'database': {
        const cacheKey = SchemaCache.buildKey(element.connectionId!, element.databaseName!, undefined, 'database-counts');
        const counts = await getSchemaCache().getOrFetch(cacheKey, async () => {
          const safePromise = client.query(`
            SELECT
              (SELECT COUNT(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema') AS schema_count,
              (SELECT COUNT(*) FROM pg_available_extensions WHERE installed_version IS NOT NULL) AS extension_count,
              (SELECT COUNT(*) FROM pg_foreign_data_wrapper) AS fdw_count,
              (SELECT COUNT(*) FROM pg_event_trigger) AS event_trigger_count,
              (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'pg_publication' AND n.nspname = 'pg_catalog') 
                           THEN (SELECT COUNT(*) FROM pg_publication) 
                           ELSE 0 END) AS publication_count
          `);

          const cronPromise = (async () => {
            try {
              const hasCron = await client.query(
                `SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron' LIMIT 1`,
              );
              if (hasCron.rows.length > 0) {
                const cj = await client.query(`SELECT COUNT(*)::int AS n FROM cron.job`);
                return Number(cj.rows[0].n);
              }
            } catch {}
            return 0;
          })();

          const subPromise = (async () => {
            try {
              const subResult = await client.query('SELECT COUNT(*) FROM pg_subscription');
              return Number(subResult.rows[0].count);
            } catch {}
            return 0;
          })();

          const [safeRes, cronCount, subCount] = await Promise.all([
            safePromise,
            cronPromise,
            subPromise
          ]);

          const row = safeRes.rows[0];
          return {
            schemaCount: Number(row.schema_count),
            extensionCount: Number(row.extension_count),
            fdwCount: Number(row.fdw_count),
            eventTriggerCount: Number(row.event_trigger_count),
            publicationCount: Number(row.publication_count),
            cronJobCount: cronCount,
            subscriptionCount: subCount
          };
        });

        return [
          new DatabaseTreeItem('Schemas', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts.schemaCount),
          new DatabaseTreeItem('Extensions', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts.extensionCount),
          new DatabaseTreeItem('Cron Jobs', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts.cronJobCount),
          new DatabaseTreeItem('Foreign Data Wrappers', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts.fdwCount),
          new DatabaseTreeItem('Event Triggers', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts.eventTriggerCount),
          new DatabaseTreeItem('Publications', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts.publicationCount),
          new DatabaseTreeItem('Subscriptions', vscode.TreeItemCollapsibleState.Collapsed, 'category', element.connectionId, element.databaseName, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts.subscriptionCount)
        ];
      }

      case 'category': {
        if (element.tableName || element.schema) return []; // Handled by SchemaLoader or TableLoader

        const categoryName = element.label.split(' • ')[0];
        const cacheKey = SchemaCache.buildKey(element.connectionId!, element.databaseName || 'postgres', undefined, `cat:${categoryName}`);
        return await getSchemaCache().getOrFetch(cacheKey, async () => {
          switch (categoryName) {
          case 'Schemas': {
            const schemaResult = await client.query(
              `SELECT nspname
               FROM pg_namespace
               WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema'
               ORDER BY nspname`
            );
            const connections =
              vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') ||
              [];
            const connection = connections.find((c) => c.id === element.connectionId);
            const hideSupabaseSchemas =
              ctx.platformProfile?.platform === 'supabase' &&
              connection?.hidePlatformSchemas !== false;
            return schemaResult.rows
              .filter(
                (row) =>
                  !hideSupabaseSchemas || !isSupabasePlatformSchema(row.nspname),
              )
              .map(row => new DatabaseTreeItem(
              row.nspname,
              vscode.TreeItemCollapsibleState.Collapsed,
              'schema',
              element.connectionId,
              element.databaseName,
              row.nspname
            ));
          }

          case 'Users & Roles': {
            const roleResult = await client.query(
              `SELECT r.rolname,
                      r.rolsuper,
                      r.rolcreatedb,
                      r.rolcreaterole,
                      r.rolcanlogin
               FROM pg_roles r
               ORDER BY r.rolname`
            );
            return roleResult.rows.map(row => new DatabaseTreeItem(
              row.rolname,
              vscode.TreeItemCollapsibleState.None,
              'role',
              element.connectionId,
              element.databaseName,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                rolsuper: row.rolsuper,
                rolcreatedb: row.rolcreatedb,
                rolcreaterole: row.rolcreaterole,
                rolcanlogin: row.rolcanlogin
              }
            ));
          }

          case 'Extensions': {
            const extensionResult = await client.query(
              `SELECT e.name,
                      e.installed_version,
                      e.default_version,
                      e.comment,
                      CASE WHEN e.installed_version IS NOT NULL THEN true ELSE false END as is_installed
               FROM pg_available_extensions e
               ORDER BY is_installed DESC, name`
            );
            return extensionResult.rows.map(row => new DatabaseTreeItem(
              row.installed_version ? `${row.name} (${row.installed_version})` : `${row.name} (${row.default_version})`,
              vscode.TreeItemCollapsibleState.None,
              'extension',
              element.connectionId,
              element.databaseName,
              undefined,
              undefined,
              undefined,
              row.comment,
              row.is_installed,
              row.installed_version
            ));
          }

          case 'Cron Jobs': {
            const hasCron = await client.query(
              `SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron' LIMIT 1`,
            );
            if (hasCron.rows.length === 0) {
              return [
                new DatabaseTreeItem(
                  'Install pg_cron extension',
                  vscode.TreeItemCollapsibleState.None,
                  'cron-job',
                  element.connectionId,
                  element.databaseName,
                  undefined,
                  undefined,
                  undefined,
                  'pg_cron is not installed in this database. Use List / Install commands or run CREATE EXTENSION pg_cron (may require superuser).',
                ),
              ];
            }
            let cronResult: { rows: any[] };
            try {
              cronResult = await client.query(
                `SELECT jobid, jobname, schedule, command, active, database, username, nodename, nodeport
                 FROM cron.job
                 ORDER BY jobname NULLS LAST, jobid`,
              );
            } catch {
              return [
                new DatabaseTreeItem(
                  'Cannot read cron.job (permissions?)',
                  vscode.TreeItemCollapsibleState.None,
                  'cron-job',
                  element.connectionId,
                  element.databaseName,
                  undefined,
                  undefined,
                  undefined,
                  'Your role may lack USAGE on schema cron or SELECT on cron.job.',
                ),
              ];
            }
            return cronResult.rows.map((row: any) => {
              const name =
                row.jobname && String(row.jobname).trim() !== ''
                  ? String(row.jobname)
                  : `job ${row.jobid}`;
              const comment = [
                `Schedule: ${row.schedule}`,
                row.active ? 'Status: active' : 'Status: paused',
                `Database: ${row.database}`,
                `Run as: ${row.username}`,
                `Command:\n${row.command}`,
              ].join('\n');
              return new DatabaseTreeItem(
                name,
                vscode.TreeItemCollapsibleState.None,
                'cron-job',
                element.connectionId,
                element.databaseName,
                'cron',
                undefined,
                undefined,
                comment,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                Number(row.jobid),
                String(row.schedule),
                Boolean(row.active),
              );
            });
          }

          case 'Foreign Data Wrappers': {
            const fdwResult = await client.query(
              `SELECT fdwname as name
               FROM pg_foreign_data_wrapper
               ORDER BY fdwname`
            );
            return fdwResult.rows.map(row => new DatabaseTreeItem(
              row.name,
              vscode.TreeItemCollapsibleState.Collapsed,
              'foreign-data-wrapper',
              element.connectionId,
              element.databaseName
            ));
          }

          case 'Event Triggers': {
            const evtTrigResult = await client.query(
              `SELECT evtname, evtevent FROM pg_event_trigger ORDER BY evtname`
            );
            return evtTrigResult.rows.map((row: any) => new DatabaseTreeItem(
              row.evtname,
              vscode.TreeItemCollapsibleState.None,
              'event-trigger',
              element.connectionId,
              element.databaseName,
              undefined,
              undefined,
              undefined,
              row.evtevent
            ));
          }

          case 'Publications': {
            let pubRows: any[] = [];
            try {
              const pubResult = await client.query(
                `SELECT pubname FROM pg_publication ORDER BY pubname`
              );
              pubRows = pubResult.rows;
            } catch {
              // pg_publication exists only in PostgreSQL 10+
            }
            return pubRows.map((row: any) => new DatabaseTreeItem(
              row.pubname,
              vscode.TreeItemCollapsibleState.None,
              'publication',
              element.connectionId,
              element.databaseName
            ));
          }

          case 'Subscriptions': {
            let subRows: any[] = [];
            try {
              const subResult = await client.query(
                `SELECT subname FROM pg_subscription ORDER BY subname`
              );
              subRows = subResult.rows;
            } catch {
              // Requires superuser; return empty if not accessible
            }
            return subRows.map((row: any) => new DatabaseTreeItem(
              row.subname,
              vscode.TreeItemCollapsibleState.None,
              'subscription',
              element.connectionId,
              element.databaseName
            ));
          }

          case 'Tablespaces': {
            const tsResult = await client.query(
              `SELECT spcname, pg_size_pretty(pg_tablespace_size(spcname)) AS size FROM pg_tablespace ORDER BY spcname`
            );
            return tsResult.rows.map((row: any) => new DatabaseTreeItem(
              row.spcname,
              vscode.TreeItemCollapsibleState.None,
              'tablespace',
              element.connectionId,
              undefined,
              undefined,
              undefined,
              undefined,
              row.size
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
