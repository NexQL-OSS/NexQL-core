# Changelog

All notable changes to the PostgreSQL Explorer extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-19

### Added
- **SQL Assistant editor tabs**: Added `postgres-explorer.openSqlAssistantTab` so users can open SQL Assistant in the main editor area, not only in the sidebar container.
- **Multi-tab SQL Assistant workflow**: SQL Assistant now supports opening multiple editor tabs for parallel AI conversations and context switching.
- **AI Insights dashboard panel**: Added a richer dashboard assistant surface with schema-health metrics, connection analytics, vacuum progress, and direct Ask AI actions.

### Fixed
- **SQL completion deduplication**: Table and column completion items are now deduplicated before caching, preventing repeated suggestions in notebook SQL autocomplete.
- **Assistant routing consistency**: Chat attachments and assistant updates now route to the active SQL Assistant webview (sidebar view or editor tab), which keeps multi-tab conversations in sync.
- **Review changes UI stability**: The result review / compare UI now renders more consistently and keeps action visibility aligned with the active table state.

### Changed
- **Dashboard telemetry expansion**: Dashboard stats now include unused indexes, high sequential-scan tables, table bloat, autovacuum progress, tables needing vacuum, and connections grouped by application name.
- **Dashboard AI interactions**: AI prompts can be launched from dashboard context, queries can be executed for analysis, CSV can be downloaded from AI-assisted query results, and health degradation can trigger auto-notify behavior.

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
- **Image support in SQL Assistant**: Paste images directly from clipboard or upload via the new image button (🖼) in the chat input. Images render as fixed 56×56px thumbnails in a dedicated preview strip above the textarea.
- **Image lightbox**: Click any image thumbnail (in the input strip or in message history) to open a full-size overlay preview.
- **Vision AI support**: Images are now properly sent to AI providers that support vision — OpenAI/custom as `image_url` parts, Anthropic as `base64` image blocks, Gemini as `inline_data` parts, and VS Code LM via `LanguageModelImagePart`.
- **File preview from chat**: Clicking an attached file chip (in the input area or in message history) opens the file as a preview tab in the VS Code editor. Works for files attached via the file picker, "Send to Chat", and "Analyze Data" buttons.
- **GitHub Models account sign-in**: Added first-class GitHub Models provider support using VS Code GitHub authentication sessions, including model listing and connection checks from AI Settings.

### Changed
- **GitHub auth UX**: GitHub provider connection now uses the standard VS Code GitHub sign-in flow in AI Settings, with provider state reflected in the UI.
- **Nightly release channel**: Nightly builds are now available as pre-release updates, including a dedicated Open VSX nightly companion package for early access testing.

### Fixed
- **Image CSP**: Added `img-src data: blob:` to the webview Content Security Policy so image thumbnails actually render (previously blocked by `default-src 'none'`).
- **File path missing on attach**: Files picked via the attachment button now include their filesystem path, enabling click-to-preview.
- **Open VSX GitHub auth fallback**: Removed invalid OAuth scope requests for GitHub session auth to prevent users from being redirected to PAT-only fallback prompts.

---

## [0.9.2] - 2026-04-07

### Added
- **Local AI model support**: New **Ollama** and **LM Studio** providers connect to locally-running models at their default endpoints (`http://localhost:11434` and `http://localhost:1234`). No API key required.
- **Nightly build pipeline**: Automated GitHub Actions workflow publishes pre-release builds to VS Code Marketplace and Open VSX on every push to `main`. Nightly versions use odd minor numbers (e.g., `0.9.1.{run}`).
- **AI response timing**: Chat responses now display elapsed time alongside token usage for quick performance feedback.
- **Code snippet execution**: Suggestion bubbles in chat can now run code snippets directly via a new `runSnippet()` action.

### Changed
- **Connection edit flow**: Editing a connection now opens `ConnectionFormPanel` directly instead of dispatching a command, making the flow more reliable.
- **Connection card styling**: Environment-specific accent colors (green for DEV, orange for STAGING, red for PROD) applied consistently across connection cards.
- **Chat input focus**: `sendSuggestion()` now properly focuses the input and positions the cursor after inserting a suggestion.
- **Publish workflow**: Version mismatch between the git tag and `package.json` now fails the build instead of emitting a warning.

### Fixed
- **Inline code rendering**: Fixed markdown rendering of inline code in chat responses (resolves display issues with meta-notation like `(u, o)`).
- **SVG icon sizing**: Code block action buttons now have explicit `width`/`height` attributes, preventing layout inconsistencies across themes.

