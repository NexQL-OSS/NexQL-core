# Plan: Make NexQL Demo Site Feel Like a Lived-In VS Code + Helpful SQL Assistant

## Context

The site at `docs/index.html` simulates VS Code for NexQL marketing. It's polished but thin — VS Code chrome exists but lacks the micro-details that signal authenticity (line numbers, git badges, problem indicators, a real multi-turn conversation). The SQL assistant is a teaser: one canned Q&A turn, no streaming, no schema context. This plan upgrades both to make a developer immediately feel at home.

---

## Priority 0 — Witty, Personality-Driven Assistant Tone + Install Nudge

**Files:** `docs/js/core-state.js`, `docs/js/workbench.js`, `docs/js/assistant.js`, `docs/js/tour.js`

### Tone rewrite goals
- Responses should feel like a senior DBA who's also mildly funny — confident, specific, occasionally self-aware ("I see dead queries")
- Every assistant reply that isn't a direct answer should end with a concrete, specific install nudge (not generic "install to continue")
- Free-form teaser responses should name what the user *would* get, not just say "install first"

### Canned response rewrites in `core-state.js`

Replace generic `ASSISTANT_RESPONSES` entries with personality-driven versions. Examples:

**`slow-revenue`** reply:
> "Ah yes, the classic 3-second dashboard query — I call it the 'morning coffee loading screen'. Your `orders.created_at` is getting a full table scan. One index and a materialized view and you'll wonder why you ever waited. `CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at DESC);` — run that and watch it drop to sub-100ms. Install NexQL and I'll show you the EXPLAIN diff live, before and after. 📈"

**`ask-ai`** reply:
> "That's exactly what I'm here for. Give me a slow query, a weird join, or just paste your `EXPLAIN ANALYZE` output and I'll tell you what the planner is thinking (and why it's wrong). Once you install NexQL I'll have live access to your actual schema — no more guessing column types."

### `preloadAssistantConversation()` turn 1 schema-intro:
> "Yes — I can see `ecommerce_demo`. You've got an `orders` table with ~480K rows, `created_at` indexed... wait, actually it's *not* indexed. That's your problem right there. 🙃 Full schema: `id` (bigint PK), `customer_id` (→ customers), `created_at` (timestamptz, **unindexed**), `amount` (numeric 10,2), `status` (text). What are you trying to run?"

### `preloadAssistantConversation()` turn 2 slow-query-deep:
> "3 seconds. On 7 days of data. Yep — sequential scan on `created_at`, ~480K rows, no filtering shortcut. The fix is embarrassingly simple:\n\n`CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at DESC);`\n\nAfter that: under 80ms. Also stash the daily rollup in a materialized view and your dashboard will feel instantaneous. Want me to write the full view? Install NexQL and I'll generate it against your live schema."

### Free-form teaser in `wireAssistant()` `handleSend()`:

Rewrite `buildFreeFormTeaser` returns and the wrapper to be specific:

```javascript
// Replace the generic teaser wrapper:
appendChatMessage(logId, "assistant",
  `Good question. Here's what I'd look at first:\n\n${buildFreeFormTeaser(text).join("\n")}\n\n` +
  `Install NexQL and I'll run this against your actual database — no copy-paste required. ` +
  `Takes about 30 seconds to set up.\n\n` +
  `<a class="chat-install-cta" href="https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer" target="_blank">⬇ Install free — live answers in VS Code →</a>`
);
```

Update `buildFreeFormTeaser` patterns in `tour.js` to be more direct and confident — replace vague hints like "check your indexes" with specific SQL snippets and outcomes.

### Action card responses in `PRODUCT_HIGHLIGHTS` (`core-state.js`):

Each highlight's `tip` field should end with an install CTA variant:
- "Try it now: install NexQL and connect in under a minute."
- "See it live: install and open any `.pgsql` notebook."
- "Get this in your VS Code — install takes 30 seconds."

Rotate these so each card has a distinct CTA phrasing.

---

## Priority 0b — GIF Files as Clickable Explorer Entries (Open in Editor Tab)

**Files:** `docs/index.html`, `docs/html/editor-file-views.html`, `docs/js/core-state.js`, `docs/js/workbench.js`, `docs/styles/content-panels.css`

Assets available in `docs/assets/`:
- `01-setup.gif` → "Setup & Connect" workflow
- `02-more-settings.gif` → "AI Assistant setup"
- `03-ai-assist.gif` → "Database Explorer"
- `04-ai-copilot.gif` → "AI Assist in action"

### Explorer sidebar tree entries (index.html)

Add a `demos/` folder group in the Explorer panel (after existing tree items, before connections.demo):

```html
<div class="tree-row depth-1 tree-folder">
  <span class="tree-arrow">▼</span>
  <span class="tree-label">demos</span>
