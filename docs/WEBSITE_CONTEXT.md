# Docs Website Context

Last updated: 2026-06-11
Primary entry: docs/index.html
Hosting: Vercel (migrated from GitHub Pages)
Design reference: [NexQL-Themes/site/](https://github.com/ric-v/NexQL-Themes/tree/main/site) (typography, pitch, dynamic theming — **not** replacing the interactive workbench demo)

## What This Website Is

This site is a product demo and marketing landing page for NexQL. It includes Razorpay subscription checkout for **Sponsor** and **Singularity** paid tiers.

The **canonical interactive demo** is the full VS Code workbench shell in `docs/index.html` (minimized hero preview → expandable workbench with tour, assistant, query simulation). Do not replace it with a static brochure or the NexQL Themes gallery layout.

Core concept:
- Show value by simulation, not static brochure copy.
- Let users interact with a realistic editor + explorer + SQL assistant shell.
- Keep install CTA visible from minimized and expanded states.
- Paid subscriptions via Razorpay (server API + Razorpay Plans in dashboard).
- **Live theme switching** via the header dropdown — landing + workbench chrome repaint from NexQL Themes JSON (no theme files committed in PgStudio).

## NexQL Themes integration (no duplication)

Theme JSON lives only in the **[NexQL-Themes](https://github.com/ric-v/NexQL-Themes)** repo (`themes/*.json`). PgStudio loads them at runtime:

| Environment | Theme source |
|-------------|----------------|
| Production | `https://nexql-themes.astrx.dev/themes/` (CDN) |
| Local `npm run dev:site` | `/themes` proxied to `../NexQL-Themes/themes` when sibling repo exists |
| Override | `data-themes-base` on `<html>` |

**Parser** (`parse-theme-summary.mjs`) is vendored into `docs/js/vendor/` by `npm run prebuild:site` (copied from `NexQL-Themes/src/site/`). This is build logic, not theme data.

**Runtime module:** `docs/js/theme-loader.mjs`
- Fetches manifest + theme JSON → `parseThemeSummary()` → CSS custom properties on `:root`
- Persists choice in `localStorage` key `pgstudio-docs-theme`
- Default theme: `claudy-day`
- Fallback palette if CDN/proxy unavailable (Drift Dark–like tokens)
- Exposes `window.NexqlThemes` for workbench integration

**Cross-links:** Nav/footer → [nexql-themes.astrx.dev](https://nexql-themes.astrx.dev/)

## Design tokens

Defined in `docs/styles/base-theme.css` and **overwritten at runtime** by `theme-loader.mjs`:

| Layer | Tokens |
|-------|--------|
| Surfaces | `--bg`, `--fg`, `--panel`, `--deep`, `--border`, `--muted`, `--accent` |
| Workbench | `--vsc-*` mapped from active theme summary |
| SQL demo | `--sql-kw`, `--sql-fn`, `--sql-str`, `--sql-num`, `--sql-comment` |
| Fixed brand | `--nex-grad` (ribbon gradient for `.grad-text`, install CTA — not theme-skinned) |

Fonts: **Space Grotesk** (UI), **Instrument Serif** (hero accent), **JetBrains Mono** (code).

Utilities: `.grad-text`, `.brand-gradient`, `.hero-serif-em`, `.pg-anim`, `.eyebrow`.

## Landing information architecture

Scroll container: `.hero-shell` (scroll-snap in minimized mode).

1. **Hero** — eyebrow (NexQL Themes link), headline, lede, trust KPIs, CTAs (Install · Run demo · Browse Themes), mini preview
2. **Marquee** — capability chips
3. **Features** (`#features`) — metrics strip + area tile grids
4. **AI showcase** (`#ai`) — plain-English → SQL + provider chips
5. **Comparison** (`#compare`) — NexQL vs pgAdmin / DBeaver / TablePlus
6. **Workflow** — Connect → Explore → Query → Analyze
7. **FAQ** (`#faq`) — includes “Which databases work with NexQL?” → [COMPATIBILITY.md](./COMPATIBILITY.md) on GitHub
8. **Pricing** — Free / Sponsor / Singularity (Razorpay)
9. **Install CTA** (`#install`)
10. **Footer** — Resources · Community · Install

Top nav: **Features · AI · Compare · FAQ · Pricing · Themes · GitHub · Install — free**

**Platform compatibility:** NexQL works with any PostgreSQL-wire database. Canonical matrix and per-provider connection guides live in [COMPATIBILITY.md](./COMPATIBILITY.md) (chip strip below the workflow loop, FAQ, and footer **Platform compatibility**). Hero KPI strip shows **PG 12+ / compatible**; named platforms appear in the workflow chip strip.

## Pricing tiers

| Tier | Key | Audience | Payment |
|------|-----|----------|---------|
| Free | — | Everyone | $0 — Marketplace |
| Sponsor | `sponsor` | Individual pro | Razorpay subscription |
| Singularity | `singularity` | Teams / org | Razorpay subscription, flat org license |

**Full Razorpay setup:** [RAZORPAY.md](./RAZORPAY.md)

## Runtime behavior

Startup: `theme-loader.mjs` (module) → `DOMContentLoaded` → await `NexqlThemes.ready` → `loadHtmlPartials()` → wire demo + pricing.

Script order in `index.html`:
1. `partials.js` → `core-state.js` → `workbench.js` → `assistant.js` → `tour.js` → `visuals.js` → `landing-capabilities.js` → `pricing.js` → `checkout.js` → **`theme-loader.mjs` (module)** → `bootstrap.js`

## Styling layers

- `base-theme.css` — tokens, hero, theme select, minimized layout, aurora
- `workbench-layout.css` — demo chrome (reskinned via `--vsc-*` / `--sql-*`)
- `content-panels.css` — in-demo doc pages
- `interactive.css` — tour, assistant, mobile
- `landing-sections.css` — marquee, metrics, tiles, AI, compare, workflow, FAQ, pricing, footer

Aggregator: `docs/styles.css`

## Deployment (Vercel)

- Build: `npm run build:site` (syncs parser → copies `docs/` to `dist/`)
- Static output: `dist/`
- API: `api/config`, `api/create-subscription`, `api/verify-payment`, etc.

Quick local dev:

```bash
cp .env.example .env   # fill RAZORPAY_KEY_* and all RAZORPAY_PLAN_*
cd api && npm install && cd ..
npm run dev:site       # http://localhost:3000 — /themes proxied if ../NexQL-Themes exists
```

Extension license delivery after payment is **not** implemented yet — see `docs/roadmap/license-implementation.md`.

## Maintenance rules

- Keep partial paths and script order stable (theme-loader before bootstrap).
- Preserve interactive demo behavior; reskin via CSS tokens + theme-loader only.
- Do **not** commit `themes/*.json` into PgStudio — update themes in NexQL-Themes repo.
- After NexQL-Themes parser changes, run `npm run prebuild:site` (or full `build:site`) before deploy.
- Mobile: test 375px / 640px / 980px — theme dropdown in topbar actions.
