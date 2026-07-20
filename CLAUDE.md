---
description: 
alwaysApply: true
---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NexQL is a VS Code extension (`ric-v.postgres-explorer`) for PostgreSQL database management. Features include interactive SQL notebooks (`.pgsql`), a database explorer tree view, AI-powered chat assistant (OpenAI/Anthropic/Gemini), real-time dashboard, SSH tunneling, and visual schema designer.

## Commands

### Development
```bash
npm run watch            # TypeScript auto-recompile (use during dev with F5)
npm run esbuild-watch    # Bundle watch mode (extension.js + renderer_v2.js)
npm run compile          # One-time TypeScript compile
npm run esbuild          # One-time bundle with sourcemaps
```

Press **F5** in VS Code to launch the Extension Development Host.

### Testing
```bash
npm run test:unit        # Unit tests (Mocha + Chai + Sinon)
npm run test:integration # Integration tests (requires Docker PostgreSQL)
npm run test:renderer    # Renderer tests (jsdom)
npm run test:all         # All tests
npm run coverage         # Coverage report → ./coverage/index.html
```

Run a single test file:
```bash
npx ts-mocha -r tsconfig-paths/register src/test/unit/path/to/file.test.ts
```

### Docker (Integration Tests)
```bash
make docker-up      # Start PostgreSQL 12-17 containers (ports 5412-5417)
make docker-down    # Stop containers
make test-full      # docker-up → test-all → docker-down
make coverage       # Coverage with phased reports
```

Docker test credentials: `testuser`/`testpass`, DB: `testdb`

### Build & Release
```bash
npm run vscode:prepublish  # Production build (minified, no sourcemaps)
make package               # Create .vsix package
make publish               # Publish to VS Code Marketplace + Open VSX
make package-nightly       # Nightly VSIX (Marketplace pre-release + Open VSX companion)
make publish-nightly       # Publish nightlies (needs ./pat and ./pat-open-vsx)
```

**Nightly vs stable (VS Marketplace / Open VSX):** Registries only accept `major.minor.patch` (no SemVer tags like `-nightly` on the published version). Use `vsce publish --pre-release` for the Marketplace nightly. Follow [Microsoft’s convention](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions): **even** `minor` for stable releases, **odd** `minor` for pre-release. `scripts/compute-nightly-version.js` derives the published nightly version from `package.json` (part before the first `-`) by ensuring an odd `minor`. Bump the patch on `main` for each new nightly (e.g. `1.2.4-nightly` in repo → `1.3.4` published). CI: `.github/workflows/publish-nightly.yml`.

## Architecture

### Extension Entry Point
`src/extension.ts` activates the extension and delegates to `src/activation/`:
- `providers.ts` — registers tree views, notebook providers, DDL viewer, deferred tasks
- `commandRegistry.ts` / `commandSpecs.ts` — registers all VS Code commands with telemetry wrapping
- `statusBar.ts` — `NotebookStatusBar` (connection, database, transaction, risk indicator items)
- `WhatsNewManager.ts` — changelog panel on version bump

### Core Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ConnectionManager` | `src/services/ConnectionManager.ts` | Singleton; connection pooling keyed by `{connectionId}:{database}`, SSH tunnel support |
| `SecretStorageService` | `src/services/SecretStorageService.ts` | Singleton; wraps VS Code SecretStorage for credential encryption |
| `DatabaseTreeProvider` | `src/providers/DatabaseTreeProvider.ts` | Tree: Connections → Databases → Schemas → Objects |
| `NotebookKernel` | `src/providers/NotebookKernel.ts` | Executes SQL cells in `.pgsql` notebooks; SQL completions via `SqlCompletionProvider` |
| `SqlExecutor` | `src/providers/kernel/SqlExecutor.ts` | Multi-statement execution, streaming NOTICE output, failure strategies |
| `SqlParser` | `src/providers/kernel/SqlParser.ts` | Dollar-quote-aware SQL splitter; strips comments outside strings |
| `TransactionManager` | `src/services/TransactionManager.ts` | Per-session transaction state, savepoints, auto-rollback |
| `QueryAnalyzer` | `src/services/QueryAnalyzer.ts` | EXPLAIN JSON parsing, performance baselines (Welford variance), degradation alerts |
| `SchemaPoller` | `src/services/SchemaPoller.ts` | Background schema change detection for tree refresh |
| `ChatViewProvider` | `src/providers/ChatViewProvider.ts` | AI assistant webview; delegates to `src/providers/chat/` services |

