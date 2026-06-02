# Docs Website Context

Last updated: 2026-05-31
Primary entry: docs/index.html
Hosting: Vercel (migrated from GitHub Pages)
Design reference: nexql.html (palette/copy only — **not** the inline IDE demo)

## What This Website Is

This site is a product demo and marketing landing page for PgStudio, styled with the **NexQL** spectrum (blue → indigo → magenta → amber on `#07080E`). It includes Razorpay subscription checkout for **Sponsor** and **Singularity** paid tiers.

The **canonical interactive demo** is the full VS Code workbench shell in `docs/index.html` (minimized hero preview → expandable workbench with tour, assistant, query simulation). Do not replace it with nexql.html’s simpler inline IDE.

Core concept:
- Show value by simulation, not static brochure copy.
- Let users interact with a realistic editor + explorer + SQL assistant shell.
- Keep install CTA visible from minimized and expanded states.
- Paid subscriptions via Razorpay (server API + Razorpay Plans in dashboard).

## Design tokens (NexQL)

Defined in `docs/styles/base-theme.css`:

| Token | Value |
|-------|--------|
| `--nex-blue` | `#3D6BFF` |
| `--nex-indigo` | `#6C4CF0` |
| `--nex-magenta` | `#E0379E` |
| `--nex-amber` | `#FF8A3D` |
| `--nex-bg` | `#07080E` |
| `--nex-grad` | 110° blue → indigo → magenta → amber |
| Fonts | **Sora** (display), **Inter** (body), **JetBrains Mono** (code) |

Utilities: `.grad-text`, `.eyebrow`. Landing aurora + grain on `.hero-shell` (CSS; `prefers-reduced-motion` disables drift).

## Landing information architecture

Scroll container: `.hero-shell` (scroll-snap in minimized mode).

1. **Hero** — centered nexql layout: pill, headline, lede, trust KPIs, CTAs (Install primary · Run demo → full workbench), mini preview below
2. **Marquee** — capability chips
3. **Features** (`#features`) — metrics strip + 4×5 area tile grids (nexql structure)
4. **AI showcase** (`#ai`) — plain-English → SQL + provider chips + parallel chats copy
5. **Comparison** (`#compare`) — PgStudio vs pgAdmin / DBeaver / TablePlus
6. **Workflow** — Connect → Explore → Query → Analyze
7. **FAQ** (`#faq`) — six `<details>` items (nexql copy)
8. **Pricing** — Free / Sponsor / Singularity (Razorpay)
9. **Install CTA** (`#install`) — nexql card: Marketplace + Open VSX + CLI
10. **Footer** — Resources · Community · Install (nexql columns)

Top nav: **Features · AI · Compare · FAQ · Pricing · GitHub · Install — free** — smooth scroll via `scrollToLandingAnchor()` in `bootstrap.js`.

## Pricing tiers

| Tier | Key | Audience | Payment |
|------|-----|----------|---------|
| Free | — | Everyone | $0 — Marketplace |
| Sponsor | `sponsor` | Individual pro | Razorpay subscription |
| Singularity | `singularity` | Teams / org | Razorpay subscription, flat org license |

Pricing UI: monthly/annual + INR/USD toggles (`docs/js/pricing.js`); checkout uses `data-tier="sponsor"` / `"singularity"`.

## Runtime behavior

Startup: `DOMContentLoaded` → `loadHtmlPartials()` → `partials-loaded` → wire pricing/checkout.

Script order in `index.html`:
1. `partials.js` → `core-state.js` → `workbench.js` → `assistant.js` → `tour.js` → `visuals.js` → `landing-capabilities.js` → `pricing.js` → `checkout.js` → `bootstrap.js`

## Styling layers

- `base-theme.css` — tokens, hero, minimized layout, aurora
- `workbench-layout.css` — demo chrome (reskinned via tokens)
- `content-panels.css` — in-demo doc pages
- `interactive.css` — tour, assistant, mobile
- `landing-sections.css` — marquee, metrics, tiles, AI, compare, workflow, FAQ, pricing, footer

Aggregator: `docs/styles.css`

## Deployment (Vercel)

- Static: `docs/`
- API: `api/config`, `api/create-subscription`, `api/verify-payment`
- Plan config: `api/plan-config.js`

Environment (see `.env.example`):
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
- `RAZORPAY_PLAN_{SPONSOR|SINGULARITY}_{MONTHLY|ANNUAL}_{INR|USD}` — eight plan IDs
- Optional `RAZORPAY_DISPLAY_*` overrides

Local dev:

```bash
cp .env.example .env
cd api && npm install
npm run dev:site   # http://localhost:3000
```

**Post-rebrand deploy:** Recreate or rename Razorpay Plans and update Vercel env vars. Old `RAZORPAY_PLAN_STUDIO_*` / `TEAM_*` keys will not resolve until migrated.

## Razorpay dashboard (manual)

1. Create **8 Plans**: Sponsor + Singularity × monthly/annual × INR/USD.
2. Paste `plan_...` IDs into env.
3. Enable international payments for USD plans.
4. Test mode cards for INR/USD.

License activation / webhooks remain follow-up (`docs/roadmap/license-implementation.md`).

## Maintenance rules

- Keep partial paths and script order stable.
- Preserve interactive demo behavior; reskin via CSS tokens only.
- After pricing/API changes, confirm `partials-loaded` still fires.
- Mobile: test 375px / 640px / 980px — no horizontal body overflow; pricing nav in collapsible topbar.
- `nexql.html` is reference-only; do not port its inline IDE into docs.
