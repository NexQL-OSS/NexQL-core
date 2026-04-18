import * as vscode from 'vscode';
import type { PoolClient } from 'pg';
import { ConnectionManager } from '../services/ConnectionManager';
import { NotebookBuilder, MarkdownUtils } from './helper';
import { getConnectionWithPassword } from './connection';

interface SearchRow {
  type: string;
  schema: string;
  name: string;
  definition: string | null;
  connectionId: string;
  databaseName: string;
  connectionLabel: string;
}

const TYPE_ICONS: Record<string, string> = {
  table: '$(table)',
  view: '$(eye)',
  function: '$(symbol-method)',
  sequence: '$(list-ordered)',
  trigger: '$(zap)',
  domain: '$(symbol-namespace)',
  aggregate: '$(symbol-operator)',
  'materialized-view': '$(symbol-structure)',
};

/** Escape `%`, `_`, `\` for use in PostgreSQL LIKE / ILIKE with ESCAPE '\\'. */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const DEBOUNCE_MS = 280;
const LIMIT_BROWSE = 300;
const LIMIT_FILTER = 2500;

/**
 * Single UNION for catalog objects; wrapped with server-side filter + LIMIT for scalable search.
 */
const SEARCH_UNION_BODY = `
      SELECT 'table' AS type, table_schema AS schema, table_name AS name, NULL::text AS definition
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'
      UNION ALL
      SELECT 'view', table_schema, table_name, view_definition
      FROM information_schema.views
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT 'function', routine_schema, routine_name, routine_definition
      FROM information_schema.routines
      WHERE routine_schema NOT IN ('pg_catalog', 'information_schema') AND routine_type = 'FUNCTION'
      UNION ALL
      SELECT 'sequence', schemaname, sequencename, NULL::text
      FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT DISTINCT 'trigger', trigger_schema, trigger_name, action_statement
      FROM information_schema.triggers
      WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT 'domain', n.nspname, t.typname, format_type(t.typbasetype, t.typtypmod)
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE t.typtype = 'd' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT 'aggregate', n.nspname, p.proname, pg_get_function_arguments(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE p.prokind = 'a' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT 'materialized-view', schemaname, matviewname, definition
      FROM pg_matviews
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
`;

const SEARCH_QUERY = `
SELECT * FROM (
${SEARCH_UNION_BODY}
) AS u
WHERE (
  $1::text IS NULL OR btrim($1) = '' OR
  u.name ILIKE '%' || $1 || '%' ESCAPE '\\' OR
  u.schema ILIKE '%' || $1 || '%' ESCAPE '\\'
)
ORDER BY u.type, u.schema, u.name
LIMIT $2
`;

async function querySearchRows(client: PoolClient, rawFilter: string): Promise<SearchRow[]> {
  const trimmed = rawFilter.trim();
  const pattern = trimmed.length === 0 ? null : escapeLikePattern(trimmed);
  const limit = pattern === null ? LIMIT_BROWSE : LIMIT_FILTER;
  const result = await client.query(SEARCH_QUERY, [pattern, limit]);
  return result.rows as SearchRow[];
}

async function acquireClientForConnection(conn: any): Promise<PoolClient> {
  const connection = await getConnectionWithPassword(conn.id, conn.database);
  return ConnectionManager.getInstance().getPooledClient({
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    database: conn.database || connection.database,
    name: connection.name,
  });
}

function rowToQuickPickItems(
  rows: SearchRow[],
  multiConnection: boolean,
): (vscode.QuickPickItem & { row: SearchRow })[] {
  return rows.map((row) => ({
    label: `${TYPE_ICONS[row.type] || '$(symbol-misc)'}  ${row.name}`,
    description: multiConnection
      ? `${row.connectionLabel} · ${row.databaseName} · ${row.schema} · ${row.type}`
      : `${row.schema}  ·  ${row.type}`,
    detail: row.definition
      ? row.definition.slice(0, 120).replace(/\s+/g, ' ').trim()
      : undefined,
    row,
  }));
}

