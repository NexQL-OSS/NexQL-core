# NexQL Design System

Unified visual language for webview panels, tree views, and notebook renderer output.

## Token layers

| Layer | Location | Consumed by |
|-------|----------|-------------|
| `--pg-*` tokens | `templates/shared/styles.css` | All webview panels via `readSharedTemplateCss()` |
| Component classes | `templates/shared/components.css` | Panels using `prependSharedTemplateCss` / `loadPanelTemplate` |
| `MODERN_WEBVIEW_BASE_CSS` | `src/common/htmlStyles.ts` | Injected before shared CSS in panel loaders |
| Renderer mirrors | `src/ui/renderer/rendererConstants.ts` | Notebook renderer only (`--vscode-*` vars) |
| Tree colors | `package.json` → `contributes.colors` | `ThemeColor('postgres.*')` in tree providers |

## Token catalog (webview)

### Surfaces
- `--pg-ui-surface`, `--pg-ui-surface-raised`, `--pg-ui-surface-muted`
- `--pg-ui-border`, `--pg-ui-border-strong`, `--pg-ui-hover`

### Brand & accent
- `--pg-brand-accent`, `--pg-brand-accent-muted`
- `--pg-accent-gradient` — subtle radial highlight on cards

### Glass & elevation
- `--pg-glass-bg`, `--pg-glass-blur` — **floating elements only**
- `--pg-elevation-1` / `-2` / `-3` — layered shadows

### Environment semantics
- `--env-prod`, `--env-staging`, `--env-dev`

## Selective glass rule

| Use blur (`backdrop-filter`) | No blur (raised surface + shadow) |
|------------------------------|-----------------------------------|
| `.pg-modal-backdrop`, `.pg-toast` | `.pg-card`, `.pg-hero-card`, fields, tables |
| Renderer hover toolbars, sentinel top bar | Result container body, tab panels |

## Component classes

| Class | Purpose |
|-------|---------|
| `.pg-card` / `.pg-card-header` / `.pg-card-body` | Standard content card |
| `.pg-hero-card` | Featured card with gradient top bar |
| `.pg-badge`, `.pg-pill`, `.pg-status-dot` | Status & tags |
| `.pg-tab-strip` / `.pg-tab-btn` / `.pg-tab-panel` | Tab navigation |
| `.pg-btn`, `.pg-btn-sm`, `.pg-btn-danger` | Buttons (extends shared `.pg-btn--*`) |
| `.pg-empty-state` | Empty / zero-data states |
| `.pg-modal-backdrop` / `.pg-modal` | Dialogs |
| `.pg-toast` | Floating notifications |

Settings Hub retains `.hub-*` classes; its `--hub-*` tokens alias `--pg-*` for backward compatibility.

## When to use which loader

| Pattern | Use when |
|---------|----------|
| `loadPanelTemplate(webview, uri, folder, vars)` | New/simple panels with `index.html` + CSP + nonce |
| `loadCompleteTemplate(uri, folder, vars)` | Panels with `{{STYLES}}`/`{{SCRIPTS}}` placeholders only |
| Manual load (Settings Hub, Chat, Dashboard) | Complex variable injection, external script URIs, or legacy templates |

All panel loaders should prepend `MODERN_WEBVIEW_BASE_CSS` + `readSharedTemplateCss()` (includes `components.css`).

## Tree icon palette

Centralized in `src/providers/tree/treeIconTheme.ts`. Override brand accent:

```json
"workbench.colorCustomizations": {
  "postgres.accent": "#7c3aed"
}
```

## Renderer notes

The notebook renderer sandbox cannot read `--pg-*`. Mirror needed values in `rendererConstants.ts` using `--vscode-*` and `color-mix`. Chart.js palettes resolve at runtime via `getThemeChartPalette()`.