### Command Pattern
Commands follow a strict two-layer pattern:
- SQL templates (pure functions, no VS Code deps): `src/commands/sql/{domain}.ts`
- Command implementations using `NotebookBuilder`: `src/commands/{domain}.ts`

```typescript
// src/commands/{domain}.ts
import { TableSQL } from './sql';
await new NotebookBuilder(metadata)
    .addMarkdown(MarkdownUtils.header('...') + MarkdownUtils.infoBox('...'))
    .addSql(TableSQL.delete(schema, table))
    .show();
```

### Key Utilities (`src/commands/helper.ts`)
- `getDatabaseConnection(item)` — validates tree item, resolves password, returns `{connection, client, metadata}`
- `NotebookBuilder` — fluent API: `.addMarkdown()`, `.addSql()`, `.show()`
- `MarkdownUtils` — `header()`, `infoBox()`, `warningBox()`, `dangerBox()`, `operationsTable()`
- `ErrorHandlers.handleCommandError(err, action)` — standardized error handling

### Shared Infrastructure (`src/common/`)
- `types.ts` — `PostgresMetadata`, `DatabaseTreeItem` type definitions
- `htmlStyles.ts` — CSS variables, `MarkdownBuilder` for consistent formatting
- `notebookTemplates.ts` — `NotebookCellBuilder`, `CommonNotebookTemplates`

### Featare u aure Modules (`src/features/`)
Self-contained features that don't fit the simple command pattern:
- `aiAssistant/` — AI settings panel (`aiSettingsPanel.ts`)
- `analyst/` — Pure data-analysis utilities: pivot, histogram, column aggregates, numeric coercion
- `connections/` — Connection form UI, `ProfileManager`, connection CRUD logic
- `migrations/` — Framework detection (`detectFramework.ts`)
- `notebook/` — `PostgresNotebookProvider` (serializer), `PostgresNotebook`, HTML export
- `savedQueries/` — `SaveQueryPanel`, `SavedQueriesService`, query details panel
- `schemaDiff/` — `SchemaDiffEngine` (pure diff + migration SQL generation), diff types
- `tables/properties/` — Table properties panel

### Shared Lib (`src/lib/`)
- `SchemaCache` — adaptive-TTL cache (30s/1m/5m based on access frequency); used by tree provider
- `template-loader.ts` — loads HTML templates for webviews
- `debounce.ts` — standard debounce utility

### Notebook Renderer (`src/ui/renderer/`)
Compiled separately as `renderer_v2.js` (esbuild entry). Runs inside VS Code's notebook renderer sandbox. Renders result tables, charts (Chart.js), EXPLAIN visualizer, and export controls. Communicates back to the kernel via `postMessage`. **No direct VS Code API access.**

### Message Passing (Webviews)
Webviews communicate via `postMessage`. Handlers registered in `MessageHandlerRegistry` live in `src/services/handlers/` (CoreHandlers, ExplainHandlers, QueryHandlers, TransactionHandlers).

### Singleton Access Pattern
```typescript
ConnectionManager.getInstance().getConnection(config);
SecretStorageService.getInstance().getPassword(connectionId);
```

### Debug Output
```typescript
import { outputChannel } from './extension';
outputChannel.appendLine('Debug message');
```

## Adding New Features

### New Database Object Command
1. Add SQL templates in `src/commands/sql/{object}.ts`
2. Implement command in `src/commands/{object}.ts` using `NotebookBuilder`
3. Register in `src/extension.ts` and `package.json` (`contributes.commands`)
4. Add tree view context menu in `package.json` (`contributes.menus`)

### New Tree Item Type
1. Add type string to `DatabaseTreeItem` switch cases in `DatabaseTreeProvider.ts`
2. Add icon mapping and children fetching logic
3. Add context menu contributions in `package.json`

## Testing Infrastructure
- Unit tests: `src/test/unit/**/*.test.ts` — mock VS Code API via `src/test/unit/mocks/vscode.ts`
- Integration tests: `src/test/integration/**/*.test.ts` — require live PostgreSQL (Docker)
- Module aliases configured via `module-alias` in `src/test/setup.ts`
- TypeScript strict mode enforced; no eslint/prettier configured

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)


