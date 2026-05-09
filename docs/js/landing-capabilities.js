// Landing-page capability modal
// Wires the "Everything PgStudio does for you" cards to a single
// <dialog id="capability-modal"> element and populates it on click.

const CAPABILITY_DETAILS = {
  notebooks: {
    icon: "📓",
    eyebrow: "Workflow",
    title: "SQL Notebooks",
    tagline:
      "Author multi-cell .pgsql notebooks that mix queries, markdown, and inline results. Save them, version them, share them.",
    sections: [
      {
        heading: "Run & iterate",
        items: [
          "<strong>Multi-statement cells</strong> — execute several statements in one cell with streaming NOTICE output.",
          "<strong>Dollar-quote-aware splitter</strong> — safely runs functions, DO blocks, and stored procedures.",
          "<strong>Failure strategies</strong> — stop on first error, continue, or rollback the whole cell.",
          "<strong>Per-cell transactions</strong> — savepoints, manual commit/rollback, auto-rollback on error.",
        ],
      },
      {
        heading: "Inspect results",
        items: [
          "<strong>Inline result tables</strong> with sort, filter, and column resize.",
          "<strong>Charts</strong> — bar, line, pie rendered with Chart.js directly inside the notebook.",
          "<strong>EXPLAIN visualizer</strong> — read query plans without leaving the cell.",
          "<strong>Export</strong> — CSV, JSON, Excel (XLSX) in a single click.",
        ],
      },
      {
        heading: "Stay productive",
        items: [
          "<strong>SQL completions</strong> — schema-aware identifiers, keywords, snippets.",
          "<strong>Saved queries</strong> with tags and a queryable history.",
          "<strong>Markdown cells</strong> for runbooks, postmortems, and shareable analysis.",
          "<strong>Git-friendly</strong> — .pgsql is plain text, diffs cleanly in PRs.",
        ],
      },
      {
        heading: "Status & safety",
        items: [
          "<strong>Status bar</strong> shows connection, database, transaction state, and risk indicator.",
          "<strong>Risk scoring</strong> on destructive statements before you hit run.",
          "<strong>Notebook export</strong> — render the whole notebook to standalone HTML.",
        ],
      },
    ],
    tags: [".pgsql", "Multi-statement", "Charts", "EXPLAIN", "CSV / JSON / Excel"],
  },

  explorer: {
    icon: "🗂️",
    eyebrow: "Navigation",
    title: "Database Explorer",
    tagline:
      "A tree view that mirrors your PostgreSQL instance — connections, databases, schemas, and every object PostgreSQL ships.",
    sections: [
      {
        heading: "Browse everything",
        items: [
          "<strong>Connections → Databases → Schemas → Objects</strong> hierarchy.",
          "<strong>16+ object types</strong> — tables, views, materialized views, indexes, sequences, types, domains, functions, procedures, triggers, partitions, FDWs, extensions, roles, publications, subscriptions.",
          "<strong>DDL viewer</strong> — see the live CREATE statement for any object.",
          "<strong>Background schema poller</strong> auto-refreshes the tree when objects change.",
        ],
      },
      {
        heading: "1-click SQL",
        items: [
          "Right-click → generate <strong>SELECT, INSERT, UPDATE, DELETE</strong> notebooks pre-filled with column lists.",
          "<strong>ALTER and DROP</strong> templates with confirmation prompts.",
          "<strong>Table properties panel</strong> — columns, indexes, constraints, triggers in one view.",
          "<strong>VACUUM / ANALYZE / REINDEX</strong> shortcuts wrapped in safe templates.",
        ],
      },
      {
        heading: "Performance-aware",
        items: [
          "<strong>Adaptive-TTL cache</strong> — 30s / 1m / 5m based on access frequency.",
          "<strong>Connection pooling</strong> keyed by {connection, database}.",
          "<strong>SSH tunneling</strong> with forwarded local ports per connection.",
        ],
      },
      {
        heading: "Connections",
        items: [
          "<strong>Profile manager</strong> — save and switch between connections.",
          "<strong>Encrypted credentials</strong> via VS Code SecretStorage.",
          "<strong>Environment labels</strong> (DEV / STAGE / PROD) attach to every connection.",
        ],
      },
    ],
    tags: ["Tree view", "DDL viewer", "1-click SQL", "SSH tunnel", "SecretStorage"],
  },

  ai: {
    icon: "✨",
    eyebrow: "Assistance",
    title: "AI Assistant",
    tagline:
      "A schema-aware chat panel that writes, explains, and optimizes SQL — using the model and provider you choose.",
    sections: [
      {
        heading: "Bring your own model",
        items: [
          "<strong>OpenAI</strong> — GPT-4o, GPT-4o mini, GPT-4 Turbo.",
          "<strong>Anthropic</strong> — Claude 3.5 Sonnet, Haiku, Opus.",
          "<strong>Google</strong> — Gemini 1.5 Pro, Flash.",
          "<strong>GitHub Models</strong> — free tier, no API key required.",
          "<strong>Local / custom</strong> — point at any OpenAI-compatible endpoint.",
        ],
      },
      {
        heading: "Schema-aware prompts",
        items: [
          "Auto-injects <strong>relevant table and column metadata</strong> based on your question.",
          "Understands the <strong>active connection and database</strong> for accurate suggestions.",
          "<strong>Streaming responses</strong> with copy-to-cell action.",
        ],
      },
      {
        heading: "What you can ask",
        items: [
          "<strong>Generate</strong> — &ldquo;top 10 customers by revenue last quarter&rdquo;.",
          "<strong>Explain</strong> — paste a query and get a plain-English breakdown.",
          "<strong>Diagnose</strong> — paste an error and get a likely cause + fix.",
          "<strong>Optimize</strong> — suggest indexes and rewrite slow queries.",
        ],
      },
      {
        heading: "Privacy & control",
        items: [
          "API keys stored in <strong>VS Code SecretStorage</strong> — never logged.",
          "<strong>Model and provider per workspace</strong> — pick a different model per project.",
          "<strong>Conversation history</strong> is local; clear it any time.",
        ],
      },
    ],
    tags: ["GPT-4o", "Claude", "Gemini", "GitHub Models", "Schema context", "Streaming"],
  },

  schema: {
    icon: "🎨",
    eyebrow: "Modeling",
    title: "Visual Schema Tools",
    tagline:
      "Design tables, diff schemas, and import data without leaving VS Code — with safe DDL output you can review before applying.",
    sections: [
      {
        heading: "Visual table designer",
        items: [
          "<strong>Add / rename / drop columns</strong> with type, nullability, default, and constraints.",
          "<strong>Foreign keys</strong> with referential actions and deferrable options.",
          "<strong>DDL preview</strong> — see the exact CREATE / ALTER before you run it.",
          "Generates <strong>up + down migrations</strong> as paired files.",
        ],
      },
      {
        heading: "ERD diagrams",
        items: [
          "<strong>Auto-generated</strong> from any schema — pan, zoom, export.",
          "Shows <strong>FK relationships</strong>, cardinality, and column types.",
          "Click a table in the diagram to <strong>open its properties panel</strong>.",
        ],
      },
      {
        heading: "Schema diff",
        items: [
          "<strong>Compare two schemas / databases</strong> side by side.",
          "Generates a <strong>migration script</strong> to bring source ↔ target into sync.",
          "Highlights <strong>destructive changes</strong> (drops, type narrowing) with explicit warnings.",
        ],
      },
      {
        heading: "Data import",
        items: [
          "<strong>CSV / JSON import</strong> with guided column mapping.",
          "<strong>Type inference</strong> with overrides per column.",
          "<strong>Migration framework detection</strong> — Flyway, Alembic, golang-migrate, Prisma — and it writes files in their convention.",
        ],
      },
    ],
    tags: ["DDL preview", "ERD", "Schema diff", "CSV / JSON import", "Migration files"],
  },

  safety: {
    icon: "🛡️",
    eyebrow: "Production",
    title: "Safety Controls",
    tagline:
      "Built for engineers who run queries against real databases. Every dangerous action has a guardrail you can configure.",
    sections: [
      {
        heading: "Environment awareness",
        items: [
          "<strong>DEV / STAGE / PROD</strong> labels per connection, color-coded everywhere.",
          "<strong>Status bar indicator</strong> shows the current environment at all times.",
          "<strong>Read-only mode</strong> per connection — blocks writes at the executor level.",
        ],
      },
      {
        heading: "Risk scoring",
        items: [
          "<strong>Static analysis</strong> on every cell before run — DROP, TRUNCATE, DELETE/UPDATE without WHERE.",
          "<strong>Confirmation prompt</strong> on high-risk statements (configurable threshold).",
          "<strong>Risk indicator</strong> in the status bar for the current cell.",
        ],
      },
      {
        heading: "Transaction safety",
        items: [
          "<strong>Per-session transaction state</strong> tracked in the kernel.",
          "<strong>Savepoints</strong> with named restore points across cells.",
          "<strong>Auto-rollback</strong> on error — never leave a session in a broken state.",
        ],
      },
      {
        heading: "Credentials & access",
        items: [
          "<strong>VS Code SecretStorage</strong> — passwords are encrypted at rest, never in JSON.",
          "<strong>SSH tunnels</strong> for jump-host access without exposing ports.",
          "<strong>Schema poller</strong> respects connection scope — no cross-database leaks.",
        ],
      },
    ],
    tags: ["DEV / STAGE / PROD", "Read-only", "Risk scoring", "Savepoints", "SecretStorage", "SSH"],
  },

  performance: {
    icon: "📊",
    eyebrow: "Optimization",
    title: "Performance Insights",
    tagline:
      "Find slow queries, understand why they&rsquo;re slow, and get specific guidance on how to fix them.",
    sections: [
      {
        heading: "EXPLAIN visualizer",
        items: [
          "<strong>EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)</strong> parsed and rendered as a node tree.",
          "<strong>Hot path highlighting</strong> — biggest cost contributors flagged.",
          "<strong>Per-node detail</strong> — rows, time, buffers, loops, planning vs execution time.",
        ],
      },
      {
        heading: "Index advisor",
        items: [
          "Detects <strong>sequential scans</strong> on large tables and suggests index candidates.",
          "Recommends <strong>composite indexes</strong> based on WHERE / JOIN / ORDER BY clauses.",
          "Generates <strong>CREATE INDEX</strong> with CONCURRENTLY when safe.",
        ],
      },
      {
        heading: "Performance baselines",
        items: [
          "<strong>Welford&rsquo;s online variance</strong> tracks rolling mean and stddev per query.",
          "<strong>Degradation alerts</strong> when a query&rsquo;s p95 drifts beyond baseline.",
          "<strong>Query analyzer</strong> stores a local history you can sort by slowest, most frequent, or recently regressed.",
        ],
      },
      {
        heading: "Live dashboard",
        items: [
          "<strong>Active sessions</strong>, locks, and longest-running queries in real time.",
          "<strong>Cache hit ratios</strong>, dead tuple bloat, and table size trends.",
          "<strong>Replication lag</strong> and WAL position when relevant.",
        ],
      },
    ],
    tags: ["EXPLAIN ANALYZE", "Index advisor", "Baselines", "Welford variance", "Live dashboard"],
  },
};

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex='-1'])";

