# DbStudio: Expanding NexQL to a Multi-Database Extension

## Context

NexQL today is a single-database VS Code extension (`ric-v.postgres-explorer`) built end-to-end around PostgreSQL: the `pg` driver is imported in 23 files, all 28 SQL templates use PG dialect (mix of `information_schema` and `pg_catalog`), the tree provider exposes ~40 object types (~10 of which are PG-only: publications, subscriptions, tablespaces, event-triggers, pgcron, FDWs), and `package.json` ships ~494 command IDs, 25 config keys, 2 notebook types, a `.pgsql` file extension, a `postgres` language ID, and a `postgres-explorer` activity-bar container — all hard-branded PostgreSQL.

The goal: rebrand to **DbStudio**, a single extension where the user picks a database type per connection. MySQL/MariaDB lands first, followed by SQLite, MSSQL, Oracle, and other common SQL engines, each targeting near-full feature parity. Per-DB features that have no equivalent (LISTEN/NOTIFY, publications, tablespaces, pgcron) stay gated to their engine.

The surprise finding from exploration: **~70% of the code is already near-DB-agnostic** (UI/webviews, AI assistant, saved queries, notebook serializer, secret storage, activation scaffolding, test utils). The coupling is concentrated in four surfaces — driver calls, SQL templates, tree introspection queries, and the `package.json` manifest.

---

## Recommended Approach: Driver-Adapter Architecture

Introduce a `DbDriver` abstraction and a `DbDialect` abstraction. All call sites that today import `pg` go through the driver; all code that writes SQL goes through the dialect. Drivers/dialects are registered per `DbEngine` (`postgres | mysql | sqlite | mssql | oracle | …`).

### Core interfaces (new: `src/core/db/`)

```ts
// src/core/db/DbEngine.ts
export type DbEngine = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'oracle';

// src/core/db/DbDriver.ts
export interface DbDriver {
  readonly engine: DbEngine;
  connect(config: ConnectionConfig): Promise<DbClient>;
  releaseAll(): Promise<void>;
}
export interface DbClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  stream?(sql: string, params?: any[]): AsyncIterable<Row>;
  close(): Promise<void>;
}

// src/core/db/DbDialect.ts — all dialect-variable SQL lives behind this
export interface DbDialect {
  readonly engine: DbEngine;
  identifier(name: string): string;              // quoting
  limitClause(n: number): string;                // LIMIT / TOP / ROWNUM
  introspect: IntrospectionProvider;             // lists schemas/tables/cols/idx/fks
  explain(sql: string): string;                  // per-engine EXPLAIN
  capabilities: FeatureFlags;                    // supportsSchemas, supportsListenNotify, …
}

// src/core/db/registry.ts
export function getDriver(engine: DbEngine): DbDriver;
export function getDialect(engine: DbEngine): DbDialect;
```

`ConnectionConfig` gains an `engine: DbEngine` field. `SecretStorageService` and `ProfileManager` already work with a generic config — minimal change.

### Phased migration

**Phase 0 — Abstraction skeleton (1 week)**
- Create `src/core/db/` with interfaces above.
- Build a thin default registry with only the `postgres` driver/dialect registered.
- Wire `ConnectionManager` to delegate to `getDriver(config.engine)` instead of calling `new Pool(...)` directly. Keep existing PG behavior identical.
- Move pg-specific helpers (`resolvePgPassPassword`, SSL fallback for `ECONNRESET`/`EPROTO` at `ConnectionManager.ts:93-112`, `SET default_transaction_read_only` at line 131) into `PostgresDriver`.
- **Exit criterion:** full test suite still green; no behavior change; all `import { Pool, Client } from 'pg'` removed from everywhere except `PostgresDriver.ts`.

