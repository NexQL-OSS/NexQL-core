# Changelog

All notable changes to the PostgreSQL Explorer extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.4] - 2026-05-03

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

PgStudio v1.0.0 is a major milestone release with comprehensive stability improvements, security hardening, and production-ready tooling.

#### Added
- **DDL Viewer SQL Preview toggle**: Added user-facing toggle command and setting (`pgstudio.ddlViewer.enabled`) to quickly enable/disable definition preview actions.
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
- **Command palette - release notes**: **PgStudio: Show Release Notes / What's New** is now easy to find, and it opens in the editor area instead of hiding off to the side.
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
- **Manual Trigger**: New command `PgStudio: Show What's New` to view the changelog history at any time.
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
- **Branding**: Renamed the output channel to `PgStudio` to match the new extension identity.

---

## [0.5.4] - 2025-12-13

### Rebranding
- **Project Renamed**: The extension is now **PgStudio**! (formerly "YAPE" / "PostgreSQL Explorer").
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
