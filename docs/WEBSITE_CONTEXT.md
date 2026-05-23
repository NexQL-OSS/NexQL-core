# Docs Website Context

Last updated: 2026-05-22
Primary entry: docs/index.html
Hosting: Vercel (migrated from GitHub Pages)

## What This Website Is

This site is a product demo and marketing landing page for PgStudio, styled and behaved like a mini VS Code workbench. It also includes a Razorpay payment checkout for sponsorship/pro support.

The core concept is:
- Show value by simulation, not by static brochure copy.
- Let users interact with a realistic "editor + explorer + SQL assistant" shell.
- Keep installation CTA visible from both full and minimized states.
- Enable paid sponsorship via Razorpay checkout (requires server-side API).

## Visual and UX Concept

The page intentionally mirrors VS Code interaction patterns:
- Top bar with docs sections and install CTA.
- Workbench shell with titlebar, activity bar, sidebar, editor tabs, breadcrumb, status bar.
- Right assistant panel with action cards and chat-like interaction.
- Query file tab with runnable SQL result simulation and chart.

The experience starts in minimized hero mode (`body.editor-minimized`) and expands to the interactive shell when users click open/demo controls.

## Information Architecture

Main content is split into three runtime partials injected into index placeholders:
- `docs/html/editor-file-views.html`
- `docs/html/assistant-panel.html`
- `docs/html/minimized-overview.html`

Editor file views model the narrative in this sequence:
1. README/product value
2. Query live demo
3. Feature catalog
4. Connection safety workflow
5. Install quick start
6. Deeper docs pages (notebooks/explorer/ai/schema/safety)

## Runtime Behavior (How It Works)

Startup flow:
1. `DOMContentLoaded`
2. `loadHtmlPartials()` fetches `data-partial` fragments and replaces placeholder roots.
3. Desktop behaviors are wired (navigation, search, tabs, query simulation, tour, assistant, stats).
4. Mobile toggles are wired.

Script load order in `index.html` is intentionally dependency-safe:
1. `js/partials.js`
2. `js/core-state.js`
3. `js/workbench.js`
4. `js/assistant.js`
5. `js/tour.js`
6. `js/visuals.js`
7. `js/bootstrap.js`

Behavior highlights:
- File switching and tab state: `openFile()`
- Sidebar panel switching: `switchSidebarPanel()`
- Product tour overlay and spotlight: `wireTour()` + `renderTourStep()`
- Query run simulation and result animation: `wireQueryRunAnimation()`
- SQL assistant canned responses and snippet actions: `wireAssistant()`
- Marketplace stat hydration and chart rendering: `hydrateMarketplaceStats()`, `renderRevenueChart()`

## Styling System

The stylesheet is layered for maintainability and cascade control:
- `docs/styles/base-theme.css`: tokens, global shell/hero/minimized fundamentals
- `docs/styles/workbench-layout.css`: workbench/chrome/layout primitives
- `docs/styles/content-panels.css`: doc pages and content-focused blocks
- `docs/styles/interactive.css`: assistants, tour, animations, mobile toggles

Aggregator:
- `docs/styles.css` imports all four in that order.

## Product Messaging Strategy

The page positions PgStudio around five practical outcomes:
- Safe connections and environment labeling
- Explorer-driven schema navigation
- Notebook-first SQL workflows
- AI-assisted SQL reasoning and optimization
- Flexible SQL Assistant placement (sidebar or editor tabs) with multi-tab workflows
- Performance tooling and explainability

The assistant panel is designed as a guided onboarding surface, not a full chatbot backend. Responses are curated to demonstrate capabilities and funnel to installation.

## SEO and Distribution Notes

`index.html` includes:
- Canonical URL, OpenGraph, Twitter cards
- `SoftwareApplication` JSON-LD
- Marketplace icon assets

Primary conversion links:
- VS Code Marketplace install
- GitHub repository
- Open VSX listing

## Deployment (Vercel)

The site is deployed on Vercel with two components:
- **Static site**: Served from `docs/` directory (configured via `vercel.json` `outputDirectory`)
- **Serverless API**: Three functions in `api/` for Razorpay checkout:
  - `GET /api/config` — serves the public Razorpay Key ID
  - `POST /api/create-order` — creates a Razorpay order (uses `RAZORPAY_KEY_SECRET`)
  - `POST /api/verify-payment` — verifies payment signatures

Environment variables (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) are configured in the Vercel Dashboard, not committed to the repo.

The `api/package.json` declares serverless-specific dependencies (only `razorpay` SDK). This is separate from the root `package.json` which is for the VS Code extension.

For local development, use `node scripts/dev-server.js` which serves `docs/` statically and mounts the `api/` handlers as Express routes, or use `npx vercel dev` for a full Vercel emulation.

Custom domain (`pgstudio.astrx.dev`) is managed via Vercel Dashboard → Domains.

## Maintenance Rules

When editing this site:
- Keep partial placeholders and paths stable unless updating both HTML and loader.
- Preserve script ordering; modules depend on global symbols from earlier files.
- Treat this as a simulated product experience; avoid replacing interaction with static text.
- Maintain install CTAs in both topbar and minimized overview.
- Verify both desktop and mobile toggle flows after major UI changes.
- Never commit `RAZORPAY_KEY_SECRET` or live credentials; use Vercel environment variables.
- When adding new API endpoints, add them to both `api/` and `scripts/dev-server.js`.

## Known Environment Note

This review is based on source-level inspection in this workspace. Runtime browser introspection from the agent was unavailable because chat browser tools are not enabled in the current VS Code environment.