**Phase 1 — Rebrand manifest (1 week, parallelizable with Phase 0)**
- Rename extension: `postgres-explorer` → `dbstudio`, display name `NexQL (PostgreSQL Explorer)` → `DbStudio`, publisher stays `ric-v`.
- Command namespace migration: `postgres-explorer.*` → `dbstudio.*` for all 494 commands. Keep old IDs as deprecated aliases for one release cycle (users have keybindings).
- Config keys: `postgresExplorer.*` → `dbstudio.*` with a one-shot migration on activation that copies old settings forward. Register both namespaces as readable; only write to the new one.
- Activity bar container: `postgres-explorer` → `dbstudio`; keep the view IDs stable where possible to avoid breaking layouts.
- Language registration: keep `postgres` language for `.pgsql` files; add new generic `sql` fallback and future per-engine languages (`mysql`, `tsql`) as the drivers land.
- Notebooks: keep `postgres-notebook` / `postgres-query` working. Add a new generic `dbstudio-notebook` that carries the engine in notebook metadata. Old notebook files keep opening via the legacy controllers, routed to the postgres engine by default.
- Update icon/keywords/README; leave the PostgreSQL elephant in place for the PG-specific assets and add a neutral DbStudio mark.
- **Exit criterion:** extension installs under new ID, existing users get silent config/notebook migration, no regression on PG workflows.

**Phase 2 — Dialect extraction for PostgreSQL (2 weeks)**
- Move all 28 files under `src/commands/sql/` behind `PostgresDialect`. The public API that `src/commands/{domain}.ts` consumes becomes dialect-agnostic: instead of `import { TableSQL } from './sql'`, call `getDialect(engine).tables.dropTable(schema, table)`.
- Convert `DatabaseTreeProvider.ts` introspection queries (lines 697, 715, 1031, 1072, 1195-1204 are the worst offenders, plus the 40+ object-type switch at line 1402) to go through `dialect.introspect.*`. Object types gated by `dialect.capabilities` (e.g. `publication` node only renders when `capabilities.supportsLogicalReplication === true`).
- `src/commands/schemaSearch.ts`: replace hard-coded `information_schema.*` + `pg_sequences`/`pg_triggers` queries with `dialect.introspect.search(term)`.
- AI assistant (`src/providers/chat/AiService.ts` lines 86-100): parameterize the "PostgreSQL database assistant" prompt to `buildSystemPrompt(engine)` and have each dialect contribute the engine-specific addendum (SQL flavor hints, EXPLAIN syntax, system-catalog names). `DbObjectService.ts` routes through `dialect.introspect` for @-mentions.
- `src/providers/kernel/SqlExecutor.ts`: the auto-LIMIT at lines 95-100 becomes `dialect.limitClause(n)`. EXPLAIN handlers in `src/services/handlers/ExplainHandlers.ts` delegate to `dialect.explain(sql)`.
- **Exit criterion:** PG test matrix (unit + integration against PG 12-17 via `make test-full`) stays green. No file outside `src/core/db/drivers/postgres/` imports from `pg`.

**Phase 3 — MySQL driver + dialect (3 weeks)**
- Add `mysql2/promise` to dependencies. Implement `MySqlDriver` (pool, streaming via `.stream()`, SSH tunnel reuses the existing generic tunnel code in `ConnectionConfig`).
- Implement `MySqlDialect`:
  - introspection via `information_schema` (schemas = databases, no `pg_catalog` equivalent),
  - `LIMIT` / backtick quoting / no `RETURNING` clause (rewrite INSERT/UPDATE/DELETE templates in `tables.ts` to fetch-after-write),
  - `EXPLAIN FORMAT=JSON` for `ExplainVisualizer`,
  - capability flags: `supportsSchemas=false` (MySQL conflates schema/database), `supportsListenNotify=false`, `supportsPublications=false`.
- Connection form (`src/features/connections/connectionForm.ts`) gets an engine picker; PG-only fields (`pgpass` file) hidden when `engine !== 'postgres'`.
- Tree provider hides nodes whose capabilities aren't supported (publications, tablespaces, event-triggers, pgcron, FDWs, rules).
- Schema designer (`src/schemaDesigner/*`) already delegates through `ConnectionManager` — only type-picker widget and ERD column-type list need a per-dialect type catalog (`dialect.types.list()`).
- Notebook controller label reads engine from connection metadata; result MIME type generalizes to `application/x-dbstudio-result`.
- Integration tests: add `docker-compose` services for MySQL 5.7, 8.0, 8.4 mirroring the existing PG 12-17 matrix in `Makefile`. Credentials `testuser`/`testpass`, DB `testdb`.
- **Exit criterion:** MySQL connection + browse + notebook + saved queries + AI assistant + export + schema designer working; `make test-full` green for PG and MySQL.

