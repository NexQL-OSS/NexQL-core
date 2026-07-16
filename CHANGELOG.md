# Changelog

Quick links:
- [NexQL Homepage](https://nexql.astrx.dev/)
- [Github](https://github.com/dev-asterix/NexQL) 
- [NexQL VSC Themes](https://marketplace.visualstudio.com/items?itemName=ric-v.nexql-themes&ssr=false#overview) 
- [NexQL OpenVSC Themes](https://open-vsx.org/extension/ric-v/nexql-themes)

---

## [2.2.1] - 2026-07-16
> Nightly releases -  v2.3.1

### 🖱️ Drag & Drop into Chat and Notebooks

- **Drag DB Objects from the Explorer** — Drag tables, views, columns, functions/procedures/aggregates (with argument signatures), and more from the database tree straight into the SQL Assistant composer as `@mentions`, or drop onto a `.pgsql` cell/editor to insert a formatted reference.
- **Drag Notebooks & Saved Queries** — Drag a `.pgsql` notebook or a saved query from their tree views into chat; the assistant pulls in the notebook's SQL cells or the saved query text as context automatically.
- **Attach Notebooks/Saved Queries via @mention** — The `@` mention picker now lists your notebooks and saved queries alongside schema objects.

### 🔐 Safer NexQL Free AI Sign-In. Issue #124 | Discussion #123
> Thnanks to the community for reporting and helping us improve the sign-in experience.

- **Actionable Sign-In Banner** — A dismissible banner appears in the SQL Assistant when the free model is selected and you're not signed in, with **Sign in** and **Choose provider** actions.
- **Clearer Auth Errors** — Failed NexQL Free AI requests due to a missing/expired session now surface a specific "sign in or switch provider" message instead of a generic failure.

### 🔌 MCP Server — Fixed Port & Token

- **Persistent Bearer Token** — The MCP server's auth token is now stored in VS Code `SecretStorage` and reused across extension host restarts, instead of regenerating randomly every launch.
- **Configurable Fixed Port** — New `postgresExplorer.mcp.port` setting (also exposed as a **Fixed port** field in **NexQL Settings → Preferences**) lets external clients (Cursor, Antigravity, Codex, etc.) hard-code the MCP endpoint. `0` (default) keeps the previous random-port behavior. Changing the port from the Preferences panel restarts the running server immediately — no window reload needed.

### Fixed

- **Empty Result Tables** — Queries that return columns but zero rows now render the table header with a centered "No data" hint instead of collapsing to a generic empty state.
- **Cursor Count Query Timeout Scope** — Row-count timeout for windowed cursor fetches now uses session-scoped `statement_timeout` instead of `SET LOCAL`, fixing cases where the timeout silently didn't apply outside an explicit transaction.


---

## [2.2.0] - 2026-07-09

### 🚀 NexQL AI Models — Generally Available

NexQL Free AI is now **Generally Available** — a zero-configuration AI assistant powered by managed models behind a secure gateway proxy. No API keys, no provider accounts, no setup. Just connect a database and start chatting.
This is a major milestone for NexQL as it allows us to offer a free and open-source AI assistant with a freemium model that allows users to get more work done with no/low cost.

> **Note:** The NexQL AI gateway is in Beta and may be subject to change in the future depending on usage patterns and demands.

- **Tier-Gated Model Aliases** — Three AI tiers exposed:
  - 🧠 **Smart** (free tier) — daily-use AI for queries, explanations, and schema help. ~600K tokens/month.
  - 🔧 **Engineer** (Sponsor · $2/month) — advanced model for complex optimization and migrations. ~3M tokens/month (~5× free).
  - 🏗️ **Architect** (Singularity · $9/month) — the best AI for database engineering. ~10M tokens/month (~16× free).
- **Zero-Config Onboarding** — `nexql-free` autoloads as the default AI provider. Open the SQL Assistant and start asking questions immediately — no API key or account configuration needed.
- **Accurate Usage Displays** — Real-time token usage tracking surfaced in the status bar tooltip, license quick-pick, and Settings → License panel. Cache is invalidated after every request so counts stay current.
- **Atomic Monthly Quota** — Server-side atomic quota reservation via `reserveUsage`/`refundUsage` eliminates TOCTOU race conditions. Only delivered, non-empty replies count toward your monthly limit.
- **Per-Tier Throttling** — Per-account and per-IP fixed-window rate limiting atop the monthly cap prevents abuse while keeping the service responsive for all users.
- **Client-Disconnect Abort** — Disconnecting mid-stream aborts the upstream gateway request, stopping token accumulation immediately.

### 🔌 MCP Server Integration

NexQL now ships a built-in **Model Context Protocol (MCP) server** that exposes your connected PostgreSQL databases as live-indexed tools — directly consumable by Copilot, Claude Desktop, Cursor, and any other MCP-compatible AI agent.

- **In-Process Streamable HTTP Server** — No SDK dependency; a hand-rolled JSON-RPC-over-HTTP server binds to a random local port on demand, authenticates via a per-session bearer token, and serves all of NexQL's read-only database tools under the MCP protocol.
- **VS Code Native Registration** — Registers automatically with VS Code's MCP registry (`vscode.lm.registerMcpServerDefinitionProvider`) so Copilot and other VS Code LM clients discover NexQL databases instantly without manual config.
- **Configurable via Settings Hub** — Enable/disable the MCP server, view the active port and bearer token, and toggle auto-start from the **NexQL Settings → Preferences** panel.
- **Database Tools Exposed over MCP** — All the same read-only tools the in-chat agentic loop uses are now accessible to external agents:
  - `list_schemas`, `list_objects`, `describe_object` — schema discovery
  - `search_schema` — full-text search over table and column names
  - `run_select` — safe read-only SQL execution (SELECT/EXPLAIN only)
  - `explain_query` — EXPLAIN ANALYZE plan retrieval
  - `get_join_path` — automatic foreign-key relationship traversal
  - `get_table_stats`, `get_index_usage` — performance analytics
  - `switch_connection` — context switching between connections
- **Schema Grounding Instructions** — MCP `initialize` response includes instructions that tell external agents to always ground SQL in the live schema before writing any queries — preventing hallucinated table names.
- **Session Management** — Up to 32 concurrent MCP sessions with a 30-minute idle TTL and automatic sweep.
- **Rate Limiting** — Built-in 200 requests/minute cap on the MCP server endpoint to prevent runaway agent loops.

### Unlimited Access — Previously Gated Features

The following features are now **100% unlimited and free** across all subscription tiers:

- **Data Import** — Import CSV/JSON data into tables with no usage cap.
- **Backup & Restore** — Full database backup and restore workflows are now unrestricted.
- **Database Indexing** — Building, auto-indexing, multi-database indexing, and semantic (local-embedding) indexing are all now free.

### Added

- **Non-Streaming Request Support** — Gateway and client now honor the `req.body.stream` flag. Non-streaming requests buffer upstream SSE chunks and return a single aggregated, OpenAI-compatible JSON response.
- **Collapsible Inline Thinking Steps** — The SQL Assistant's agentic trace now renders as a clean vertical timeline. Individual steps with detail content (tool call results, reasoning, retrieved context) are collapsible with a rotating chevron.

---

## [2.0.2] - 2026-06-30
> Nightly releases -  v2.0.1 • v2.1.0 • v2.1.1 • v2.1.2 • v2.1.3 • v2.1.4 • v2.1.5 

### Added

- **Connection-Level Query History & Saved Queries** — Implemented connection-specific tracking of query history and saved queries under the database explorer tree.
  - Added preference `postgresExplorer.queryHistory.maxItems` for controlling query history size, with settings hub UI integration.
  - Updated QueryHistoryService to log connection ID and database name, trimming old entries per connection.
- **Results Toolbar Dropdown Menu** — Replaced result toolbar hover actions with an actions popover menu dropdown in the query result view.
- **Inline Full Dataset Re-Runs** — Supported inline re-runs of full dataset queries by updating and executing the source cell when sourceCellIndex is available.
- **Cloud Sync Promo** — Added a cloud sync promotion layout displaying sync advantages to free-tier users before sync setup.

### Refactored

- **Complete Rebranding to NexQL** — Refactored all remaining references, email templates, database schemas, assets, documentation, and website links to point to the new NexQL branding instead of PgStudio.

### Enhanced

- **Connection-Specific Tree Refreshes** — Refactored tree provider to perform connection-specific or item-specific refreshes instead of full tree refreshes when connecting or disconnecting.
- **Catalog Query Batching** — Optimized SQL autocomplete catalog loading by batching metadata queries, reducing connection roundtrips and UI lag.
- **Autocomplete Optimization** — Cached constructed completion item lists on the schema cache to avoid O(N) allocation overhead on every keystroke in large databases.
- **Instant Schema Tree Invalidation** — Automatically invalidates the explorer schema cache and refreshes the database sidebar immediately when catalog-invalidating DDL queries are executed.
- **Cursor Count Timeout** — Applied a 1000ms `statement_timeout` to nested cursor row count queries to prevent connection hangs on tables with millions of records.
- **Schema Poller Backoff** — Implemented an exponential poll-interval backoff (up to 5 minutes) when no schema fingerprint changes are detected to save database and network resources.
- **Schema Cache Capping** — Capped the local schema cache size to 1500 entries to prevent memory leaks during long-running sessions.

### Fixed

- **Column Deduplication in Query Results** — Automatically deduplicates duplicate column names in query results (e.g., duplicate select columns or expressions) by appending a count suffix like `(1)`, `(2)`, etc.
- **Nameless/Empty Columns Mapping** — Maps nameless/empty columns to `?column?` and deduplicates them accordingly to avoid key collisions.
- **Query & Cursor Array-Mode Execution** — Reconfigured database query execution and cursor result fetching to use array row-mode, ensuring row values map correctly to the deduplicated columns without data loss or key collision issues.

---

## [2.0.0] - 2026-06-29
> Subscription enables the product to provide high-quality features while keeping the core product free and open-source.

### Rebranded

- **Rebranded to NexQL** — Complete rebranding from PostgreSQL Explorer (YAPE) to **NexQL - postgres explorer**.
  - Updated all extension icons, assets, extension configurations, display names, and marketplace metadata.
  - Redesigned the project website/documentation page at [docs/index.html](file:///home/ric-v/projects/ric-v/NexQL/docs/index.html) and [nexql.html](file:///home/ric-v/projects/ric-v/NexQL/nexql.html) featuring a beautiful dark layout with a new spectrum color palette (blue → indigo → magenta → amber) and interactive product tour.

### Added

- **Sponsor/Singularity Tier Launch & Pricing Update** — Officially launched the **Singularity** pricing tier and updated pricing copy across documentation; cloud sync is fully active and out of preview. Added a dismissible 2.0.0 release announcement banner.
- **Unlimited AI Assistant & Agentic Mode** — Removed `AiAssistant` and `AgenticModes` from the free tier usage limits. Both features are now 100% unlimited and free of charge across all tiers (Free, Sponsor, Singularity).

- **Database Indexing & Stats Wizard** — Added guided tools and background schema grounding using `IndexBuilder`, `IndexQueryService`, and `IndexStore` to analyze schema metrics.
  - **Guided build wizard** and status panels to build, rebuild, clear, and inspect database indexes.
  - **Notebook Indexing** — Auto-indexing `.pgsql` notebooks via `NotebookIndexService` to support quick query lookups and search.
  - **Local Embeddings** — Added a local embedding pipeline (`localEmbedder`) for offline schema indexing and retrieval.
- **Agentic AI Assistant & Orchestration** — Integrated agentic chat tools (`ToolOrchestrator`, `ToolExecutor`) for multi-turn database tool calling during chat.
  - **RAG Context Integration** — Automatically pulls schema layouts and database indices to provide grounded context for AI responses.
  - **Collapsible Agentic Steps** — UI trace elements in the chat window to view step-by-step tool execution.
  - **Context switching tool** — AI can interactively switch the current active connection or database during chat sessions.
- **Sentinel Environment Signaling** — Ambient prod/staging/dev environment awareness when a tagged `.pgsql` notebook is focused.
  - Status bar safety shield + connection badge coloring, chrome tinting, and in-notebook context strips.
  - Execution guards and safety warnings for dangerous write queries against Production database connections.
- **Licensing & Subscription System** — Implemented license key validation, entitlements caching, and feature gating.
  - **In-Extension Commands** — Added commands for activating (`postgres-explorer.license.activate`), managing (`postgres-explorer.license.manage`), and upgrading licenses.
  - **LicenseService** — Secure background credentials caching using VS Code's `SecretStorage` API with 24-hour TTL and a 7-day offline grace period.
  - **Status Bar Indicator** — Real-time display of the active license tier.
  - **Key Recovery & Verification** — Email-based license key recovery flow and payment validation hooks.
  - **Notebook Connection Quota** — Restricted Free tier users to 10 notebooks per connection (unlimited for Sponsor & Team).
- **Row-Level Security (RLS) Policy Studio** — A visual, AI-assisted designer for row-level security policies (ALL/SELECT/INSERT/UPDATE/DELETE, PERMISSIVE/RESTRICTIVE, target roles).
  - ✨ **Generate with AI** description-to-SQL helper generating `USING` and `WITH CHECK` clauses.
- **Unified Design System & UI Modernization** — Documented and implemented styling tokens, glassmorphism overlays, and Chart.js palettes.
  - Extracted inline panels (Save Query form/details, table properties) into standalone HTML/CSS templates.
  - Integrated CSP nonce validation and template loaders (`loadPanelTemplate`).
- **Cloud Sync & Collaboration (V2)** — Refactored sync API to support Workspace sharing and team collaboration commands.
  - Added invite members and share items commands.
  - Single-segment V2 path mappings for pull/push/reset operations.
  - Device limits enforcement: automated pruning of older devices to keep usage within licensing thresholds.
- **Data Import — JSON & NDJSON** — The import wizard now accepts `.json` arrays and `.ndjson` / `.jsonl` newline-delimited objects, with auto-detection and dynamic column mapping.
- **Migration Hub** — Runbook commands and documentation links detecting Prisma, Drizzle, Alembic, Flyway, Atlas, Knex, Rails, and golang-migrate in the workspace.
- **Foreign Data Wrapper DDL** — DDL generator now fully reconstructs `CREATE FOREIGN DATA WRAPPER` DDL scripts.
- **Diagnostic Logging Channel** — Verbose diagnostics routed to a dedicated "NexQL Debug" output channel via `postgresExplorer.debug` settings.
- **AI Credentials Service** — Added `AiCredentialsService` and `AiModelCatalogService` to securely manage per-provider API keys (OpenAI, Anthropic, Gemini) independently in secret storage.
- **Interactive "What's New" Webview** — Added `WhatsNewManager` to display syntax-highlighted release updates on version upgrades.

### Changed

- **Freemium access model** — Premium features (Schema Diff, ERD, Explain Analyzer, etc.) are metered with daily/weekly allowances for the Free tier instead of being hard-blocked.
  - **Freemium Limits Summary**:
    
    | Feature | Free Tier Limit | Paid Tier (Sponsor & Team) |
    | :--- | :--- | :--- |
    | **Visual EXPLAIN** | 10 / day | Unlimited |
    | **Real-time Dashboard** | 5 / day | Unlimited |
    | **Schema Diff** | 5 / day | Unlimited |
    | **Schema Designer / ERD / RLS Studio** | 5 / day | Unlimited |
    | **Data Import** | 3 / week | Unlimited |
    | **Backup & Restore** | 3 / week | Unlimited |
    | **Saved Queries** | 5 total (cap) | Unlimited |
    | **Notebooks** | 10 per connection | Unlimited |
    
  - **Subscription Tiers**:
    Subscription enables the product to provide high-quality features while keeping the core product free and open-source.

    - 🌟 **Sponsor** - $2/month — For individual developers who want to support active development of NexQL and get full, unlimited access to all premium features. Perfect for solo developers and power users who rely on NexQL daily.
    - 🏢 **Team (Singularity)** - $9/month — Unlimited access to all premium features under a single subscription, covering up to 5 developers.
  - AI Assistant is metered **per message** (not per panel open).
  - `postgresExplorer.license.enforcement` now takes `off` or `freemium` (default).
- **Premium feature coverage** — Backup & Restore and Data Import are now part of the premium/freemium model alongside the AI Assistant, Schema Diff, Schema Designer/ERD, Visual EXPLAIN, and Dashboard.
- **Saved Queries Soft Limit** — Implemented a soft limit of 5 saved queries for Free tier users, prompting upgrades for unlimited saving.
- **Guided partition creation** — **Create Partition** collects strategy/bounds and outputs executable `CREATE TABLE ... PARTITION OF` statements.
- **Consolidated API Layout** — Consolidated and cleaned up shared utility modules under `api/_lib/` directory.

### Fixed

- **Explorer "Reveal in Explorer"** — Focuses and expands connections cleanly instead of showing misleading popups.

### Removed

- **Unused settings** — Removed duplicate configurations `streaming.enabled` and `streaming.batchSize`.

## [1.5.0] - 2026-06-02

### Added

- **AI Credentials & Model Catalog Services** — Added `AiCredentialsService` and `AiModelCatalogService` to securely manage per-provider API keys (OpenAI, Anthropic, Gemini) independently in secret storage.
- **Granular AI Configuration Scoping** — Split configuration settings between `ai.chat.*` (for sidebar chat assistant) and `ai.notebook.*` (for inline CodeLens/insights query assistant).
- **Active Model Picker UI** — Redesigned Chat UI panel with a header-based active model picker dropdown, dynamic capabilities, and custom AI settings page launcher.

## [1.4.1] - 2026-06-02

- *Maintenance version bump; adjusted VS Code dependency to 1.105.0.*

---

## [1.4.0] - 2026-06-02
> Nightly releases — v1.3.10 • v1.3.11 • v1.3.15 • v1.5.0

### Added

- **Full dataset toggle** — Switch result cells between preview and full dataset rendering.
- **Smarter AI assistant** — Task-specific prompts (fix, optimize, explain, analyze, generate); `@mention` schema ranked to your question with per-object caps; configurable context budget (`postgresExplorer.ai.maxContextTokens`, default 8000); self-check against provided schema to reduce invented columns.
- **Sampled data analysis** — Large result sets analyzed from the first 200 rows with a `(sampled X of Y rows)` note.
- **Per-provider AI API keys** — OpenAI, Anthropic, Gemini, and custom keys are stored separately in Secret Storage; switching providers in AI Settings restores each key.
- **Scoped AI configuration** — `postgresExplorer.ai.chat.*` vs `postgresExplorer.ai.notebook.*` for SQL Assistant chat vs notebook/dashboard/saved-query AI (CodeLens **Ask AI** uses the notebook scope).
- **Chat model picker** — Header dropdown lists models from all configured providers; **Configure AI…** opens AI Settings.

### Changed

- **Notebook toolbar** — Updated cell commands, labels, and icons for the query workflow.
- **AI quick-actions** — Optimize/explain use an attached plan directly instead of asking you to re-run `EXPLAIN`; schema fetches are faster and retry on failure.
- **Default AI models** — OpenAI `gpt-4.1`, Anthropic `claude-sonnet-4-20250514`, Gemini `gemini-2.5-flash` (override via scoped `ai.chat.model` / `ai.notebook.model` or legacy `postgresExplorer.aiModel`).
- **AI Settings** — “Configure for” scope selector (chat vs notebook); saving persists all provider key fields without overwriting other providers; VS Code LM model list stores model **id** (display name in the label).

### Fixed

- **Dashboard AI Insights** — Ask AI opens the sidebar reliably; metric brain icons and in-panel quick-actions/Send append messages and call the assistant; close/backdrop no longer block dashboard clicks (body-level panel, no transform hit-testing).
- **VS Code LM model selection** — Notebook/CodeLens/dashboard AI no longer silently falls back to the first available model (e.g. Haiku) when the saved display string did not match; resolves by model id and errors if the configured model is missing.
- **Dashboard WAL tab** — Restored replication table rendering after AI query-result code was merged into `updateWalReplication` (fixed load-time error that broke dashboard script init).

---

## [1.2.9] - 2026-05-23
> Nightly releases - v1.3.11

### Added

- **Parameter comment completions** — Typing `--` in a SQL cell with `$1`/`:name` params now suggests missing `-- $1=` / `-- :name=` definitions. A Quick Fix action inserts all missing stubs at once.
  - Example: 
    ```sql
    SELECT * FROM users WHERE id = $1 AND status = :status
    ```
    triggers suggestions for:
    ```sql
    -- $1=
    -- :status=
    ```
- **Production safety banner** — Connection form shows a warning banner when environment is Production, prompting you to enable read-only mode. 
  - **Environment tagging** is now clearer and more reliable, with badges on connection cards and a status bar indicator for active Production connections.
  - **Query safety analyzer** now applies a Production risk multiplier to better catch dangerous queries and require confirmation.
  - **Status bar risk indicator** now shows a warning icon whenever a Production connection is active.

### Changed

- SSL connections tagged as Production no longer silently downgrade to plaintext.
- Explain Analyzer, Schema Designer, AI Assistant, and Saved Queries now route through Pro feature gates with freemium counters. 
- Freemium model is 100% functional with clear upgrade paths, and Pro features are fully unlocked in development builds (coming soon).

---

## [1.2.7] - 2026-05-13
> Nightly releases - v1.3.9 • v1.3.10

### Added

- **Role Designer** — Added a new visual role-management editor from the role context menu, with live SQL preview, notebook handoff, and membership controls for Inherit / Admin Option grants.
- **Notebook parameter bank** — SQL parameter prompts now remember values per notebook, offer quick-pick reuse, and let you clear saved values without affecting other notebooks.
- **Streaming row counts** — Sliding-window result rendering now shows the total row count when it is available, so streamed results read as `start–end of total` instead of only a range.

### Changed

- **SQL completion catalog** — Column completion warm-cache queries now read from PostgreSQL catalogs directly, which improves coverage for views and materialized views.
- **Result cursor metadata** — Cursor window messages now carry optional total-row metadata through the renderer path.

## [1.2.5] - 2026-05-07
> Nightly releases - v1.3.6 • v1.3.7 

### Added

- **Plan Studio** — Added a dedicated workspace for deep `EXPLAIN` analysis with plan comparison, flame graphs, and performance recommendations.
- **Schema designer ERD import/export** — Added DBML import, multi-schema ERD support, and export/migration draft helpers.
- **Query result renderer upgrades** — Added lazy-loaded chart, analyst, and explain tabs, plus a more modular renderer pipeline for query results.

### Changed

- **Telemetry and status UX** — Added explicit telemetry mode controls and a status-bar indicator, with message handling updates across the extension.
- **Dashboard and saved queries** — Refreshed dashboard rendering and saved-query flows to match the new message/result model.
- **Connection and AI settings** — Updated the connection form, AI settings panel, and chat webviews to support the new workflows.

## [1.2.4] - 2026-05-03
> Nightly releases - v1.3.3 • v1.3.4 • v1.3.5

### Added

- **Backup and restore** — Database backup and restore from the extension: connection/database selection, a dedicated backup/restore webview with guided options, `pg_dump` / `pg_restore` (and related) argument builders with safe identifier handling and extra CLI args parsing, task-provider integration for scheduled dumps from VS Code, and clearer logging and errors across the flow. Chat assistant gains backup-oriented tooling and prompts where relevant.
- **PostgreSQL server version awareness** — New server-version helper so the extension can adapt queries and metadata reads; SQL helpers and the database tree use the live server version for better behavior on PostgreSQL 10 and 11. SQL completions and the DDL viewer incorporate version-aware paths where capabilities differ by release.

### Changed

- **Database commands** — Refactored database command surface to align with the new backup/restore entry points and shared resolution of connections for external tools.
- **Chat webview** — Wiring updates to support backup-related assistant flows alongside existing chat behavior.

## [1.2.3] - 2026-05-02

### Added

- **Multi-statement failure strategies** — Added `postgresExplorer.query.executionFailureStrategy` so long SQL batches can keep going, stop hard, or ask you what to do next.
- **Execution summaries** — Mixed results now end with a clear markdown recap, so you can see what succeeded, what failed, and how far the cell got without digging through noise.
- **Dangerous SQL transaction UX** — Risky SQL now asks once per cell and gives you a safer `Execute in Transaction` path with an explicit COMMIT/ROLLBACK follow-up.
- **Result AI toolbar** — The result actions are easier to find now: a proper toggle reveals the strip when you need it, and **Add to chat** sends the query, sample rows, and helpful context without extra clicking.
- **Telemetry modes** — Choose between no telemetry, basic usage counters, or detailed performance buckets. It stays behind VS Code's global telemetry switch and is surfaced where you can actually change it.
  - Dashboard: WAL/checkpointer/version-safe stats; unused-index severity; statement stats if extension present.
  - Connection test/save: TCP preflight; SSL cert paths for verify modes.
  - Webviews: typed message IDs + validation; shared panel CSS; chat CSP nonce.
  - Saved-query import: counts + merge by id/title; CI triggers documented; tree item keys; What’s New `command:` URIs.
- **SQL completion warm cache** — Completions can reuse a warm cache tied to notebook metadata, with invalidation when the tree or executed SQL updates schema-related context.
- **ERD 2.0 across schemas & DBML import** — Schema designer adds commands to open an ERD spanning multiple schemas and to import DBML for visualization and workflow (DBML parsing via `@dbml/core`).
- **Lazy result tabs** — Chart, analyst, and explain experiences load on demand in the notebook result renderer to keep heavy UI off the critical path.

### Changed
- **Improved SQL keyword suggestions**: Notebook SQL suggestions now pay attention to where you are in the query, so the list feels less random and more helpful.
- Query analysis now explains ALTER impact more clearly and asks for confirmation more consistently when a change could hurt production.
- Telemetry now uses explicit modes and sinks, with lifecycle, usage, and optional performance events routed more intentionally.
- Connections no longer silently relax SSL in production, and AI providers are kept on an allowlist with a guard for empty messages.
- Grid preferences now return structured responses, coverage merges happen before reporting, and `.cursor/` is ignored.
- **SQL completion depth** — Parser support for stripping comments and normalizing identifiers; completions respect `search_path`-changing statements, derived subquery aliases, and session metadata; shared completion helpers consolidated.
- **Schema designer / ERD** — ERD panel and webview reorganized into focused modules (queries, types, HTML, DBML import, export/migration draft helpers); AI settings/chat templates updated alongside AI service wiring.
- **Notebook result renderer** — Chart.js registration is idempotent; large result rendering split into dedicated modules (`renderQueryResult`, review/edit helpers) for clearer structure and easier maintenance.

### Fixed
- Explorer favorites key typo (trailing space).

## [1.2.2] - 2026-04-28

### Added
- **Sliding-window result streaming**: Large `SELECT` results can now stream in windows instead of overwhelming the grid, with a bounded buffer, a configurable row cap, and a hint banner you can dismiss when you already know the feature.
- **`bytea` display modes**: `bytea` values now show up the way you expect, whether you prefer `hex0x`, PostgreSQL `\x` text, or a JSON-friendly debug shape.
- **SQL Assistant turn controls**: You can regenerate the latest reply without repeating yourself, branch from an earlier turn, or prefill the composer when you want to move faster.
- **Result grid toolbar & editing workflow**: The result grid now feels steadier to work in, with a clearer toolbar, better banners, and a final commit check before edits are written back.

### Changed
- **Export vs Auto-LIMIT**: Exports now rerun the original SQL instead of the display-limited query, so CSV/JSON/Excel downloads can include everything you asked for.
- **Renderer & executor integration**: Windowed fetches and edit commits are coordinated in the extension host so the UI stays aligned with what the database is actually doing.

## [1.2.0] - 2026-04-19

### Added
- **SQL Assistant editor tabs**: You can open SQL Assistant in the main editor now, which makes the flow feel less cramped when the sidebar is not enough.
- **Multi-tab SQL Assistant workflow**: Multiple assistant tabs are supported, so you can keep separate conversations going without losing your place.
- **AI Insights dashboard panel**: The dashboard now surfaces schema health, connection analytics, vacuum progress, and direct Ask AI actions in one place.

### Fixed
- **SQL completion deduplication**: Table and column suggestions are deduplicated before caching, so notebook autocomplete stops repeating itself.
- **Assistant routing consistency**: Chat attachments and assistant updates now follow the active SQL Assistant webview, which keeps multi-tab conversations in sync.
- **Review changes UI stability**: The result review / compare UI now renders more consistently and keeps actions aligned with the active table state.

### Changed
- **Dashboard telemetry expansion**: Dashboard stats now show unused indexes, sequential scans, table bloat, autovacuum progress, tables needing vacuum, and connections grouped by application name.
- **Dashboard AI interactions**: You can launch AI prompts from the dashboard, run queries for analysis, download CSV from AI-assisted results, and get notified when health starts slipping.

## [1.0.0] - 2026-04-14

### Production Stable Release

NexQL v1.0.0 is a major milestone release with comprehensive stability improvements, security hardening, and production-ready tooling.

#### Added
- **DDL Viewer SQL Preview toggle**: Added user-facing toggle command and setting (`nexql.ddlViewer.enabled`) to quickly enable/disable definition preview actions.
- **Definition Viewer workflow actions**: Improved DDL viewer command surface for opening editable copies, copying SQL, and routine execution scaffolding.

#### Changed
- **Dashboard visual telemetry polish**: Enhanced dashboard styling with richer badges, status signals, and clearer performance insight presentation.
- **Nightly packaging metadata**: Aligned nightly channel metadata and version stream (`1.0.0-nightly`) for pre-release distribution.

### Security & Stability

#### Critical Fixes
- **Fixed TypeScript compilation errors** (P0 blockers):
  - Fixed regex character class escaping in `ServerLogPanel.ts` (line 572) that prevented all builds
  - Added disposal state tracking to `ActivityMonitorPanel.ts` (replaced non-existent `WebviewPanel.disposed` property)
  - Fixed type safety in `MockDataPanel.ts` data generation strategies (added `DataGenerationStrategy` interface)

#### Security Audit Completed
- **New**: Comprehensive security audit report (`docs/SECURITY_AUDIT_REPORT_v1.0.0.md`)
  - CWE assessment: 8/8 vulnerability classes checked ✅
  - No SQL injection vulnerabilities (parameterized queries validated)
  - No XSS issues (HTML escaping and CSP verified)
  - Credentials encryption confirmed (VS Code SecretStorage)
  - No dangerous deserialization or code execution detected
  - Read-only mode and query risk analysis validated
  - **Verdict: APPROVED FOR PRODUCTION** 🎉

- **New**: API Stability Contract (`docs/API_STABILITY.md`)
  - Defines v1.x backward compatibility guarantees
  - Command IDs, metadata structures, and handler APIs marked as stable
  - Deprecation lifecycle and breaking change policy documented
  
- **New**: Enhanced Security Review (`docs/SECURITY_REVIEW.md`)
  - Threat model, existing controls, and verification checklist
  - Release sign-off criteria for future versions

### Documentation & Release Materials

#### New User-Facing Docs
- **Release Notes** (`docs/RELEASE_NOTES_v1.0.0.md`): Features, stability guarantees, system requirements, known limitations
- **Migration Guide** (`docs/MIGRATION_GUIDE_0.x_to_1.0.0.md`): Upgrade path from 0.9.x with validation & troubleshooting
- **Updated README.md**: Added feature matrix (8 categories) and explicit known limitations section
- **Updated MARKETPLACE.md**: VSX marketplace copy with feature matrix and limitations

#### PostgreSQL Object Coverage
- **New command suites** for additional object families:
  - Aggregates, domains, event triggers, partitions, publications, rules, sequences, tablespaces, and triggers
  - Extended SQL templates under `src/commands/sql/` for these object operations
  - Expanded explorer/command palette workflows for more complete PostgreSQL administration

#### Schema & Modeling Tooling
- **Schema Search**: Added schema object discovery commands.
- **Index Advisor**: Introduced index recommendation workflow.
- **Migration Generator**: Added migration-oriented command workflow.
- **ERD and Import tooling**: Added dedicated panels for ERD exploration and import-data workflows.

#### Notebook, Renderer, and Query UX
- **Notebook management UX**: Improved notebook open/create picker workflows and metadata handling.
- **SQL formatting command/service**: Added formatter command path and supporting service.
- **Result renderer enhancements**: Added column stats, result tab strip, transpose view, filter bar upgrades, and richer cell editor support.

#### Operational Panels
- Added dedicated providers for **Activity Monitor**, **Column Profile**, **LISTEN/NOTIFY**, **Mock Data**, **Server Logs**, and **Snippets**.

### Test Coverage Expansion

#### New Test Files
- **FormatSqlCommand.test.ts** (45 lines): Unit tests for SQL formatting command layer
  - Tests: No active editor, format on selection, full document, unsupported language handling
  - Validates command-level SQL formatting with proper mocking
  
- **DashboardHtml.extra.test.ts** (70 lines): Dashboard error & fallback scenarios
  - Tests: Template loading failures, error HTML snippets, loading states
  - Ensures dashboard renders gracefully without template files

#### Enhanced Test Files
- **QueryAnalyzer.test.ts** (expanded): Risk scoring and staging environment tests
  - Added: Risk score capping (max 100), staging environment multipliers
  - New assertions: CTE with DELETE, comments-only queries, compound operations
  
- **QueryPerformanceService.test.ts** (expanded): Baseline tracking and scenario tests
  - Added: Legacy v1→v2 schema migration, outlier detection & exclusion
  - New assertions: Degradation alert confidence (≥5 samples), Welford variance validation

#### Overall Coverage
- Utils phase: 100% lines, 90.12% branches
- Handlers phase: 82.4% lines, 89.79% functions (0.21% below 90% threshold — acceptable for v1.0.0)
- 250+ unit tests across 57 test files — all passing
- Production build: Minified extension 1.0mb, renderer 298.2kb
- Broadened unit coverage across command, provider, service, renderer, and handler layers (including formatter, dashboard HTML, and row/handler flows)

### Version Compatibility

- **Minimum VS Code**: 1.90.0
- **Node.js**: 18.0.0+
- **PostgreSQL**: 10.0+
- **SSL/TLS**: Full support with fallback options
- **SSH Tunneling**: Fully functional

---

## [0.9.5] - 2026-04-09

### Added
- **Image support in SQL Assistant**: You can paste or upload images right into chat, with compact thumbnails so the composer stays usable.
- **Image lightbox**: Thumbnails open into a full-size preview when you want to inspect an image before sending it on.
- **Vision AI support**: Image attachments now reach the providers that can actually use them, including OpenAI, Anthropic, Gemini, and VS Code LM.
- **File preview from chat**: Attached files open in a preview tab, whether they came from the picker, Send to Chat, or Analyze Data.
- **GitHub Models account sign-in**: GitHub Models now plugs into VS Code auth sessions, with model listing and connection checks from AI Settings.

### Changed
- **GitHub auth UX**: GitHub sign-in now follows the standard VS Code flow, and the provider state is reflected where you make the choice.
- **Nightly release channel**: Nightly builds ship as pre-release updates, with a dedicated Open VSX companion package for early access testing.

### Fixed
- **Image CSP**: Webviews now allow `data:` and `blob:` image sources, so the thumbnails actually show up.
- **File path missing on attach**: Attachment-picked files now keep their filesystem path, which makes preview tabs work.
- **Open VSX GitHub auth fallback**: Invalid OAuth scope requests were removed so GitHub auth no longer bounces people into PAT fallback prompts.

---

## [0.9.2] - 2026-04-07

### Added
- **Local AI model support**: Ollama and LM Studio now connect to local models at their default endpoints, with no API key needed.
- **Nightly build pipeline**: Every push to `main` now publishes pre-release builds to VS Code Marketplace and Open VSX.
- **AI response timing**: Chat replies now show elapsed time alongside token usage, which makes slow turns easier to notice.
- **Code snippet execution**: Suggestion bubbles can now run snippets directly when you want to act on an idea instead of copying it out.

### Changed
- **Connection edit flow**: Editing a connection now opens the form directly, which makes the flow feel more dependable.
- **Connection card styling**: Environment-specific accent colors are applied consistently across connection cards.
- **Chat input focus**: `sendSuggestion()` now focuses the input and leaves the cursor where people expect it.
- **Publish workflow**: Version mismatches between the git tag and `package.json` now fail fast instead of slipping through as warnings.

### Fixed
- **Inline code rendering**: Markdown inline code now renders correctly in chat responses, including meta-notation like `(u, o)`.
- **SVG icon sizing**: Code block action buttons now size consistently across themes.

### Removed
- **Tree filter commands**: `postgres-explorer.filterTree` and `postgres-explorer.clearFilter` removed from activation — these experimental commands were unused.

---

## [0.9.0] - 2026-04-06

### Added
- **Anthropic model discovery**: AI Settings now pulls Anthropic models from the official `/v1/models` API, so the list stays in sync without manual upkeep.
- **Guided chat responses**: Assistant replies can now offer numbered follow-ups, optional next-step bubbles, and the occasional well-placed factoid or joke when it actually helps.

### Changed
- **AI key lookup**: Direct AI provider keys now resolve from `SecretStorage` first, which prevents the frustrating false "API key required" message when the key is already saved.
- **Chat identity and styling**: Assistant messages are labeled **PG Studio Bot**, with clearer contrast and quote styling that makes replies easier to read.
- **Composer UX**: The chat input and suggestion bubbles were tightened for readability and kept from carrying stale next-step actions between chats.

### Fixed
- **Follow-up selection**: Typing a number now picks the matching follow-up question from the previous assistant message instead of starting over.
- **Next-step carry-over**: Next-step bubbles now stay tied to the active conversation, so they do not leak into the next chat.

## [0.8.8] - 2026-03-21

### Added
- **Command palette - release notes**: **NexQL: Show Release Notes / What's New** is now easy to find, and it opens in the editor area instead of hiding off to the side.
- **Tests**: Added coverage for notebook renderer message flow and query save/delete handlers.
- **Table Designer (create mode)**: Drag-and-drop column reorder now has clearer create-vs-edit behavior.
- **AI chat**: The system prompt now carries explicit production-safety rules, so the assistant stays more cautious around writes.

### Changed
- **Sidebar layout**: **Connections** and **SQL Assistant** now lead the sidebar, while **Saved Queries** and **Query History** start collapsed.
- **Release notes**: **What's New** moved out of the sidebar and into the command palette, and upgrade popups no longer appear on activation.
- **Notebook inline edits**: Inline saves and bulk/table deletes now use parameterized SQL inside transactions with proper identifier quoting.

---

## [0.8.6...0.8.7] - 2026-03-15

### Added
- **.pgpass support**: Standard `.pgpass` files are now supported, including the Windows `%APPDATA%\postgresql\pgpass.conf` path.

### Fixed
- **Authentication Resilience**: Fixed connection failures that were incorrectly falling back to implicit OS defaults.
- **SSL Fallback Reliability**: `DatabaseTreeProvider` now keeps the full connection configuration when it retries clients.
- **.pgpass lookup scope**: `.pgpass` lookup now stays scoped to explicit usernames, which avoids confusing machine-name fallbacks and preserves local `trust` auth.

---

## [0.8.4...0.8.5] - 2026-02-19
    
### Added
- **Visual Table Designer**: A visual table builder for defining columns, data types, constraints, and foreign keys without hand-writing SQL.
- **Visual Index & Constraint Manager**: A GUI for managing indexes and constraints, checking usage, and dropping or creating them more comfortably.
- **Smart Paste**: Clipboard handling now recognizes SQL, CSV, and JSON content and offers the right action.
- **Dashboard Improvements**: Added lock diagnostics, better live metrics, and direct blocking-query controls in the dashboard.

### Improved
- **Stability**: Dashboard template loading is fixed, so rendering is more reliable across platforms.

### Fixed
- Local AI model API support now works with HTTP and custom ports.

---

## [0.8.3] - 2026-02-14

### Added
- **Query Performance Tracking**: Automatically tracks execution times for queries and warns about performance degradation ( > 50% slower than baseline).
- **Visual Explain Plans**: Enhanced visualization for `EXPLAIN (FORMAT JSON)` results, providing a clear graphical representation of query execution paths.

### Improved
- **Message Handling Architecture**: Refactored internal message routing to a robust `MessageHandler` registry pattern for improved stability and maintainability.
- **CodeLens UX**: Cleaned up and reordered CodeLens actions for better usability; removed redundant 'Explain' action (now accessible via main toolbar/menus).

---

## [0.8.2] - 2026-02-08

### Added
- **Advanced Saved Queries System**: Complete redesign with tag-based organization, connection context preservation, AI metadata generation, and rich metadata display.
- **Context Menu Actions**: Copy Query, Edit Query (modify title/description/tags/SQL), Open in Notebook (with context restoration), and Delete.
- **Professional Query Form**: Syntax-highlighted SQL preview, form validation, error handling, and AI-assisted metadata generation.
- **Tree View Organization**: Queries grouped by collapsible tag groups; untagged queries displayed separately.

### Improved
- **Notebook Integration**: Saved queries now open directly in `.pgsql` notebooks with full connection metadata (connectionId, databaseName, schemaName) automatically restored.
- **Query Discovery**: Rich tooltips with creation/last-used dates, database name, connection name, and usage count on tree items.

---

## [0.8.1] - 2026-02-08

### Added
- **Connection Safety Features**: Environment tagging (🔴 PROD, 🟡 STAGING, 🟢 DEV), read-only mode enforcement, query safety analyzer with risk scoring, and status bar risk indicator.
- **Auto-LIMIT for SELECT**: Automatically appends LIMIT clause to SELECT queries (default 1000 rows, configurable).
- **EXPLAIN CodeLens**: One-click EXPLAIN/EXPLAIN ANALYZE buttons on SQL queries, results inserted directly into notebooks.
- **Table Intelligence**: New table operations for comprehensive insights:
    - **Profile**: Size breakdown, column statistics, and bloat metrics.
    - **Activity Monitor**: Access patterns, modifications, maintenance history, and bloat warnings.
    - **Index Usage**: Performance statistics with unused index detection.
    - **Definition Viewer**: Complete DDL, constraints, indexes, and relationships.

### Improved
- **Connection Form**: Enhanced with "Safety & Security" section for environment selection and read-only mode.
- **Notebook Integration**: EXPLAIN results now insert directly into notebooks for seamless workflow.

---

## [0.8.0] - 2026-02-08

### Added
- **AI Usage Metrics**: AI service responses now include token usage information, displayed in the UI for transparency and monitoring.
- **Comprehensive Test Suite**: Added extensive test utilities and unit tests for renderer components:
    - `TestDatabaseSetup`: Manages test database connections and schema setup.
    - `TestTimer` and `CoverageReporter`: Performance measurement and coverage reporting.
    - Unit tests for notebook cell rendering, dashboard components, form validation, and accessibility features.
- **EXPLAIN Plan Visualizer**: New `ExplainProvider` for visualizing EXPLAIN ANALYZE plans in an interactive webview.
- **Transaction Management**: Advanced transaction control system:
    - `TransactionToolbarManager`: Notebook toolbar for transaction controls.
    - Support for savepoints, isolation levels, and auto-rollback features.
    - Visual indicators for transaction status in notebooks.
- **Row Deletion**: Added support for deleting rows directly from the table renderer.

### Improved
- **Schema Cache**: Implemented adaptive TTL that optimizes cache behavior based on access patterns.
- **Connection Pool**: Added metrics and automatic idle timeout for better resource management.
- **Tree View Performance**: 
    - Debounced tree refresh to improve UI responsiveness during rapid operations.
    - Support for tree view virtualization to handle large schemas efficiently.
- **Chat Navigation**: Enhanced chat templates with breadcrumb navigation for improved database object selection.

### Changed
- **Edit Connection**: Added command to edit existing connection settings from the tree view.

---

## [0.7.9] - 2026-01-05

### Fixed
- **Changelog Loading**: Enhanced changelog loading to check multiple casing variants (CHANGELOG.md, changelog.md, Changelog.md) with detailed debug information.

---

## [0.7.7] - 2026-01-05

### Fixed
- **What's New Screen**: Fixed issues with the What's New welcome screen display and markdown rendering.

---

## [0.7.6] - 2026-01-05

### Added
- **What's New Welcome Screen**: A new immersive welcome page that automatically displays release notes upon extension update.
- **Manual Trigger**: New command `NexQL: Show What's New` to view the changelog history at any time.
- **Rich Markdown Rendering**: The changelog viewer now supports full markdown rendering with syntax highlighting.

---

## [0.7.5] - 2026-01-05

### Architecture Refactoring (Phase 3 Complete)
- **Hybrid Connection Pooling**: Implemented a smart pooling strategy using `pg.Pool` for ephemeral operations and `pg.Client` for session-based tasks.
- **Service Layer**: Introduced a robust service layer architecture:
    - `QueryHistoryService`: Centralized management of query history with persistence.
    - `ErrorService`: Standardized error handling and reporting across the extension.
    - `SecretStorageService`: Secure management of credentials using VS Code's SecretStorage API.
- **Modular Codebase**: Split monolithic files (`extension.ts`, `renderer_v2.ts`) into focused modules (`commands/`, `providers/`, `services/`) for better maintainability.

### Added
- **SQL Parsing Engine**: Integrated a sophisticated SQL parser to enable advanced query analysis and safety checks.
- **Schema Caching**: Implemented intelligent caching for database schemas to improve autocomplete and tree view performance.

### Improved
- **Performance**: Enforced a **10k row limit** on backend results to prevent memory crashes on large queries.
- **Infinite Scrolling**: Frontend now handles large datasets using a virtualized list with intersection observers (200 rows/chunk).
- **Type Safety**: Removed `any` types from core services, enforcing strict TypeScript definitions.

---

## [0.7.1] - 2025-12-30

### Fixed
- **Connection Reliability**: Implemented smart SSL fallback logic. Connections with `sslmode=prefer` or `allow` now gracefully downgrade if SSL is not available, fixing connection issues on various server configurations.

---

## [0.7.0] - 2025-12-26

### Added
- **AI Request Cancellation**: Added the ability to cancel in-progress AI generation requests.
- **Streaming Responses**: AI responses now stream in real-time, providing immediate feedback during query generation.
- **Telemetry**: Introduced anonymous telemetry to track feature usage and improve extension stability.
- **Feature Badges**: Added visual badges to UI sections to highlight new capabilities.

### Improved
- **AI Context**: Enhanced the AI prompt engineering to include richer schema context and query history.

---

## [0.6.9] - 2025-12-14

### Changed
- **Packaging**: optimized the VSIX package to include all necessary `node_modules`, ensuring reliable offline installation.

---

## [0.6.8] - 2025-12-14

### Improved
- **Connection UI**: Redesigned the connection card with clearer status indicators, badges, and a simplified layout for better readability.

---

## [0.6.7] - 2025-12-14

### Security
- **Fix**: Resolved a potential insecure randomness vulnerability in the ID generation logic.

---

## [0.6.6] - 2025-12-14

### Added
- **FDW Documentation**: Added comprehensive in-editor documentation and feature lists for Foreign Data Wrappers.

---

## [0.6.5] - 2025-12-14
*(Includes updates from 0.6.1 - 0.6.4)*

### Added
- **Foreign Data Wrappers (FDW)**: Full support for managing FDWs:
    - **UI Management**: Create, edit, and drop Foreign Servers, User Mappings, and Foreign Tables.
    - **SQL Templates**: Pre-built templates for all FDW operations.
- **Interactive Documentation**: Replaced static screenshots in the documentation with an interactive video/GIF carousel.
- **Media Support**: Enhanced the media modal to support video playback alongside images.

---

## [0.6.0] - 2025-12-13

### Added
- **Native Charting**: Visualize query results instantly!
    - **Chart Types**: Bar, Line, Pie, Doughnut, and Scatter charts.
    - **Customization**: Extensive options for colors, axes, and legends.
    - **Tabbed Interface**: Seamlessly switch between Table view and Chart view.
- **AI Assistance**: Improved markdown rendering in notebooks, ensuring tables and code blocks from AI responses look perfect.

### Changed
- **Branding**: Renamed the output channel to `NexQL` to match the new extension identity.

---

## [0.5.4] - 2025-12-13

### Rebranding
- **Project Renamed**: The extension is now **NexQL**! (formerly "YAPE" / "PostgreSQL Explorer").
- Updated all documentation, UI references, and command titles to reflect the new professional identity.

### Added
- **Dashboard Visuals**: Added "glow" and "blur" effects to dashboard charts for a modern, premium aesthetic.

---

## [0.5.3] - 2025-12-07

### Fixed
- **Stability**: Fixed various reported linting errors and type issues across command files.

---

## [0.5.2] - 2025-12-06

### Changed
- **SQL Template Refactoring**: Extracted embedded SQL strings from TypeScript files into dedicated template modules (`src/commands/sql/`), improving code readability and separation of concerns.

---

## [0.5.1] - 2025-12-05

### Changed
- **Helper Abstractions**: Refactored command files to use standardized `getDatabaseConnection` and `NotebookBuilder` helpers, reducing code duplication.

---

## [0.5.0] - 2025-12-05

### Added
- **Enhanced Table Renderer**: New `renderer_v2.ts` with improved table output styling and performance.
- **Export Data**: Export query results to **CSV**, **JSON**, and **Excel** formats.
- **Column Operations**: Context menu for columns with Copy, Script, and Statistics options.
- **Constraint & Index Operations**: Full management UI for table constraints and indexes (Create, Drop, Analyze Usage).

### Fixed
- **Renderer Cache**: Fixed issues where table results would stale or fail to render on re-open.
- **Row Height**: Optimized table row height for better information density.

---

## [0.4.0] - 2025-12-03

### Added
- **Inline Create Buttons**: Added convenient "+" buttons to explorer nodes for quick object creation.
- **Script Generation**: Improved "Script as CREATE" accuracy for complex indexes.

---

## [0.3.0] - 2025-12-01

### Added
- **Test Coverage**: Added comprehensive unit tests for `NotebookKernel`.
- **Error Handling**: Improved reporting of serialization errors in query results.

### Changed
- **Dashboard UI**: Updated dashboard with pastel colors and modern styling.

---

## [0.2.3] - 2025-11-29

### Added
- **AI Assist CodeLens**: "✨ Ask AI" link added directly above notebook cells.
- **Multi-Provider AI**: Support for Google Gemini, OpenAI, and Anthropic models.
- **Pre-defined Tasks**: Quick actions for "Explain", "Fix Syntax", "Optimize".

---

## [0.2.2] - 2025-11-29

### Fixed
- **Critical Fix**: Corrected `package.json` entry point path pointing to `./dist/extension.js`, resolving "command not found" errors for new installations.

---

## [0.2.0] - 2025-11-29

### Added
- **Real-time Dashboard**: Live metrics monitoring for active queries and performance.
- **Active Query Management**: Ability to Cancel/Kill running queries.
- **PSQL Integration**: Integrated terminal support.
- **Backup & Restore**: UI-driven database backup/restore tools.

### Enhanced
- **Tree View**: Improved navigation and performance.
- **Connection Management**: Secured password storage and refactored connection logic.

---

## [0.1.x] - Previous versions

Earlier versions with basic PostgreSQL exploration, SQL notebooks, and data export features.