let activeTrigger = null;

function buildBody(detail) {
  return detail.sections
    .map((section) => {
      const items = section.items.map((item) => `<li>${item}</li>`).join("");
      return `
        <section class="capability-section">
          <h4 class="capability-section-heading">${section.heading}</h4>
          <ul>${items}</ul>
        </section>`;
    })
    .join("");
}

function buildTags(detail) {
  return (detail.tags || [])
    .map((tag) => `<span class="feature-tag">${tag}</span>`)
    .join("");
}

function populateModal(modal, detail) {
  modal.querySelector("[data-cap-icon]").textContent = detail.icon;
  modal.querySelector("[data-cap-eyebrow]").textContent = detail.eyebrow;
  modal.querySelector("[data-cap-title]").textContent = detail.title;
  modal.querySelector("[data-cap-tagline]").innerHTML = detail.tagline;
  modal.querySelector("[data-cap-body]").innerHTML = buildBody(detail);
  modal.querySelector("[data-cap-tags]").innerHTML = buildTags(detail);
}

function openModal(modal, detail, trigger) {
  populateModal(modal, detail);
  activeTrigger = trigger || null;

  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
    modal.classList.add("capability-modal-fallback-open");
  }

  // Focus the close button so ESC and Tab behave predictably.
  const closeBtn = modal.querySelector("[data-cap-close]");
  if (closeBtn) closeBtn.focus({ preventScroll: true });
}