**Phase 4 — SQLite (2 weeks)**
- `better-sqlite3` (sync, simpler) or `sqlite3` (async). Choose `better-sqlite3` — VS Code ships compatible Node, simpler API, negligible perf penalty at extension scale.
- `SqliteDialect` introspection uses `sqlite_master` / `PRAGMA table_info(...)`, `PRAGMA foreign_key_list(...)`, `PRAGMA index_list(...)`. No schemas, no roles, no users.
- Connection form: file-picker for `.db`/`.sqlite`/`.sqlite3` paths instead of host/port. `ConnectionConfig.host` becomes optional.
- Capabilities gate most of the left-tree (no roles, no tablespaces, no extensions, no FDWs, no publications, no subscriptions, no event triggers, no cron jobs).
- Single-file ergonomics: right-click `.sqlite` in Explorer → "Open with DbStudio" command.
- **Exit criterion:** SQLite CRUD + tree + notebook + AI + export green in integration tests.

**Phase 5 — MSSQL (3 weeks)**
- `mssql` (tedious) dependency. Windows / Kerberos / SQL auth support.
- `MssqlDialect`: `sys.*` catalog (`sys.tables`, `sys.columns`, `sys.indexes`, `sys.foreign_keys`), T-SQL quirks (`TOP n` vs `LIMIT`, `[bracketed]` identifiers, `sp_help`, `EXEC` for procs).
- `EXPLAIN` → `SET SHOWPLAN_XML ON` + parse XML for the visualizer.
- Capabilities: supports schemas + linked servers (surface as FDW-equivalent?) + SQL Agent jobs (surface as pgcron-equivalent?). Defer those to a "parity sweep" milestone.
- **Exit criterion:** same bar as MySQL.

**Phase 6 — Oracle (4 weeks)**
- `oracledb` (instant client native bindings — note native-dep packaging impact on `.vsix` size and platform matrix). Document install requirements in README.
- `OracleDialect`: `ALL_*` / `USER_*` / `DBA_*` data dictionary views, PL/SQL, `VARCHAR2` / `NUMBER` / `CLOB` type system, schemas-as-users, no booleans.
- EXPLAIN via `EXPLAIN PLAN FOR ... ; SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY())`.
- Per-engine notebook cell hint: `/` terminator for PL/SQL blocks.
- **Exit criterion:** same bar as MySQL.

**Phase 7 — Parity sweep + additional engines (open-ended)**
- CockroachDB, Redshift, Snowflake, DB2, etc. plug in as new `DbDialect + DbDriver` pairs with capability flags tuning which UI affordances light up.
- At this point adding a new engine should be a ~1-2 week effort, since all integration points are abstracted.

---

## Critical files to modify

**New files (core abstraction):**
- `src/core/db/DbEngine.ts`, `DbDriver.ts`, `DbDialect.ts`, `registry.ts`, `capabilities.ts`, `introspection/IntrospectionProvider.ts`
- `src/core/db/drivers/postgres/` — relocate PG-specific helpers (pgpass, SSL fallback, readonly-set SQL)
- `src/core/db/drivers/mysql/`, `sqlite/`, `mssql/`, `oracle/` — one per phase