<!-- AURA_START -->
# Aura Semantic Engine (v0.12.7)

You have access to the Aura Semantic Engine via MCP tools. Aura tracks the mathematical logic (AST Merkle-Graph) of the codebase, not text diffs. It also provides **real-time P2P team collaboration** via the Mothership.

## MANDATORY: Intent Logging
After making code changes and BEFORE committing, you MUST call `aura_log_intent` with a description of what you changed and why. This is NOT optional — without it, the pre-commit hook will detect "Intent Poisoning" and may block the commit. Aura **auto-pushes your changed functions to the team** when you log intent.

## MCP Tools Available
- `aura_snapshot` — ALWAYS call before modifying files. Takes a snapshot AND checks team zone ownership.
- `aura_log_intent` — REQUIRED after edits. Logs intent AND auto-pushes functions to mothership.
- `aura_status` — Check everything: semantic state, team sync status, pending pulls, active agents.
- `aura_pr_review` — Run semantic PR review to check for violations.
- `aura_prove` — Mathematically verify a behavioral goal is met.
- `aura_rewind` — Surgically revert a single function to a previous safe state.
- `aura_plan_discover` — Decompose complex objectives into atomic waves.
- `aura_plan_lock` / `aura_plan_next` — Lock and execute wave plans.
- `aura_handover` — Compress context for agent handoff (90%+ token savings).
- `aura_snapshot_list` — List all recoverable file snapshots.
- `aura_read_history` — Search semantic logic history to understand past decisions.
- `aura_sentinel_status` — See function-level claims, collisions, and zone ownership.
- `aura_sentinel_agents` — List all active agent sessions (Claude, Copilot, Gemini, Cursor, etc.).
- `aura_sentinel_send` — Send a message to another agent session.
- `aura_sentinel_inbox` — Read messages from other agent sessions.
- `aura_sentinel_release` — Release function claims for this session.
- `aura_zone_claim` — Claim exclusive ownership of a directory/file pattern.
- `aura_live_impacts` — Fetch cross-branch dependency conflict alerts.
- `aura_live_resolve` — Mark an impact alert as resolved.
- `aura_live_sync_push` — Push function bodies to mothership (auto on intent log).
- `aura_live_sync_pull` — Pull function changes from teammates and apply at AST level.
- `aura_live_sync_status` — Check pending sync changes from teammates.
- `aura_msg_send` — Send a message to team or a specific developer/agent.
- `aura_msg_list` — Read recent team messages.
- `aura_doctor` — Diagnose repository health issues.

## Team Collaboration (Automatic)
Aura auto-injects these into every MCP tool response — you MUST respond:
- **`🔄 SYNC: N function updates available`** → Call `aura_live_sync_pull` to apply teammate changes
- **`💬 TEAM: N unread messages`** → Call `aura_msg_list` to read, reply with `aura_msg_send`
- **`📨 SENTINEL: N unread messages from another AI agent`** → Call `aura_sentinel_inbox`, reply with `aura_sentinel_send`
- **`⚠️ SENTINEL COLLISION`** → Another agent is editing same functions. Coordinate.
- **`🚨 TEAM ZONE WARNING/BLOCKED`** → A teammate owns this file area. Respect it.
- **`🔄 AUTO-SYNC: Pushed N functions`** → Your changes were auto-synced. No action needed.

## Workflow
1. Call `aura_status` — check state, team sync, pending pulls, agents, messages
2. If pending pulls exist → call `aura_live_sync_pull` FIRST
3. Call `aura_snapshot` before editing files (auto-checks team zones)
4. Make your changes
5. Call `aura_log_intent` with your reasoning (auto-pushes to team)
6. Call `aura_pr_review` to verify no violations
7. Commit — Aura's pre-commit hook validates intent vs AST changes

## What You Must Never Do
- Never ignore team messages, zone warnings, or sync notifications
- Never edit a file that is BLOCKED by a team zone — coordinate first
- Never commit without calling `aura_log_intent` first
- Never edit a file without `aura_snapshot` first
<!-- AURA_END -->
