<div align="center">

# 🐘 NexQL

### *Professional Database Management for VS Code*

[![Version](https://img.shields.io/visual-studio-marketplace/v/ric-v.postgres-explorer?style=for-the-badge&logo=visual-studio-code&logoColor=white&color=0066CC)](https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/ric-v.postgres-explorer?style=for-the-badge&logo=visual-studio-code&logoColor=white&color=2ECC71)](https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/ric-v.postgres-explorer?style=for-the-badge&logo=visual-studio-code&logoColor=white&color=F39C12)](https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer)
[![Status](https://img.shields.io/badge/status-stable%20v2.2.1%20%2B%20nightly-blue?style=for-the-badge&logo=git&logoColor=white)](https://github.com/dev-asterix/NexQL/releases)

<br/>
<br/>

<a href="https://www.producthunt.com/products/nexql?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-nexql" target="_blank" rel="noopener noreferrer"><img alt="NexQL - AI-native Postgres tooling, All in VS Code | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.png?post_id=1198080&amp;theme=neutral&amp;t=1784198674691"></a>

<br/>
<br/>

**NexQL** (formerly YAPE) is a comprehensive PostgreSQL database management extension featuring interactive SQL notebooks, real-time monitoring dashboard, AI-powered assistance, and advanced database operations—all within VS Code.

[📖 **Documentation**](https://nexql.astrx.dev/) • [🛒 **Marketplace**](https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer) • [🤝 **Contributing**](#-contributing) • [📝 **v2.2.1 Release Notes**](CHANGELOG.md) • [📋 **Full Changelog**](CHANGELOG.md)

</div>

---

## 📺 Video Guides

### 1. Setup
![NexQL Setup](docs/assets/01-setup.gif)

### 2. More Settings
![AI Assistant Setup](docs/assets/02-more-settings.gif)

### 3. AI Assistant
![AI Assistant](docs/assets/03-ai-assist.gif)

### 4. AI Copilot
![AI Assistant Usage](docs/assets/04-ai-copilot.gif)

### 5. Dashboard
![Dashboard](docs/assets/05-dashboard.gif)

### 6. DB Operations
![DB Operations](docs/assets/06-db-ops.gif)

### 7. Power Editor
![Power Editor](docs/assets/07-power-editor.gif)

### 8. More Features
![More Features](docs/assets/08-more-features.gif)

---

## ✨ Key Features

- 🔌 **Secure Connections** — VS Code SecretStorage encryption
- 🛡️ **Connection Safety** — Environment tagging (🔴 PROD, 🟡 STAGING, 🟢 DEV), read-only mode, query safety analyzer
- ⏱️ **Performance Tracking** — Historical query execution monitoring with degradation alerts
- 📊 **Live Dashboard** — Real-time metrics & query monitoring
- 🚦 **Dashboard Health Signals** — Status badges, lock/wait indicators, and performance-focused telemetry cards
- 📓 **SQL Notebooks** — Interactive notebooks with AI assistance
- 🗂️ **Notebook Manager** — Open/create notebooks with searchable picker and improved metadata context
- 💾 **Saved Queries** — Tag-based organization, connection context restoration, AI metadata generation, edit & reuse
- 🌳 **Database Explorer** — Browse tables, views, functions, types, FDWs
- 🛠️ **Object Operations** — CRUD, scripts, VACUUM, ANALYZE, REINDEX, plus triggers/sequences/domains/rules/partitions/publications/event triggers/tablespaces/aggregates
- 🏗️ **Visual Table Designer** — Create/Edit tables with a robust GUI
- 🧭 **Definition Viewer (SQL Preview)** — Open object DDL with toggleable SQL preview, copy/edit workflows, and routine scaffolding
- 🔑 **Index & Constraint Manager** — Visual management of DB constraints
- 🧠 **Schema Intelligence** — Schema search, index advisor, and migration generator workflows
- 📋 **Smart Paste** — Context-aware clipboard actions (SQL/CSV/JSON)
- 📊 **Table Intelligence** — Profile, activity monitor, index usage, definition viewer
- 🔍 **EXPLAIN CodeLens** — One-click query analysis directly in notebooks
- 🎛️ **Advanced Result UX** — Column stats, transpose view, enhanced filtering, sliding-window streaming for large `SELECT`s, configurable `bytea` display, and structured in-grid editing with explicit commit confirmation
- 🛡️ **Auto-LIMIT** — Intelligent query protection (configurable, default 1000 rows)
- 🌍 **Foreign Data Wrappers** — Manage foreign servers, user mappings & tables
- 🤖 **AI-Powered** — Zero-configuration NexQL Free AI (Smart/Engineer/Architect tiers), plus GitHub Models, OpenAI, Anthropic, Gemini, and VS Code LM. Generate, optimize, explain & analyze with guided follow-ups.
- 🧩 **Flexible SQL Assistant Layout** — Open SQL Assistant in editor tabs and keep multiple assistant tabs open simultaneously
- 🖱️ **Drag & Drop Context** — Drag tables, columns, functions, notebooks, or saved queries from the tree straight into the SQL Assistant as `@mentions`, or drop onto a notebook cell to insert a formatted reference
- 🖼️ **Vision AI** — Paste or upload images directly in the SQL Assistant; sent to vision-capable AI providers
- 📎 **File Preview** — Click attached file chips to open them as preview tabs in the editor
- 📤 **Export Data** — Export results to CSV, JSON, or Excel
- 🔌 **MCP Server** — Expose your database as read-only tools to Copilot, Cursor, Claude Desktop, and other MCP agents, with a fixed local port/token option for external clients

---

## 🎯 Why NexQL?

<table>
<tr>
<td width="50%">

### 🎨 Modern Interface
- Beautiful, intuitive UI designed for developers
- Real-time dashboard with live metrics
- Context-aware operations
- Seamless VS Code integration

</td>
<td width="50%">

### ⚡ Powerful Features
- Interactive SQL notebooks
- 🤖 AI-powered Copilot & agentic support
- Table intelligence & performance insights
- Complete CRUD operations
- EXPLAIN CodeLens for query analysis

</td>
</tr>
<tr>
<td>

### 🛡️ Production-Ready Safety
- Environment tagging (Production/Staging/Dev)
- Read-only mode enforcement
- Query safety analyzer with risk scoring
- Auto-LIMIT for SELECT queries
- Status bar risk indicators

</td>
<td>

### 📊 Performance Insights
- Table profile with size & statistics
- Real-time activity monitoring
- Index usage analytics
- Bloat detection & warnings
- Query performance history & alerts
- Complete table definitions

</td>
</tr>
</table>

---

## 📋 Feature Matrix

| Area | NexQL v2.2.1+ | Notes |
|---|---|---|
| Core PostgreSQL object operations | ✅ | Tables, views, mat views, functions, roles, extensions, FDWs, and more |
| AI-assisted SQL workflows | ✅ | Generate, optimize, explain, and analyze with notebook-first execution |
| Production safety controls | ✅ | Read-only mode, risk scoring, confirmation prompts, Auto-LIMIT |
| Real-time monitoring dashboard | ✅ | Activity and health views in VS Code |
| Interactive SQL notebooks | ✅ | Native `.pgsql` notebook execution with completions |
| In-grid result editing parity with desktop IDEs | ⚠️ Partial | Stronger commit flow and tooling in v1.2.x; full parity still evolving |
| ERD/schema visualization parity | ⚠️ Partial | Schema designer exists; ERD depth still evolving |
| Advanced replication administration | ⚠️ Partial | Additional publication/subscription depth planned |

---

## 🌐 Platform Compatibility

NexQL works with **any database that speaks the PostgreSQL wire protocol** — not just self-hosted Postgres.

| Platform | Status | Tip |
|---|---|---|
| PostgreSQL 12–17 | ✅ Fully supported | Integration-tested every release |
| **Neon** | ✅ Works | Use the direct (non-`-pooler`) endpoint, SSL `require` |
| **Supabase** | ✅ Works | Use direct or session pooler (port 5432); avoid transaction pooler (6543) |
| **TimescaleDB** / Timescale Cloud | ✅ Fully compatible | It's a Postgres extension — everything works |
| **YugabyteDB** (YSQL) | ✅ Mostly works | Port 5433; version-gated features fall back automatically |
| AWS RDS / Aurora, Cloud SQL / AlloyDB, Azure Flexible | ✅ Works | Set SSL Mode `require` |

📖 Full matrix, connection guides, and caveats: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). First-class platform support (auto-detection, capability-aware menus, connection-string paste) is planned — see [the roadmap](docs/roadmap/4.postgres-compatible-platforms-roadmap.md).

---

## 🚀 Quick Start

```bash
# Install from VS Code
ext install ric-v.postgres-explorer

# Or via command line
code --install-extension ric-v.postgres-explorer
```

Then: **PostgreSQL icon** → **Add Connection** → Enter details → **Connect!**


---

## Telemetry Setup

NexQL ships with a privacy-first telemetry client designed for anonymous product analytics.

- No SQL text, schema/object names, hostnames, database names, usernames, or credentials are collected.
- VS Code global telemetry setting is a hard gate; when disabled globally, NexQL telemetry is disabled.
- Event payloads are allowlisted and bucketed (durations/result sizes) to avoid raw sensitive values.

### Configure telemetry mode

Set these in VS Code settings:

- `postgresExplorer.telemetry.mode`: `off | basic | detailed` (default `basic`)
- `postgresExplorer.telemetry.allowUsage`: allow anonymous usage counters (default `true`)
- `postgresExplorer.telemetry.allowPerformance`: allow anonymized performance buckets (default `false`)

### Configure PostHog sink (optional)

For remote telemetry ingestion:

- `postgresExplorer.telemetry.posthogHost`: default `https://us.i.posthog.com`
- `postgresExplorer.telemetry.posthogApiKey`: your PostHog project key

If `posthogApiKey` is empty, telemetry stays local (debug sink only).

### What to expect from telemetry

- Lifecycle: extension/session start and end events
- Activity: command and feature usage counters
- Connections: opened/closed/error with coarse error category
- Query execution: success/failure with duration/result-size buckets (detailed/performance-enabled mode)
- AI usage: provider-level success/failure counters

---

## 📚 Documentation Map

- `README.md` - Product overview, installation, development, and troubleshooting
- `docs/COMPATIBILITY.md` - Platform compatibility matrix (Neon, Supabase, TimescaleDB, YugabyteDB, RDS, …)
- `docs/ARCHITECTURE.md` - System architecture and component/data-flow details
- `docs/STYLING_GUIDE.md` - Centralized styling/templates and UI refactoring patterns
- `docs/WEBSITE_CONTEXT.md` - Website architecture and content context
- `docs/API_STABILITY.md` - v1.x API stability and deprecation policy
- `docs/SECURITY_REVIEW.md` - v1.0 security controls and release checklist
- `docs/RELEASE_NOTES_v2.0.0.md` - v2.0 highlights and release notes (rebranding, licensing & subscription)
- `docs/RELEASE_NOTES_v1.0.0.md` - v1.0 highlights and release notes
- `docs/MIGRATION_GUIDE_0.x_to_1.0.0.md` - upgrade path from 0.9.x to 1.0.0
- `SECURITY.md` - Security policy and vulnerability reporting guidance
- `CHANGELOG.md` - Release notes and what changed across versions

**Stable: v2.2.1 | Nightly: v2.2.1+ —** Drag-and-drop context from the explorer into chat/notebooks, a safer silent sign-in flow for NexQL Free AI, and a fixed MCP port/token option for external agent clients. See [CHANGELOG.md](CHANGELOG.md); v2.0 launch materials remain in [Release Notes](docs/RELEASE_NOTES_v2.0.0.md) and older v1.0 details in [v1.0.0 Release Notes](docs/RELEASE_NOTES_v1.0.0.md).

---

## 🏗️ Project Structure

```
NexQL/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── commands/             # Command implementations
│   │   ├── tables.ts         # Table operations
│   │   ├── views.ts          # View operations
│   │   ├── functions.ts      # Function operations
│   │   ├── connection.ts     # Connection commands
│   │   ├── notebook.ts       # Notebook commands
│   │   ├── helper.ts         # Shared helper utilities
│   │   ├── sql/              # SQL template modules
│   │   │   ├── tables.ts     # Table SQL templates
│   │   │   ├── views.ts      # View SQL templates
│   │   │   ├── functions.ts  # Function SQL templates
│   │   │   ├── indexes.ts    # Index SQL templates
│   │   │   └── ...           # Other SQL templates
│   │   └── ...
│   ├── providers/            # VS Code providers
│   │   ├── DatabaseTreeProvider.ts   # Tree view provider
│   │   ├── NotebookKernel.ts         # Notebook kernel
│   │   ├── ChatViewProvider.ts       # AI chat provider
│   │   ├── SqlCompletionProvider.ts  # IntelliSense
│   │   └── ...
│   ├── services/             # Business logic
│   │   ├── ConnectionManager.ts      # Connection handling
│   │   └── SecretStorageService.ts   # Credential storage
│   ├── dashboard/            # Dashboard webview
│   ├── common/               # Shared utilities
│   └── test/                 # Unit tests
├── resources/                # Icons & screenshots
├── docs/                     # Documentation & landing page
├── dist/                     # Compiled output (bundled)
├── out/                      # Compiled output (tsc)
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
└── webpack.config.js         # Webpack config
```

---

## 💾 Saved Queries Library

Organize, manage, and reuse your most important queries with intelligent tagging and context preservation.

### Features
- **🏷️ Tag-Based Organization** — Group queries by topic (e.g., "analytics", "maintenance", "daily-reports")
- **🔗 Connection Context** — Queries remember their original connection, database, and schema
- **📓 Quick Reopening** — Click "Open in Notebook" to restore the query with full context in a new notebook
- **✏️ Edit Anytime** — Modify title, description, tags, and SQL without creating duplicates
- **🤖 AI Metadata** — Auto-generate titles, descriptions, and tags using AI
- **📊 Rich Metadata Display** — Hover to see creation date, last used, database, and schema

### Usage
1. **Save Query**: Click "Save Query" CodeLens button on any SQL cell in a notebook
2. **Add Metadata**: Enter title, description, and tags (AI can help auto-generate)
3. **Organize**: Use tags to group related queries
4. **Reuse**: Click a saved query → "Open in Notebook" to restore with original context
5. **Edit**: Right-click any saved query → "Edit Query" to modify it

---

## 🤖 AI-Powered Operations

NexQL integrates advanced AI capabilities directly into your workflow, but keeps **YOU** in control.

### 🚀 NexQL Free AI — Zero-Config (Default)

No API keys, no provider accounts, no setup. NexQL Free AI is the **default AI provider**, powered by managed models behind a secure gateway proxy. Three tiered models available:

- 🧠 **Smart** (free) — Daily-use AI for queries, explanations, and schema help. ~600K tokens/month.
- 🔧 **Engineer** (Sponsor · $2/month) — Advanced model for tough optimization and migration problems. ~3M tokens/month (~5× free).
- 🏗️ **Architect** (Singularity · $9/month) — The best AI for database engineering. ~10M tokens/month (~16× free).

**Configure your AI provider**: Open VS Code Settings → search `postgresExplorer.ai.chat.provider` or run **NexQL: Open AI Settings** from the Command Palette. [AI Settings documentation →](https://nexql.astrx.dev/#ai)

### 🔐 Bring Your Own Provider
Prefer your own keys? NexQL supports GitHub Models, OpenAI, Anthropic, Gemini, VS Code LM, Ollama, LM Studio, and custom endpoints. See [AI Settings](#-ai-powered-operations) for per-provider configuration.

### 🔐 GitHub Models via GitHub Sign-In
Use GitHub Models without manually managing a PAT in normal VS Code authentication flows.
- **Native Sign-In**: Connect with your GitHub account from AI Settings.
- **Model Catalog Access**: List and select available GitHub-hosted models.
- **Session-Based Auth**: Uses VS Code GitHub authentication sessions instead of storing provider tokens.

### 🧩 SQL Assistant Tabs
Use SQL Assistant where you work, not only in the sidebar.
- **Open in Editor Tab**: Run `SQL Assistant: Open in Editor Tab` from Command Palette.
- **Parallel Assistants**: Open multiple SQL Assistant tabs for separate tasks (e.g., optimization, migration, and schema exploration).

### 🪄 Generate Query (Natural Language → SQL)
Describe what you need in plain English (e.g., "Show me top 10 users by order count"), and NexQL will generate the SQL for you using your schema context.
- **Command Palette**: `AI: Generate Query`
- **Context-Aware**: The AI understands your table schemas, columns, and relationships.

### ⚡ Performance Optimization
Click the **Optimize** button on any successful query result.
- **Explain Scripts**: Generates `EXPLAIN ANALYZE` commands for deeper profiling.
- **Static Analysis**: Suggests missing indexes, query rewrites, or schema improvements.

### 📊 Data Analysis
Click the **Analyze Data** button in result tables.
- **Clean Workflow**: Automatically exports data to a temporary CSV and attaches it to the chat.
- **Actionable Insights**: AI summarizes patterns, trends, and outliers in your result sets.

### ✨ Error Handling (Explain & Fix)
When a query fails, get instant help directly in the error cell.
- **Explain Error**: Translates cryptic Postgres errors into plain English.
- **Fix Query**: Suggests corrected SQL to resolve the error.

### 🔌 MCP Server — New in v2.2.0

NexQL ships a built-in **Model Context Protocol (MCP) server** that exposes your connected PostgreSQL database as live-indexed tools, consumable by Copilot, Cursor, Claude Desktop, and any other MCP-compatible AI agent.

- **Auto-Discovery** — Registers with VS Code's MCP registry automatically; no manual URL or config needed.
- **Read-Only DB Tools** — Schema discovery, safe SQL execution, EXPLAIN, join-path traversal, and performance analytics.
- **Schema Grounding** — Agents are instructed to verify live schema before writing SQL, preventing hallucinated table names.
- **Session Security** — Per-session bearer token, idle TTL sweep, and 200 req/min rate limit.
- **Persistent Token, Fixed Port (v2.2.1+)** — The bearer token survives extension host restarts (stored in `SecretStorage`), and `postgresExplorer.mcp.port` lets you pin a fixed local port instead of a new random one every restart — handy for external clients like Cursor/Antigravity that need a stable endpoint to hard-code.
- **Configure** via **NexQL Settings → Preferences** — enable/disable, set a fixed port, view port/token, toggle auto-start.

### 🛡️ Safe Execution Model (Notebook-First)
We believe AI should assist, not take over. **No query is ever executed automatically.**
1. **Ask/Trigger**: You use one of the AI features.
2. **Review**: The AI generates SQL or suggestions in the chat.
3. **Insert**: You click "Open in Notebook" to place code into a cell.
4. **Execute**: You review the code and click "Run" when you are ready.

---

## 📊 Advanced Visualizations

Turn any query result into beautiful, interactive charts in seconds.

- **One-Click Charting**: Instantly visualize your data directly from the notebook results.
- **Customizable**: Toggle between Bar, Line, Pie, Doughnut, and Scatter charts.
- **Rich Data Display**:
    - **Log Scale**: Easily analyze data with wide variances.
    - **Blur/Glow Effects**: Modern, high-fidelity chart aesthetics.
    - **Zoom & Pan**: Inspect detailed data points interactively.

---

## 🛠️ Local Development

### Prerequisites

- **Node.js** ≥ 18.0.0
- **VS Code** ≥ 1.90.0
- **PostgreSQL** (for testing)

### Setup

```bash
# Clone the repository
git clone https://github.com/dev-asterix/NexQL.git
cd NexQL

# Install dependencies
npm install

# Compile TypeScript
npm run compile
```

### Development Commands

| Command | Description |
|---------|-------------|
| `npm run watch` | Watch mode (auto-recompile) |
| `npm run compile` | One-time TypeScript compilation |
| `npm run esbuild` | Bundle with esbuild (with sourcemaps) |
| `npm run esbuild-watch` | Bundle in watch mode |
| `npm run test` | Run unit tests |
| `npm run coverage` | Run tests with coverage |
| `npm run vscode:prepublish` | Build for production |

### Running the Extension

1. Open the project in VS Code
2. Press `F5` to launch Extension Development Host
3. Or use **Run and Debug** (`Ctrl+Shift+D`) → "Run Extension"

### Debugging Tips

- **Output Panel**: `Ctrl+Shift+U` → Select "NexQL"
- **DevTools**: `Ctrl+Shift+I` in Extension Development Host
- **Webview Debug**: Right-click in webview → "Inspect"

---

## 🧪 Testing

### Quick Start

```bash
# Install dependencies
npm ci

# Run all tests
npm run test:all

# Run tests with coverage
npm run coverage

# Run specific test types
npm run test:unit           # Unit tests
npm run test:integration    # Integration tests with Docker
npm run test:renderer       # Renderer component tests
```

### Docker-Based Integration Tests

```bash
# Start PostgreSQL containers (12-17)
make docker-up

# Run integration tests
npm run test:integration

# Stop containers
make docker-down
```

### Using Make

```bash
make test-unit           # Unit tests
make test-integration    # Integration tests
make test-renderer       # Renderer component tests
make test-all            # All tests
make coverage            # Coverage report
make test-full           # Full suite with Docker
```

### Using Test Scripts

**Linux/macOS:**
```bash
./scripts/test.sh --unit
./scripts/test.sh --integration --pg 16
./scripts/test.sh --coverage
```

**Windows:**
```batch
scripts\test.bat --unit
scripts\test.bat --integration --pg 16
scripts\test.bat --coverage
```

### Testing Infrastructure

NexQL includes comprehensive testing infrastructure:

- **Unit Tests** (50%+ coverage): Mocha + Chai + Sinon
- **Integration Tests**: Connection lifecycle, SSL, pool exhaustion, version compatibility
- **Component Tests**: Renderer with jsdom, tree views, forms, dashboards
- **Docker Containers**: PostgreSQL 12, 14, 15, 16, 17 for compatibility testing
- **CI/CD Pipeline**: GitHub Actions with Matrix testing (Node 18-22, PostgreSQL 12-17)

📖 **Testing docs**: Use the scripts listed above and CI workflow in `.github/workflows/test.yml`.

---

## 🤝 Contributing

- 🐛 [Report Bugs](https://github.com/dev-asterix/NexQL/issues/new?template=bug_report.md)
- 💡 [Request Features](https://github.com/dev-asterix/NexQL/issues/new?template=feature_request.md)
- 🔧 Fork → Branch → PR
- 🧪 Ensure all tests pass: `npm run test:all && npm run coverage`

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: resolve bug
docs: update documentation
refactor: code restructuring
test: add/update tests
chore: maintenance tasks
```

---

## 📦 Building & Publishing

```bash
# Build VSIX package
npx vsce package

# Publish to VS Code Marketplace
npx vsce publish

# Publish to Open VSX
npx ovsx publish
```

### Stable And Nightly Channels

- Stable releases are published from version tags (`v*`) via `.github/workflows/publish.yml`.
- Nightly releases are published on every merge to `main` via `.github/workflows/publish-nightly.yml`.

VS Code Marketplace channel behavior:

- Stable extension ID: `ric-v.postgres-explorer`
- Nightly is published as a **pre-release** of the same extension ID.
- Users can opt in/out directly from the extension page with:
    - `Switch to Pre-Release Version`
    - `Switch to Release Version`

Open VSX channel behavior:

- Stable extension ID: `ric-v.postgres-explorer`
- Nightly companion extension ID: `ric-v.postgres-explorer-nightly`
- To opt out of nightly on Open VSX-based editors, uninstall the nightly companion extension and install stable.

Nightly versioning policy:

- Nightly builds use an odd minor stream and CI run number as patch.
- Example format: `0.9.<run_number>`
- This keeps nightly versions monotonically increasing for reliable updates.

---

## 📝 License

[MIT License](LICENSE)

**Open-core notice:** This repository is the open-source core of NexQL. It builds a fully working free extension (`make package-free`) that anyone may fork, rebrand, and publish under their own extension ID (MIT). The extension published as `ric-v.postgres-explorer` on the Marketplace/Open VSX is the **pro** build — this core plus proprietary premium features (AI chat assistant, MCP server, live dashboard, Plan Studio, backup/restore, visual schema designer, database indexing) maintained in a private repository and published from there. Repository history up to v2.x predates the split and contains the formerly-bundled premium sources under MIT.

---

<div align="center">

**Made with ❤️ for the PostgreSQL Community**

[![Made with TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-336791?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-007ACC?style=flat-square&logo=visual-studio-code&logoColor=white)](https://code.visualstudio.com/)

Also on [Open VSX](https://open-vsx.org/extension/ric-v/postgres-explorer)

</div>

---

## 🔧 Troubleshooting

### Connection Issues

#### SSL Connection Failures
**Problem**: `SSL connection failed` or `certificate verify failed`

**Solutions**:
- Disable SSL (development only): Set SSL Mode to `disable`
- Use `prefer` mode (tries SSL, falls back to non-SSL)
- Provide CA certificate: SSL Mode `verify-ca` + CA Certificate path

#### Connection Timeout
**Problem**: `Connection timeout` or `ETIMEDOUT`

**Solutions**:
- Increase connection timeout in settings
- Check firewall rules
- Verify PostgreSQL `pg_hba.conf` allows remote connections
- Ensure PostgreSQL is listening on correct interface

#### SSH Tunnel Issues
**Problem**: `SSH tunnel failed to establish`

**Solutions**:
- Verify SSH credentials and host
- Test SSH connection manually: `ssh user@host -p port`
- Check SSH key permissions: `chmod 600 ~/.ssh/id_rsa`
- Ensure SSH server allows port forwarding

### Performance Issues

#### Large Result Sets
**Problem**: Querying large tables causes freezes

**Solution**: Results are automatically limited to 10,000 rows. Use `LIMIT` clause for specific row counts.

#### Slow Tree View
**Problem**: Database tree takes long to load

**Solutions**:
- Use search filter to narrow objects
- Collapse unused schemas
- Disable object count badges in settings

### Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `password authentication failed` | Wrong credentials | Verify username/password |
| `database does not exist` | Database name typo | Check database name |
| `permission denied` | Insufficient privileges | Grant SELECT permission |
| `too many connections` | Pool exhausted | Close unused connections |
| `no pg_hba.conf entry` | Access control | Add entry to `pg_hba.conf` |

---

## 🙈 Feature Comparison

| Feature | NexQL | pgAdmin | DBeaver | TablePlus |
|---------|----------|---------|---------|-----------|
| **VS Code Integration** | ✅ Native | ❌ | ❌ | ❌ |
| **SQL Notebooks** | ✅ Interactive | ❌ | ❌ | ❌ |
| **AI Assistant** | ✅ Built-in | ❌ | ❌ | ❌ |
| **Real-time Dashboard** | ✅ | ✅ | ⚠️ Limited | ⚠️ Limited |
| **Inline Cell Editing** | ✅ | ✅ | ✅ | ✅ |
| **Export Formats** | CSV, JSON, Excel | CSV, JSON | CSV, JSON, Excel | CSV, JSON, SQL |
| **SSH Tunneling** | ✅ | ✅ | ✅ | ✅ |
| **Foreign Data Wrappers** | ✅ Full | ✅ | ⚠️ Limited | ❌ |
| **License** | MIT (Free) | PostgreSQL (Free) | Apache 2.0 (Free) | Proprietary (Paid) |

### Unique to NexQL
- 🤖 AI-powered query generation and optimization
- 📓 Interactive SQL notebooks with persistent state
- 🔄 Infinite scrolling for large result sets (10k rows)
- 🎨 Modern UI integrated into VS Code
- 🚀 Hybrid connection pooling for performance