</div>
<button class="tree-row depth-2" data-open="gif-setup">
  <span class="tree-label">
    <span class="tree-file-icon gif-icon" aria-hidden="true"></span>01-setup.gif
  </span>
</button>
<button class="tree-row depth-2" data-open="gif-ai-setup">
  <span class="tree-label">
    <span class="tree-file-icon gif-icon" aria-hidden="true"></span>02-more-settings.gif
  </span>
</button>
<button class="tree-row depth-2" data-open="gif-explorer">
  <span class="tree-label">
    <span class="tree-file-icon gif-icon" aria-hidden="true"></span>03-ai-assist.gif
  </span>
</button>
<button class="tree-row depth-2" data-open="gif-ai">
  <span class="tree-label">
    <span class="tree-file-icon gif-icon" aria-hidden="true"></span>04-ai-copilot.gif
  </span>
</button>
```

### New file view panels (editor-file-views.html)

Add 4 new `<article class="file-view">` panels that mimic VS Code's image preview style:

```html
<article class="file-view" id="file-gif-setup">
  <div class="gif-viewer">
    <div class="gif-viewer-toolbar">
      <span class="gif-viewer-name">01-setup.gif</span>
      <span class="gif-viewer-meta">GIF • demos/</span>
    </div>
    <div class="gif-viewer-canvas">
      <img src="assets/01-setup.gif" alt="NexQL setup and connection workflow" class="gif-viewer-img">
    </div>
    <div class="gif-viewer-footer">
      <span>Connect to PostgreSQL in seconds — label your environment, test the connection, done.</span>
      <a class="gif-install-cta" href="https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer">⬇ Install NexQL →</a>
    </div>
  </div>