async function pickSearchConnections(
  connections: any[],
): Promise<any[] | undefined> {
  if (connections.length === 0) {
    return undefined;
  }
  if (connections.length === 1) {
    return [connections[0]];
  }

  type ScopePick = vscode.QuickPickItem & { connections?: any[] };
  const items: ScopePick[] = [
    {
      label: '$(globe) All connections',
      description: 'Search every saved connection (parallel queries)',
      connections,
    },
    ...connections.map((c) => ({
      label: c.name || `${c.host}:${c.port}`,
      description: `${c.host}:${c.port}/${c.database}`,
      connections: [c],
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Search scope: one connection or all',
    title: 'Schema search',
  });
  return picked?.connections;
}

export async function cmdSearchSchema(): Promise<void> {
  const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
  if (connections.length === 0) {
    vscode.window.showInformationMessage('No connections configured. Please add a PostgreSQL connection first.');
    return;
  }

  const scoped = await pickSearchConnections(connections);
  if (!scoped?.length) {
    return;
  }

  const multiConnection = scoped.length > 1;

  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { row: SearchRow }>();
  qp.title = 'Schema search — browse catalog';
  qp.placeholder = multiConnection
    ? 'Filter by name or schema (server-side, all connections)…'
    : 'Filter by name or schema (server-side)…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.show();

  const clientByConnectionId = new Map<string, PoolClient>();
  const releaseAll = async (): Promise<void> => {
    for (const c of clientByConnectionId.values()) {
      try {
        c.release();
      } catch {
        /* ignore */
      }
    }
    clientByConnectionId.clear();
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const runSearch = async (filter: string): Promise<void> => {
    if (disposed) {
      return;
    }
    qp.busy = true;
    try {
      const rows: SearchRow[] = [];

      if (!multiConnection) {
        const conn = scoped[0];
        const label = conn.name || conn.host || conn.id;
        let client = clientByConnectionId.get(conn.id);
        if (!client) {
          client = await acquireClientForConnection(conn);
          clientByConnectionId.set(conn.id, client);
        }
        const raw = await querySearchRows(client, filter);
        for (const r of raw) {
          rows.push({
            ...r,
            connectionId: conn.id,
            databaseName: conn.database || 'postgres',
            connectionLabel: label,
          });
        }
      } else {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'PgStudio: schema search',
          },
          async () => {
            const tasks = scoped.map(async (conn) => {
              const label = conn.name || conn.host || conn.id;
              try {
                let client = clientByConnectionId.get(conn.id);
                if (!client) {
                  client = await acquireClientForConnection(conn);
                  clientByConnectionId.set(conn.id, client);
                }
                const raw = await querySearchRows(client, filter);
                for (const r of raw) {
                  rows.push({
                    ...r,
                    connectionId: conn.id,
                    databaseName: conn.database || 'postgres',
                    connectionLabel: label,
                  });
                }
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                void vscode.window.showWarningMessage(`Schema search skipped for ${label}: ${msg}`);
              }
            });
            await Promise.all(tasks);
          },
        );
        rows.sort((a, b) => {
          const t = a.type.localeCompare(b.type);
          if (t !== 0) {
            return t;
          }
          const s = a.schema.localeCompare(b.schema);
          if (s !== 0) {
            return s;
          }
          return a.name.localeCompare(b.name);
        });
      }

      qp.items = rowToQuickPickItems(rows, multiConnection);
      qp.title =
        rows.length > 0
          ? `Schema search (${rows.length} object${rows.length === 1 ? '' : 's'})`
          : filter.trim()
            ? 'Schema search — no matches'
            : 'Schema search — browse catalog';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Schema search failed: ${msg}`);
      qp.items = [];
    } finally {
      qp.busy = false;
    }
  };

  await runSearch('');

  qp.onDidChangeValue((value) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void runSearch(value);
    }, DEBOUNCE_MS);
  });

  qp.onDidAccept(async () => {
    const selected = qp.selectedItems[0];
    qp.hide();
    if (!selected?.row) {
      return;
    }

    const row = selected.row;
    try {
      const connection = await getConnectionWithPassword(row.connectionId, row.databaseName);
      const metadata = {
        connectionId: connection.id,
        databaseName: row.databaseName || connection.database,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        name: connection.name,
      };

      let sql = '';
      switch (row.type) {
        case 'table':
          sql = `-- Table structure: ${row.schema}.${row.name}
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = '${row.schema}' AND table_name = '${row.name}'
ORDER BY ordinal_position;`;
          break;
        case 'view':
          sql = `-- View definition: ${row.schema}.${row.name}
SELECT pg_get_viewdef('"${row.schema}"."${row.name}"'::regclass, true) AS definition;`;
          break;
        case 'materialized-view':
          sql = `-- Materialized view definition: ${row.schema}.${row.name}
SELECT definition FROM pg_matviews WHERE schemaname = '${row.schema}' AND matviewname = '${row.name}';`;
          break;
        case 'function':
          sql = `-- Function source: ${row.schema}.${row.name}
SELECT pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = '${row.schema}' AND p.proname = '${row.name}';`;
          break;
        case 'sequence':
          sql = `-- Sequence properties: ${row.schema}.${row.name}
SELECT * FROM pg_sequences WHERE schemaname = '${row.schema}' AND sequencename = '${row.name}';`;
          break;
        case 'trigger':
          sql = `-- Trigger definition: ${row.schema}.${row.name}
SELECT pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = '${row.schema}' AND t.tgname = '${row.name}';`;
          break;
        case 'domain':
          sql = `-- Domain definition: ${row.schema}.${row.name}
SELECT t.typname, format_type(t.typbasetype, t.typtypmod) AS base_type,
       t.typnotnull, pg_get_expr(t.typdefaultbin, 0) AS default_value,
       c.conname, pg_get_constraintdef(c.oid) AS constraint
FROM pg_type t
JOIN pg_namespace n ON t.typnamespace = n.oid
LEFT JOIN pg_constraint c ON c.contypid = t.oid
WHERE t.typtype = 'd' AND n.nspname = '${row.schema}' AND t.typname = '${row.name}';`;
          break;
        case 'aggregate':
          sql = `-- Aggregate definition: ${row.schema}.${row.name}
SELECT p.proname, pg_get_function_arguments(p.oid) AS arguments,
       format_type(p.prorettype, NULL) AS return_type
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.prokind = 'a' AND n.nspname = '${row.schema}' AND p.proname = '${row.name}';`;
          break;
        default:
          sql = `SELECT '${row.name}' AS object_name, '${row.type}' AS object_type, '${row.schema}' AS schema;`;
      }

      await new NotebookBuilder(metadata as any)
        .addMarkdown(
          MarkdownUtils.header(`${row.type}: ${row.schema}.${row.name}`) +
            MarkdownUtils.infoBox(`Object type: ${row.type} | Schema: ${row.schema}`),
        )
        .addSql(sql)
        .show();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Could not open object: ${msg}`);
    }
  });

  qp.onDidHide(async () => {
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    await releaseAll();
    qp.dispose();
  });
}