**Modified in Phase 0-2 (PG still works, just goes through abstraction):**
- `src/services/ConnectionManager.ts` — delegate to `getDriver(engine)`, remove direct `pg` imports
- `src/services/TransactionManager.ts`, `src/services/StreamingQueryService.ts` — accept `DbClient` instead of `PoolClient`
- `src/providers/DatabaseTreeProvider.ts` (1,749 lines) — introspection through `dialect.introspect`, object-type switch at line 1402 gated by capabilities
- `src/providers/Phase7TreeProviders.ts` — same pattern
- `src/providers/kernel/SqlExecutor.ts` — limit clause via dialect, review prompt unchanged
- `src/commands/sql/*.ts` (28 files) — become `PostgresDialect` internals
- `src/commands/*.ts` (~13 files importing `pg`) — use `DbClient` from connection, remove direct driver types
- `src/commands/schemaSearch.ts` — via `dialect.introspect.search`
- `src/providers/chat/AiService.ts` (lines 86-100 system prompt), `DbObjectService.ts` — parameterize by engine
- `src/services/handlers/ExplainHandlers.ts`, `src/providers/ExplainProvider.ts`, `src/providers/ExplainVisualizer.ts` — dialect-driven EXPLAIN
- `src/providers/ListenNotifyPanel.ts` — stays PG-only, gated by `capabilities.supportsListenNotify`
- `src/features/connections/connectionForm.ts` — engine picker, conditional fields
- `src/features/notebook/notebookProvider.ts` (line 113 controller ID, line 115 label, line 144 error), `postgresNotebook.ts` (line 15 language), `notebookExportHtml.ts` (lines 47-48 MIME) — generalize
- `package.json` — rename extension identity, command namespace, config keys, activity bar, add new drivers
- `README.md`, `CHANGELOG.md`, marketplace icons — rebrand

**Reusable as-is (no changes expected):**
- `src/features/savedQueries/*` — already engine-agnostic
- `src/services/SecretStorageService.ts`, `src/features/connections/ProfileManager.ts` — generic
- `src/ui/renderer/*`, `src/renderer/components/table/TableRenderer.ts`, `templates/dashboard/*` — consume `QueryResults` which is already driver-agnostic
- `src/services/handlers/CoreHandlers.ts`, `QueryHandlers.ts`, `MessageHandlerRegistry`, `src/common/htmlStyles.ts`, `notebookTemplates.ts`
- `src/test/unit/mocks/vscode.ts`, `src/test/setup.ts`

---

## Effort estimate

| Phase | Scope | Engineer-weeks |
|---|---|---|
| 0 | Abstraction skeleton, PG passthrough | 1 |
| 1 | Manifest rebrand + migration shims | 1 |
| 2 | PG dialect extraction | 2 |
| 3 | MySQL driver + dialect + integration tests | 3 |
| 4 | SQLite | 2 |
| 5 | MSSQL | 3 |
| 6 | Oracle | 4 |
| **Total to Oracle** | | **~16 weeks** |
| Each additional engine after Phase 6 | | ~1-2 weeks |

Parallelizable if more than one engineer: Phases 0+1 can run concurrently; Phases 3-6 can each run in parallel once Phase 2 lands.

**Answer to "can it be one extension or separate?":** One extension. The 70% reuse number makes separate extensions actively wasteful — every UI, AI, notebook, and saved-query change would have to be ported N ways. The one-time rebrand cost (~2 weeks in Phases 0-1) is much smaller than the ongoing divergence cost of N forks. Per-engine features stay healthy via capability flags, not code duplication.

---

## Verification

**Per phase:**
- `npm run test:unit` — no regression in mocked tests
- `npm run test:integration` with matching Docker services (`make docker-up` extended for MySQL/MSSQL/Oracle/SQLite-in-memory)
- `npm run test:renderer` — jsdom suite unchanged (UI is engine-agnostic)
- Manual smoke in Extension Development Host (F5): connect to each supported engine, browse tree, run notebook cell, save query, invoke AI assistant, export result grid

**Phase 1 specifically — migration safety:**
- Install old NexQL, create connections + saved queries + notebooks, upgrade to DbStudio build, verify connections/saves/notebooks still appear and work
- Verify old command IDs still invoke (deprecated-alias path) for one release
- Verify old `postgresExplorer.*` config values are read and copied to `dbstudio.*`

**Phase 3+ per new engine:**
- Integration test suite mirroring the PG matrix: CRUD, tree navigation, schema introspection parity, notebook execution, EXPLAIN visualization, saved queries, AI-generated SQL round-trip, export CSV/JSON
- Capability-gated features: assert PG-only features (publications, LISTEN/NOTIFY, tablespaces, event triggers, pgcron) don't render in the tree for non-PG connections
- Docker Compose: extend `Makefile`'s `docker-up` to include MySQL 5.7/8.0/8.4, MSSQL 2019/2022, Oracle XE 21c, and use `:memory:` for SQLite
