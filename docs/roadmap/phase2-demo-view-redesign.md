# Phase 2 — Demo View Redesign Scope

## Context

Phase 1 delivered a new dark two-column hero landing page. The full interactive workbench (opened when the user clicks "Open interactive demo") retains its existing visual style. Phase 2 brings that shell into visual alignment with the new landing design.

**Prerequisite:** Phase 1 landing is live and stable.

## Objective

Refresh the visual language of the interactive VS Code shell demo without changing any of its behavior, JS wiring, or content.

---

## Scope Boundaries

### In scope
- Visual CSS overhaul of the full workbench shell and all its chrome elements
- Topbar, titlebar, activity bar, sidebar, editor region, tabs, breadcrumb, status bar
- Right assistant panel (layout, typography, chat bubbles, action cards)
- Content panels: query cell, result table, insight panel, feature cards, connection form
- Tour overlay and spotlight
- Toast notification
- Mobile responsive tweaks to align with the new dark brand

### Out of scope
- Any JS behavior changes (wireActivityBar, openFile, wireAssistant, wireTour, etc.)
- Any HTML structural changes that alter element IDs, classes, or `data-*` attributes used by JS
- Content changes to `editor-file-views.html` or `assistant-panel.html`
- SEO metadata or structured data
- Build process or extension TypeScript code

---

## Design Direction

Pull directly from Phase 1 landing design tokens:

| Token | Value |
|---|---|
| Shell background | `#0c1528` |
| Sidebar background | `#0d1b30` |
| Border color | `rgba(255,255,255,0.07)` |
| Accent (active tab, highlight) | `#f97316` (orange) |
| Secondary accent | `#3b82f6` (blue) |
| Muted text | `rgba(255,255,255,0.38)` |
| Primary text | `rgba(255,255,255,0.82)` |
| Surface | `rgba(255,255,255,0.04)` |

Typography: Retain `Google Sans`, `Segoe UI` sans-serif stack. Increase contrast of muted labels by ~10%.

---

## Affected Files

| File | Change type |
|---|---|
| `docs/styles/base-theme.css` | Add `[data-theme="dark"]`-scoped shell token overrides |
| `docs/styles/workbench-layout.css` | Visual updates to chrome: titlebar, activitybar, sidebar, statusbar, tabs |
| `docs/styles/content-panels.css` | Visual updates to cell, result table, insight panel, feature card, markdown, form |
| `docs/styles/interactive.css` | Visual updates to assistant panel, chat bubbles, tour overlay, toast |
| `docs/html/assistant-panel.html` | Structural clean-up only (no class/ID changes), improve nesting for visual targets |
| `docs/html/editor-file-views.html` | Structural clean-up only (no class/ID changes) |

---

## Implementation Checklist

### Workbench Chrome
- [ ] Titlebar gradient → flat deep navy with subtle bottom border
- [ ] Window traffic lights (dots) retain exact colors, add hover opacity effect
- [ ] Activity bar: deeper background, active indicator scales to match orange brand
- [ ] Sidebar: border separators at 6% opacity white; header labels match muted token
- [ ] Tab bar: active tab top border stays orange; inactive tab background aligns with `#0d1b30`
- [ ] Breadcrumb: muted separator and filename, match muted token
- [ ] Status bar: keep existing blue; adjust text opacity to 90% white for legibility

### Editor Region
- [ ] SQL cell border: `rgba(255,255,255,0.07)`
- [ ] Cell lens toolbar: same surface as workbench, action buttons match ghost style
- [ ] Query result table: header background `rgba(255,255,255,0.04)`, row borders at 4% white
- [ ] Insight panel: blue-tinted surface, consistent with landing `mini-wb-insight-bar` style
- [ ] Feature cards: dark surface, hover state with orange border outline

### SQL Assistant Panel
- [ ] Panel background: `#0c1528` or slightly lighter variant
- [ ] Schema context bar: match `mini-wb-schema-pill` token exactly
- [ ] Action cards: dark surface, icon + label, hover with subtle blue glow
- [ ] Chat bubbles (user): match `mini-chat-user` orange-tinted background
- [ ] Chat bubbles (assistant): match `mini-chat-ai` translucent surface
- [ ] Typing indicator dots: match the new brand accent blue
- [ ] Install CTA link: orange styled, consistent with primary CTA from landing

### Tour Overlay
- [ ] Spotlight ring: orange accent, `rgba(249,115,22,0.35)` glow
- [ ] Tooltip: dark surface matching shell background, border at 8% white
- [ ] Nav buttons: match ghost button style from landing CTAs

### Toast
- [ ] Dark surface, orange elephant icon accent, matches workbench shell background

### Mobile
- [ ] Verify topbar collapse still readable on dark background
- [ ] Mobile workbench panels (show-left, show-right) overlay dark surface properly

---

## Non-Regression Rules for Phase 2

- All element IDs remain identical — JS queries must not need changes
- All class names used by JS queries (`.file-view`, `.tab`, `.tree-row`, `.cell`, `.chat-msg`, etc.) must not be renamed or removed
- Only CSS property values change; no structural HTML changes that touch interactive selectors
- After each file change: run a browser smoke test that verifies
  1. Landing opens dark
  2. "Open interactive demo" expands the shell
  3. File navigation (tree row click) switches the editor view
  4. Query run button animates and shows results
  5. AI assistant action cards trigger chat responses
  6. Tour play button starts the tour overlay
  7. Close dot returns to landing

---

## Isolation Strategy

All Phase 2 CSS overrides should be scoped to `body[data-theme="dark"]` where possible, so that any future light-mode or theme-agnostic path is not silently broken. Use the existing dark-mode selector blocks in each CSS file rather than adding root-level overrides.