### Removed
- **Tree filter commands**: `postgres-explorer.filterTree` and `postgres-explorer.clearFilter` removed from activation — these experimental commands were unused.

---

## [0.9.0] - 2026-04-06

### Added
- **Anthropic model discovery**: AI Settings now lists Anthropic models from the official `/v1/models` API instead of a fixed local list.
- **Guided chat responses**: Assistant replies can now include numbered follow-up questions, optional next-step suggestion bubbles, and contextual quote-style factoids or jokes when they genuinely fit.

### Changed
- **AI key lookup**: Direct AI provider keys now resolve from `SecretStorage` first, fixing false “API key required” errors when the key is already saved.
- **Chat identity and styling**: Assistant messages are labeled **PG Studio Bot**, with improved assistant bubble contrast and quote styling for richer responses.
- **Composer UX**: The chat input and suggestion bubbles were tightened for readability, capped to a compact height, and styled to avoid carrying stale next-step actions between chats.

### Fixed
- **Follow-up selection**: Typing a number now resolves to the corresponding numbered follow-up question from the previous assistant message, instead of being treated as a fresh prompt.
- **Next-step carry-over**: Next-step bubbles are hidden when a new follow-up is sent or when switching chats, so actions remain specific to the active conversation.

## [0.8.8] - 2026-03-21

### Added
- **Command palette — release notes**: **PgStudio: Show Release Notes / What's New** is registered in the manifest for discovery (changelog opens in an editor-area webview panel).
- **Tests**: Integration coverage for notebook renderer message flow (`NotebookRendererFlow.test.ts`) and unit tests for query save/delete handlers (`QueryHandlers.test.ts`).
- **Table Designer (create mode)**: Drag-and-drop column reorder with clear create-vs-edit UI behavior.
- **AI chat**: Explicit **production safety** rules in the system prompt (read-first bias, transaction/rollback guidance, guarded writes).

### Changed
- **Sidebar layout**: **Connections** and **SQL Assistant** are listed first; **Saved Queries** and **Query History** use new view identifiers and start **collapsed by default** (VS Code only applies manifest defaults when it has no prior UI state for that view).
- **Release notes**: **What's New** is no longer a sidebar section; use the command palette command. Automatic release-note panels on upgrade are not shown on activation.
- **Notebook inline edits**: `SaveChangesHandler` and bulk/table deletes use **parameterized** `UPDATE`/`DELETE`, run inside a **transaction** (`BEGIN` / `COMMIT` / `ROLLBACK` on failure), and build predicates with proper identifier quoting (fixes composite-key and NULL edge cases).

---

## [0.8.6...0.8.7] - 2026-03-15

### Added
- **.pgpass support**: Native backwards-compatible support with explicit resolvers parsing standard `.pgpass` (and Windows `%APPDATA%\postgresql\pgpass.conf`) secret files.

### Fixed
- **Authentication Resilience**: Resolved standard connection `password authentication failed` issues that fell back to implicit OS defaults incorrectly. 
- **SSL Fallback Reliability**: Fixed `DatabaseTreeProvider` stripping configuration details (such as direct inline passwords and sslmode) during fallback client re-trigger calculations.
- **.pgpass lookup scope**: Avoided resolving implicit machine name environments by strictly isolating parsing searches for explicit username options, fixing backward compatibility for local `trust` authentications.

---

## [0.8.4...0.8.5] - 2026-02-19
    
### Added
- **Visual Table Designer**: A robust, interactive UI for creating tables. Define columns, data types, constraints, and foreign keys visually without writing SQL.
- **Visual Index & Constraint Manager**: Manage indexes and constraints with a modern GUI. Analyze usage, drop unused indexes, and create new constraints with ease.
- **Smart Paste**: Intelligent clipboard handling that detects SQL, CSV, or JSON content and offers context-aware actions (e.g., "Insert as Rows", "Format SQL").
- **Dashboard Improvements**:
    - **Visual Lock Viewer**: Diagnostic tree view to identify and resolve blocking chains and deadlocks.
    - **Enhanced Metrics**: Real-time charts for IO, Checkpoints, and System Load.
    - **Active Query Management**: Kill/Cancel blocking queries directly from the dashboard.

### Improved
- **Stability**: Fixed dashboard template loading issues to ensure reliable rendering on all platforms.

### Fixed
- https://github.com/dev-asterix/PgStudio/issues/56 - Resolved local AI model API implementation with support for http and custom port.

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