function closeModal(modal) {
  if (typeof modal.close === "function" && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute("open");
    modal.classList.remove("capability-modal-fallback-open");
  }

  if (activeTrigger && typeof activeTrigger.focus === "function") {
    activeTrigger.focus({ preventScroll: true });
  }
  activeTrigger = null;
}

function wireCapabilityModal() {
  const modal = document.getElementById("capability-modal");
  const cards = document.querySelectorAll(".feature-card[data-cap]");
  if (!modal || !cards.length) return;

  cards.forEach((card) => {
    card.addEventListener("click", () => {
      const key = card.getAttribute("data-cap");
      const detail = CAPABILITY_DETAILS[key];
      if (!detail) return;
      openModal(modal, detail, card);
    });
  });

  const closeBtn = modal.querySelector("[data-cap-close]");
  closeBtn?.addEventListener("click", () => closeModal(modal));

  // Click outside the inner card (on the dialog backdrop) closes the modal.
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal(modal);
  });

  // <dialog> emits 'cancel' on ESC; restore focus to the trigger.
  modal.addEventListener("cancel", () => {
    if (activeTrigger && typeof activeTrigger.focus === "function") {
      activeTrigger.focus({ preventScroll: true });
    }
    activeTrigger = null;
  });

  // Trap focus inside the dialog for browsers without native <dialog> support.
  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusable = modal.querySelectorAll(FOCUSABLE_SELECTOR);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}