</article>
<!-- Repeat pattern for gif-ai-setup, gif-explorer, gif-ai with matching src/copy -->
```

### `BREADCRUMB_LABELS` + `FILE_STATUS` updates in `core-state.js`

```javascript
"gif-setup":    { label: "01-setup.gif",          connection: "● demo_db", line: "", file: "GIF" },
"gif-ai-setup": { label: "02-more-settings.gif", connection: "● demo_db", line: "", file: "GIF" },
"gif-explorer": { label: "03-ai-assist.gif",        connection: "● demo_db", line: "", file: "GIF" },
"gif-ai":       { label: "04-ai-copilot.gif",       connection: "● demo_db", line: "", file: "GIF" },
```

### CSS in `content-panels.css`:

```css
.gif-viewer { display: flex; flex-direction: column; height: 100%; }
.gif-viewer-toolbar {
  align-items: center; border-bottom: 1px solid var(--vsc-border);
  display: flex; justify-content: space-between;
  padding: 6px 12px; flex-shrink: 0;
}
.gif-viewer-name { color: var(--vsc-text); font-size: 12px; font-weight: 500; }
.gif-viewer-meta { color: var(--vsc-muted); font-size: 11px; }
.gif-viewer-canvas {
  align-items: center; background: var(--vsc-editor-bg, #1e1e1e);
  display: flex; flex: 1; justify-content: center;
  overflow: auto; padding: 24px;
}
.gif-viewer-img { border-radius: 4px; box-shadow: 0 4px 24px rgba(0,0,0,.35); max-height: 480px; max-width: 100%; }
.gif-viewer-footer {
  align-items: center; border-top: 1px solid var(--vsc-border);
  display: flex; flex-shrink: 0; gap: 16px;
  justify-content: space-between; padding: 8px 14px;
}
.gif-viewer-footer span { color: var(--vsc-muted); font-size: 11.5px; }
.gif-install-cta {
  background: var(--vsc-accent); border-radius: 4px; color: #fff;
  font-size: 11.5px; font-weight: 600; padding: 5px 12px; text-decoration: none; white-space: nowrap;
}
.gif-install-cta:hover { filter: brightness(1.1); }
.tree-file-icon.gif-icon::before { content: "🎞"; font-size: 11px; }
```

### `openFile()` in `workbench.js`

The gif file names (`gif-setup`, etc.) map to `#file-gif-setup` etc. via the existing ID convention (`file-${fileName}`). No special case needed — the current logic already handles this pattern. Just ensure `BREADCRUMB_LABELS` maps them correctly.

---

## Priority 0c — Notebook Pages: Infographic Layout

**Files:** `docs/html/editor-file-views.html`, `docs/styles/content-panels.css`

Replace the plain `doc-section` markdown layout in all 5 doc pages with visually rich infographic panels that still feel at home in the VS Code editor aesthetic.

### Design patterns to use:

**1. Numbered step flow** (for "how it works" sequences):
```html
<div class="info-flow">
  <div class="info-step">
    <span class="step-num">1</span>
    <div class="step-body">
      <strong>Connect to your database</strong>
      <p>Add a host, label it DEV or PROD, test the connection.</p>
    </div>
  </div>
  <span class="step-connector" aria-hidden="true">→</span>
  <div class="info-step">...</div>
</div>
```

**2. Stat callout cards** (key metrics inline with text):
```html
<div class="stat-row">
  <div class="stat-card"><span class="stat-val">6×</span><span class="stat-label">faster than pgAdmin</span></div>
  <div class="stat-card"><span class="stat-val">&lt;1min</span><span class="stat-label">to first query</span></div>
  <div class="stat-card"><span class="stat-val">0 config</span><span class="stat-label">files needed</span></div>
</div>
```

**3. Feature grid with accent icons** (replaces bullet lists):
```html
<div class="feature-icon-grid">
  <div class="fig-item"><span class="fig-icon">🔍</span><strong>EXPLAIN Analysis</strong><p>Visual query plan breakdown</p></div>
  <div class="fig-item"><span class="fig-icon">⚡</span><strong>Index Advisor</strong><p>Automatic index recommendations</p></div>
</div>
```

**4. Code spotlight block** (replaces bare `<code>` blocks):
```html
<div class="code-spotlight">
  <div class="code-spotlight-label">QUICK START</div>
  <pre class="code-spotlight-pre"><code>CREATE INDEX CONCURRENTLY idx_orders_created_at
  ON orders (created_at DESC);</code></pre>
  <p class="code-spotlight-note">Cuts scan time from 3s → 80ms on 480K rows</p>
</div>
```

**5. Visual highlight banner** (replaces `doc-tip`):
```html
<div class="info-banner info-banner-green">
  <span class="banner-icon">✅</span>
  <div><strong>Production safe:</strong> read-only mode and PROD environment badge prevent accidental writes.</div>
</div>
```

### Apply to each doc page:

| Page | Primary pattern | Secondary pattern |
|---|---|---|
| `#file-doc-notebooks` | Info flow (4 steps) + code spotlight | Feature icon grid |
| `#file-doc-explorer` | Feature icon grid (6 items) + stat row | Info banner |
| `#file-doc-ai` | Stat row + code spotlight (EXPLAIN output) | Feature icon grid |
| `#file-doc-schema` | Feature icon grid (visual tools) + info banner | Code spotlight |
| `#file-doc-safety` | Info banner (red warning style) + info flow | Stat row |

### CSS in `content-panels.css`:

```css
/* Step flow */
.info-flow { align-items: flex-start; display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.info-step { background: var(--surface); border: 1px solid var(--vsc-border); border-radius: 6px; display: flex; gap: 10px; padding: 10px 12px; flex: 1; min-width: 160px; }
.step-num { background: var(--vsc-accent); border-radius: 50%; color: #fff; flex-shrink: 0; font-size: 11px; font-weight: 700; height: 20px; line-height: 20px; text-align: center; width: 20px; }
.step-connector { align-self: center; color: var(--vsc-muted); flex-shrink: 0; }

/* Stat cards */
.stat-row { display: flex; gap: 10px; margin: 16px 0; flex-wrap: wrap; }
.stat-card { background: var(--surface); border: 1px solid var(--vsc-border); border-radius: 6px; flex: 1; min-width: 100px; padding: 10px 12px; text-align: center; }
.stat-val { color: var(--vsc-accent); display: block; font-size: 22px; font-weight: 700; }
.stat-label { color: var(--vsc-muted); font-size: 10.5px; }

/* Feature icon grid */
.feature-icon-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); margin: 14px 0; }
.fig-item { background: var(--surface); border: 1px solid var(--vsc-border); border-radius: 6px; padding: 10px 12px; }
.fig-icon { display: block; font-size: 18px; margin-bottom: 4px; }
.fig-item strong { display: block; font-size: 12px; margin-bottom: 3px; }
.fig-item p { color: var(--vsc-muted); font-size: 10.5px; margin: 0; }

/* Code spotlight */
.code-spotlight { border: 1px solid var(--vsc-border); border-left: 3px solid var(--vsc-accent); border-radius: 0 6px 6px 0; margin: 14px 0; overflow: hidden; }
.code-spotlight-label { background: var(--surface); color: var(--vsc-muted); font-size: 9px; font-weight: 600; letter-spacing: .08em; padding: 4px 10px; }
.code-spotlight-pre { background: var(--vsc-editor-bg, #1e1e1e); color: #d4d4d4; font-family: monospace; font-size: 12px; margin: 0; overflow-x: auto; padding: 10px; }
.code-spotlight-note { background: var(--surface); color: var(--vsc-muted); font-size: 10.5px; margin: 0; padding: 5px 10px; }

/* Info banners */
.info-banner { align-items: flex-start; border-radius: 6px; display: flex; gap: 10px; margin: 14px 0; padding: 10px 12px; }
.info-banner-green { background: rgba(77,184,168,.08); border: 1px solid rgba(77,184,168,.3); }
.info-banner-amber { background: rgba(255,200,80,.08); border: 1px solid rgba(255,200,80,.3); }
.info-banner-red   { background: rgba(255,100,100,.08); border: 1px solid rgba(255,100,100,.3); }
.banner-icon { flex-shrink: 0; font-size: 14px; }
```

---

## Priority 1 — Streaming Assistant Responses

**File:** `docs/js/assistant.js`

Add `streamChatMessage(logId, role, html, onDone)` before the existing `appendChatMessage`:

```javascript
function streamChatMessage(logId, role, html, onDone) {
  if (role !== "assistant") { appendChatMessage(logId, role, html); onDone?.(); return; }
  const log = document.getElementById(logId);
  if (!log) return;
  const msg = document.createElement("div");
  msg.className = "chat-msg assistant";
  log.appendChild(msg);
  // Build a flat sequence of { type: 'text'|'html', content } tokens
  const temp = document.createElement("div");
  temp.innerHTML = html;
  const tokens = [];
  temp.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent.split("").forEach(ch => tokens.push({ type: "char", content: ch }));
    } else {
      tokens.push({ type: "element", content: node.cloneNode(true) });
    }
  });
  let i = 0;
  const interval = setInterval(() => {
    if (i >= tokens.length) {
      clearInterval(interval);
      log.scrollTop = log.scrollHeight;
      onDone?.();
      return;
    }
    const token = tokens[i++];
    if (token.type === "char") {
      msg.appendChild(document.createTextNode(token.content));
    } else {
      msg.appendChild(token.content);
    }
    log.scrollTop = log.scrollHeight;
  }, 18);
}
```

Then in `sendAssistantPreset()`, `showProductReadmeHighlight()`, and the free-form `handleSend()` inside `wireAssistant()`:
- Replace every `appendChatMessage(logId, "assistant", ...)` call with `streamChatMessage(logId, "assistant", ...)`
- Keep typing indicator: show it, remove it when streaming **begins** (not when it ends)

Also change the model label in `docs/html/assistant-panel.html` from `"VS Code LM (No Model)"` → `"GitHub Models · gpt-4o"`.

---

## Priority 2 — Multi-Turn Schema-Aware Preloaded Conversation

**Files:** `docs/js/workbench.js`, `docs/js/core-state.js`, `docs/html/assistant-panel.html`, `docs/styles/interactive.css`

### 2a. New `ASSISTANT_RESPONSES` keys in `core-state.js`:

```javascript
"schema-intro": {
  user: "Can you see my schema? I'm working on the orders table.",
  reply: `Yes — I can see <code>ecommerce_demo</code>. Your <code>orders</code> table has: <code>id</code> (bigint PK), <code>customer_id</code> (bigint FK → customers), <code>created_at</code> (timestamptz), <code>amount</code> (numeric 10,2), <code>status</code> (text). I also see <code>customers</code>, <code>products</code>, and <code>order_items</code>. What are you working on?`
},
"slow-query-deep": {
  user: "The daily revenue query is slow — runs in 3s on prod",
  reply: `3 seconds on prod for 7 days means a Seq Scan on <code>orders.created_at</code>. Fix:\n\n<code>CREATE INDEX CONCURRENTLY idx_orders_created_at\n  ON orders (created_at DESC);</code>\n\nWith ~480K rows this drops to under 80ms. Also run <code>EXPLAIN (ANALYZE, BUFFERS)</code> to confirm the scan type, and <code>ANALYZE orders;</code> after the index builds to refresh planner stats.`
}
```

### 2b. Replace `preloadAssistantConversation()` in `workbench.js`:

Chain turns via `onDone` callbacks (not hardcoded setTimeout) so they don't overlap on slow machines:

```javascript
function preloadAssistantConversation() {
  window.setTimeout(() => {
    appendChatMessage("sql-chat-log", "user", ASSISTANT_RESPONSES["schema-intro"].user);
    const t1 = showTypingIndicator("sql-chat-log");
    window.setTimeout(() => {
      t1?.remove();
      streamChatMessage("sql-chat-log", "assistant", ASSISTANT_RESPONSES["schema-intro"].reply, () => {
        window.setTimeout(() => {
          appendChatMessage("sql-chat-log", "user", ASSISTANT_RESPONSES["slow-query-deep"].user);
          const t2 = showTypingIndicator("sql-chat-log");
          window.setTimeout(() => {
            t2?.remove();
            streamChatMessage("sql-chat-log", "assistant", ASSISTANT_RESPONSES["slow-query-deep"].reply);
          }, 700);
        }, 500);
      });
    }, 600);
  }, 1400);
}
```

### 2c. Schema context chip in `docs/html/assistant-panel.html`

Add between `.assistant-subheader` and `.assistant-body`:

```html
<div class="schema-context-bar">
  <span class="schema-ctx-label">CONTEXT</span>
  <span class="schema-chip active-chip">ecommerce_demo</span>
  <span class="schema-chip">orders</span>
  <span class="schema-chip">customers</span>
  <span class="schema-chip">products</span>
</div>
```

CSS in `docs/styles/interactive.css`:

```css
.schema-context-bar {
  align-items: center; border-bottom: 1px solid var(--vsc-border);
  display: flex; flex-shrink: 0; gap: 4px; overflow-x: auto;
  padding: 4px 8px; scrollbar-width: none;
}
.schema-ctx-label { color: var(--vsc-muted); flex-shrink: 0; font-size: 9px; font-weight: 600; letter-spacing: .06em; }
.schema-chip {
  background: var(--surface); border: 1px solid var(--vsc-border); border-radius: 3px;
  color: var(--vsc-muted); flex-shrink: 0; font-family: monospace; font-size: 9.5px; padding: 1px 5px;
}
.active-chip { color: #4db8a8; border-color: rgba(77,184,168,.4); background: rgba(77,184,168,.08); }
```

---

## Priority 3 — Line Numbers + Blinking Cursor in SQL Editor

**Files:** `docs/html/editor-file-views.html`, `docs/styles/workbench-layout.css`

In `editor-file-views.html`, wrap the existing `<pre class="sql">` block:

```html
<div class="sql-editor-wrap">
  <div class="sql-gutter" aria-hidden="true">
    <span>1</span><span>2</span>...<span>10</span>
  </div>
  <pre class="sql"><code>...existing SQL...</code><span class="editor-cursor" aria-hidden="true"></span></pre>
</div>
```

Count lines in existing SQL and add matching gutter numbers.

CSS in `workbench-layout.css`:

```css
.sql-editor-wrap { display: flex; font-family: "Fira Mono", monospace; position: relative; }
.sql-gutter {
  border-right: 1px solid var(--vsc-border); color: var(--vsc-muted); display: flex;
  flex-direction: column; flex-shrink: 0; font-size: 11px; opacity: .4;
  padding: 10px 6px 10px 8px; text-align: right; user-select: none; width: 36px;
}
.sql-gutter span { line-height: 1.6; }
.editor-cursor {
  animation: editorBlink 1.06s step-end infinite; background: var(--vsc-text);
  display: inline-block; height: 1em; margin-left: 1px; opacity: .8;
  vertical-align: text-bottom; width: 2px;
}
@keyframes editorBlink { 0%,100%{opacity:.8} 50%{opacity:0} }
```

---

## Priority 4 — Three Pre-Opened Tabs + Git Decorations

**Files:** `docs/index.html`, `docs/styles/workbench-layout.css`

### Tabs (index.html line ~267)
Add a third tab (already has `query.pgsql` + `README.md`):
```html
<button class="tab" data-open="doc-notebooks" role="tab" aria-selected="false">
  notebooks.md <span class="tab-close" aria-label="Close tab" tabindex="-1">×</span>
</button>
```

### Git badges on explorer tree rows (index.html sidebar):
```html
<!-- query.pgsql row -->  <span class="git-badge git-mod">M</span>
<!-- README.md row -->    <span class="git-badge git-new">U</span>
```

CSS in `workbench-layout.css`:
```css
.git-badge { flex-shrink:0; font-size:9px; font-weight:700; margin-left:auto; padding-right:4px; }
.git-mod { color: #e2c08d; }
.git-new { color: #73c991; }
body[data-theme="light"] .git-mod { color: #a07030; }
body[data-theme="light"] .git-new { color: #367f45; }
```

---

## Priority 5 — Query: Variable Timing + Sortable Column Headers

**Files:** `docs/js/workbench.js`, `docs/html/editor-file-views.html`, `docs/styles/workbench-layout.css`

In `wireQueryRunAnimation()` in `workbench.js`, replace the hardcoded timing display:
```javascript
const execMs = 38 + Math.floor(Math.random() * 89);
resultMeta.textContent = `✓ 7 rows in ${execMs}ms · ecommerce_demo`;
```

In `editor-file-views.html`, add `data-col` and sort indicator spans to each `<th>`:
```html
<th data-col="0" class="sortable-th">day <span class="sort-ind">↕</span></th>
<th data-col="1" class="sortable-th">revenue <span class="sort-ind">↕</span></th>
<th data-col="2" class="sortable-th">orders <span class="sort-ind">↕</span></th>
```

In `wireQueryRunAnimation()`, after results load, wire sort click handlers (client-side sort by text/number per column).

CSS in `workbench-layout.css`:
```css
.sortable-th { cursor: pointer; user-select: none; }
.sortable-th:hover { background: var(--vsc-highlight); }
.sort-ind { color: var(--vsc-muted); font-size: 9px; margin-left: 3px; opacity: .5; }
.sortable-th:hover .sort-ind { opacity: 1; }
```

---

## Priority 6 — Expanded Database Tree with Column Detail

**File:** `docs/index.html` (NexQL sidebar panel)

Add green connection dot to Local connection row, and expand `orders` table with column-level rows:

```html
<!-- Connection row -->
<span class="conn-dot" aria-label="Connected"></span>Local

<!-- Under demo_db > public > Tables: -->
<div class="tree-row depth-5">⊞ orders <span class="tree-badge">~480K</span></div>
<div class="tree-row depth-6 col-row">🔑 <span class="col-name">id</span> <span class="col-type">bigint</span></div>
<div class="tree-row depth-6 col-row">🔗 <span class="col-name">customer_id</span> <span class="col-type">bigint</span></div>
<div class="tree-row depth-6 col-row"><span class="col-name">created_at</span> <span class="col-type">timestamptz</span> <span class="col-idx">⚡</span></div>
<div class="tree-row depth-6 col-row"><span class="col-name">amount</span> <span class="col-type">numeric(10,2)</span></div>
<div class="tree-row depth-6 col-row"><span class="col-name">status</span> <span class="col-type">text</span></div>
```

CSS in `workbench-layout.css`:
```css
.conn-dot { background:#4db8a8; border-radius:50%; box-shadow:0 0 4px #4db8a8; display:inline-block; height:6px; margin-right:5px; width:6px; }
.depth-5 { padding-left: 56px; }
.depth-6 { padding-left: 68px; }
.col-row { font-family: monospace; font-size: 10.5px; gap: 5px; }
.col-name { color: var(--vsc-text); }
.col-type { color: var(--vsc-muted); font-size: 9.5px; }
.col-idx  { color: var(--vsc-orange); font-size: 9px; }
```

---

## Priority 7 — Status Bar: Problems + LF Indicator

**Files:** `docs/index.html`, `docs/styles/workbench-layout.css`

In `index.html` statusbar, add problems span after `⎇ main` and `LF` after `UTF-8`:

```html
<span>⎇ main</span>
<span id="sb-problems"><span class="sb-err">⊘ 0</span> <span class="sb-warn">⚠ 1</span></span>
...
<span>UTF-8</span>
<span>LF</span>
```

The `⚠ 1` on the query file hints at the missing index (authentic, not alarming).

CSS: `.sb-err { color: rgba(255,120,120,.9); } .sb-warn { color: rgba(255,200,80,.9); }`

---

## Priority 8 — Activity Bar Notification Badge

**Files:** `docs/index.html`, `docs/styles/workbench-layout.css`

On the NexQL activity icon button:
```html
<span class="activity-badge" aria-label="1 notification">1</span>
```

CSS:
```css
.activity-badge {
  background: var(--vsc-orange); border-radius: 999px; color: #fff;
  font-size: 8px; font-weight: 700; min-width: 13px; padding: 2px 3px;
  position: absolute; right: 0; text-align: center; top: 0;
}
```

---

## Priority 9 — Richer Query History in NexQL Sidebar

**File:** `docs/index.html`

Replace the single-item QUERY HISTORY with 4 realistic entries with timestamps:

```html
<button class="tree-row depth-1" data-open="query">
  <span class="history-label">daily_revenue_7d</span>
  <span class="history-time">2m ago</span>
</button>
<button class="tree-row depth-1" data-open="query">
  <span class="history-label">top_customers_30d</span>
  <span class="history-time">18m ago</span>
</button>
<button class="tree-row depth-1" data-open="query">
  <span class="history-label">orders_by_status</span>
  <span class="history-time">1h ago</span>
</button>
<button class="tree-row depth-1" data-open="query">
  <span class="history-label">EXPLAIN orders</span>
  <span class="history-time">3h ago</span>
</button>
```

CSS: `.history-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .history-time { color:var(--vsc-muted); font-size:9.5px; padding-right:4px; }`

---

## Implementation Order & Dependencies

```
1. assistant.js → add streamChatMessage()
2. core-state.js → add schema-intro + slow-query-deep response keys
3. workbench.js → replace preloadAssistantConversation() (depends on 1+2)
4. assistant-panel.html → schema context bar + model label fix
5. interactive.css → schema chip CSS
6. editor-file-views.html → sql-editor-wrap + gutter HTML
7. workbench-layout.css → gutter/cursor + git-badge + sortable-th + conn-dot + col-row CSS
8. index.html → 3rd tab, git badges, expanded DB tree, sb-problems + LF, activity badge, query history
9. workbench.js → wireQueryRunAnimation() timing + sort handlers
```

---

## Critical Files

| File | Change |
|---|---|
| `docs/js/assistant.js` | Add `streamChatMessage()`, replace assistant `appendChatMessage` calls |
| `docs/js/workbench.js` | Replace `preloadAssistantConversation()`, add query timing + sort wiring |
| `docs/js/core-state.js` | Add 2 new ASSISTANT_RESPONSES keys |
| `docs/html/assistant-panel.html` | Schema context bar, model label fix |
| `docs/html/editor-file-views.html` | sql-editor-wrap + line numbers, sortable `<th>` |
| `docs/index.html` | 3rd tab, git badges, DB tree columns, statusbar additions, activity badge, query history |
| `docs/styles/workbench-layout.css` | Line number gutter, cursor blink, git badges, sortable headers, conn dot, col rows, depth-5/6 |
| `docs/styles/interactive.css` | Schema context bar + chip CSS |

---

## Verification

1. Open `docs/index.html` in a browser (local file or dev server)
2. Check: SQL editor shows line numbers + blinking cursor
3. Check: Three tabs open on load; query.pgsql has `M` badge in explorer
4. Check: Assistant loads with 2-turn schema-aware conversation that streams in
5. Check: Schema context bar shows `ecommerce_demo`, `orders`, `customers`, `products`
6. Check: Model label reads "GitHub Models · gpt-4o" (not "No Model")
7. Check: Clicking "Run Query" shows variable ms timing (re-run shows different value)
8. Check: Click a result column header — rows sort ascending/descending
9. Check: NexQL sidebar shows `orders` with 5 column rows and green connection dot
10. Check: Status bar shows `⊘ 0 ⚠ 1` and `LF`
11. Check: Activity badge shows `1` on NexQL icon
12. Check: Query history shows 4 entries with timestamps
13. Repeat steps 2-10 in dark mode (theme toggle)
14. Resize to mobile width — verify minimap hides, layout doesn't break