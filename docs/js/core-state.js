const FILE_STATUS = {
  readme: { file: "Markdown", connection: "● Connected · ecommerce_demo", line: "Ln 1, Col 1" },
  query: { file: "PostgreSQL", connection: "● Connected · ecommerce_demo", line: "Ln 8, Col 1" },
  features: { file: "Markdown", connection: "● Connected · ecommerce_demo", line: "Ln 1, Col 1" },
  connections: { file: "Form", connection: "○ Not connected", line: "New Connection" },
  install: { file: "Markdown", connection: "● nexql.astrx.dev", line: "Ln 1, Col 1" },
  "doc-notebooks": { file: "Markdown", connection: "● Connected · ecommerce_demo", line: "Ln 1, Col 1" },
  "doc-explorer": { file: "Markdown", connection: "● Connected · ecommerce_demo", line: "Ln 1, Col 1" },
  "doc-ai": { file: "Markdown", connection: "● Connected · ecommerce_demo", line: "Ln 1, Col 1" },
  "doc-schema": { file: "Markdown", connection: "● Connected · ecommerce_demo", line: "Ln 1, Col 1" },
  "doc-safety": { file: "Markdown", connection: "● Connected · ecommerce_demo", line: "Ln 1, Col 1" },
  "gif-setup": { file: "GIF", connection: "● demo_db", line: "" },
  "gif-ai-setup": { file: "GIF", connection: "● demo_db", line: "" },
  "gif-explorer": { file: "GIF", connection: "● demo_db", line: "" },
  "gif-ai": { file: "GIF", connection: "● demo_db", line: "" },
  "gif-dashboard": { file: "GIF", connection: "● demo_db", line: "" },
  "gif-db-ops": { file: "GIF", connection: "● demo_db", line: "" },
  "gif-power-editor": { file: "GIF", connection: "● demo_db", line: "" },
  "gif-more-features": { file: "GIF", connection: "● demo_db", line: "" }
};

const BREADCRUMB_LABELS = {
  readme: "README.md",
  query: "query.pgsql",
  features: "features.md",
  connections: "connections.demo",
  install: "INSTALL.md",
  "doc-notebooks": "01_notebooks.md",
  "doc-explorer": "02_explorer.md",
  "doc-ai": "03_ai-assist.md",
  "doc-schema": "04_schema-tools.md",
  "doc-safety": "05_safety.md",
  "gif-setup": "01-setup.gif",
  "gif-ai-setup": "02-more-settings.gif",
  "gif-explorer": "03-ai-assist.gif",
  "gif-ai": "04-ai-copilot.gif",
  "gif-dashboard": "05-dashboard.gif",
  "gif-db-ops": "06-db-ops.gif",
  "gif-power-editor": "07-power-editor.gif",
  "gif-more-features": "08-more-features.gif"
};

const FEATURE_DETAILS = {
  notebooks: "Notebook workflows keep SQL query logic, explanations, and outcomes together so teams can review, version, and replay PostgreSQL analysis in VS Code.",
  explorer: "Explorer navigation keeps PostgreSQL schema context close to your query so you spend less time switching between tools and more time shipping data work.",
  ai: "AI assistance can generate SQL from plain English, explain query intent, suggest safer rewrites, and provide targeted PostgreSQL optimization guidance.",
  safety: "Environment tags, read-only controls, and confirmation prompts reduce accidental execution in sensitive development, staging, and production systems."
};

const PRODUCT_HIGHLIGHT_ORDER = [
  "secure-connections",
  "connection-safety",
  "sql-notebooks",
  "ai-powered",
  "visual-tools",
  "quick-start"
];

const PRODUCT_HIGHLIGHTS = {
  "secure-connections": {
    icon: "🔐",
    title: "Secure Connections",
    user: "Tell me about secure connections.",
    summary: "NexQL keeps connection secrets out of the UI while still making it easy to manage several databases at once.",
    points: [
      "Credentials are stored in VS Code SecretStorage.",
      "Multiple simultaneous connections stay organized.",
      "Passwords do not need to be visible in the editor workflow."
    ],
    tip: "Try it now: install NexQL and connect in under a minute."
  },
  "connection-safety": {
    icon: "🛡️",
    title: "Connection Safety",
    user: "How does NexQL help prevent risky queries?",
    summary: "NexQL adds lightweight guardrails so dangerous SQL is easier to catch before execution.",
    points: [
      "Label environments as DEV, STAGE, or PROD.",
      "Enable read-only mode for safer inspection.",
      "Use the query safety analyzer to flag risky statements."
    ],
    tip: "See it live: install and open any `.pgsql` notebook."
  },
  "sql-notebooks": {
    icon: "📓",
    title: "SQL Notebooks",
    user: "What are SQL notebooks?",
    summary: "SQL notebooks keep analysis, commentary, and results in one place instead of scattering them across tools.",
    points: [
      "Interactive .pgsql cells support inline execution.",
      "Queries and notes stay together for review.",
      "AI assistance can help explain or extend a notebook step."
    ],
    tip: "Get this in your VS Code — install takes 30 seconds."
  },
  "ai-powered": {
    icon: "🤖",
    title: "AI-Powered",
    user: "What can the AI do?",
    summary: "The assistant can turn a plain-English request into SQL help, explanation, or optimization guidance.",
    points: [
      "Generate SQL from a natural-language prompt.",
      "Explain existing queries and result sets.",
      "Optimize slower statements with targeted suggestions.",
      "Works with GitHub Models, OpenAI, Anthropic, Gemini, and VS Code LM."
    ],
    tip: "Try it now: install NexQL and connect in under a minute."
  },
  "visual-tools": {
    icon: "🧩",
    title: "Visual Tools",
    user: "What visual tools are included?",
    summary: "NexQL gives you visual workflows for common schema tasks so you spend less time hand-editing DDL.",
    points: [
      "Visual table designer for schema creation.",
      "Index and constraint management from the UI.",
      "Smart paste and schema visualization workflows.",
      "Useful when comparing or designing database structures."
    ],
    tip: "See it live: install and open any `.pgsql` notebook."
  },
  "quick-start": {
    icon: "🚀",
    title: "Quick Start",
    user: "How do I get started?",
    summary: "The fastest path is simple: install, connect, and open a notebook.",
    points: [
      "Install NexQL from the marketplace.",
      "Add a connection and verify it is online.",
      "Open a .pgsql notebook and start running SQL."
    ],
    tip: "Get this in your VS Code — install takes 30 seconds."
  }
};

// ── Search index ──────────────────────────────────────────
const SEARCH_INDEX = [
  { key: "readme", label: "README.md", path: "NEXQL", text: "overview connect sql notebooks explorer ai assistant schema safety performance pgstudio postgres postgresql vs code extension free open source database management developer tool sql ide database client query editor productivity" },
  { key: "query", label: "query.pgsql", path: "NOTEBOOKS", text: "sql query run execute select orders revenue notebook cell results daily aggregation date_trunc count sum group by where interval explain analyze explain plan query tuning performance optimization index recommendation" },
  { key: "features", label: "features.md", path: "NEXQL", text: "features notebooks explorer ai assistant schema tools visual safety performance 50 capabilities pgadmin dbeaver alternative vs code native postgres client free faq questions postgresql gui sql workflow developer experience" },
  { key: "connections", label: "connections.demo", path: "WORKFLOW", text: "connect database host port username password ssl tls dev stage prod environment connection ssh tunnel rds supabase neon timescale yugabyte aurora cloud sql alloydb azure amazon secure secretstorage connection manager postgres connection setup platform compatibility pg-wire" },
  { key: "compatibility", label: "COMPATIBILITY.md", path: "DOCUMENTATION", text: "platform compatibility neon supabase timescale yugabyte rds aurora cloud sql alloydb azure cockroachdb hosted postgres wire protocol ssl pooler direct endpoint connection guide caveats" },
  { key: "install", label: "INSTALL.md", path: "WORKFLOW", text: "install marketplace extension vscode download get started setup quick start pgsql extension id ric-v postgres-explorer open vsx visual studio code install postgres extension" },
  { key: "doc-notebooks", label: "01_notebooks.md", path: "DOCUMENTATION", text: "notebook pgsql sql cells run execute results export csv json history saved queries markdown notes jupyter git commit share team reproducible interactive data analysis workflow" },
  { key: "doc-explorer", label: "02_explorer.md", path: "DOCUMENTATION", text: "explorer tables views columns indexes constraints right-click generate scripts schema objects functions triggers partitions fdw foreign data wrapper materialized views sequences database browser postgres object explorer" },
  { key: "doc-ai", label: "03_ai-assist.md", path: "DOCUMENTATION", text: "ai assistant openai gpt-4o claude anthropic gemini google github models ask plain english sql explain optimize diagnose index advisor slow query performance vs code lm api copilot text to sql sql assistant" },
  { key: "doc-schema", label: "04_schema-tools.md", path: "DOCUMENTATION", text: "schema visual designer erd entity relationship diagram diff migration import csv json compare alter table create primary key foreign key constraint unique check index ddl generator" },
  { key: "doc-safety", label: "05_safety.md", path: "DOCUMENTATION", text: "safety prod dev stage read-only risk score environment labels ssh tunnel performance explain index advisor delete without where truncate drop confirmation limit 1000 production protection guardrails" }
];

// ── SQL Assistant responses ───────────────────────────────
const ASSISTANT_RESPONSES = {
  "schema-intro": {
    user: "Can you see my schema? I'm working on the orders table.",
    reply: `Yes — I can see <code>ecommerce_demo</code>. You've got an <code>orders</code> table with ~480K rows, <code>created_at</code> indexed... wait, actually it's <em>not</em> indexed. That's your problem right there. 🙃 Full schema: <code>id</code> (bigint PK), <code>customer_id</code> (→ customers), <code>created_at</code> (timestamptz, <strong>unindexed</strong>), <code>amount</code> (numeric 10,2), <code>status</code> (text). What are you trying to run?`
  },
  "slow-query-deep": {
    user: "The daily revenue query is slow — runs in 3s on prod",
    reply: `3 seconds. On 7 days of data. Yep — sequential scan on <code>created_at</code>, ~480K rows, no filtering shortcut. The fix is embarrassingly simple:\n\n<code>CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at DESC);</code>\n\nAfter that: under 80ms. Also stash the daily rollup in a materialized view and your dashboard will feel instantaneous. Want me to write the full view? Install NexQL and I'll generate it against your live schema.`
  },
  "slow-revenue": {
    user: "Why is my daily revenue query slow?",
    reply: "Ah yes, the classic 3-second dashboard query — I call it the 'morning coffee loading screen'. Your <code>orders.created_at</code> is getting a full table scan. One index and a materialized view and you'll wonder why you ever waited.\n\n<code>CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at DESC);</code>\n\nRun that and watch it drop to sub-100ms. Install NexQL and I'll show you the EXPLAIN diff live, before and after. 📈"
  },
  "ask-ai": {
    user: "Analyze this result set and share insights",
    reply: "That's exactly what I'm here for. Give me a slow query, a weird join, or just paste your <code>EXPLAIN ANALYZE</code> output and I'll tell you what the planner is thinking (and why it's wrong).\n\n• Total revenue: <code>$158,487.90</code> across <code>1,149</code> orders\n• Peak day: <code>2026-04-11</code> with <code>$27,905.40</code> from <code>191</code> orders\n• Trend: <code>2026-04-13</code> is ~43% higher than <code>2026-04-07</code> — momentum is up\n\nOnce you install NexQL I'll have live access to your actual schema — no more guessing column types."
  },
  "explain-query": {
    user: "Explain this query",
    reply: "This query computes daily revenue for the last 7 days:\n\n• <code>date_trunc('day', created_at)</code> groups rows by day\n• <code>COUNT(*)</code> returns orders/day\n• <code>SUM(amount)</code> returns revenue/day\n• <code>GROUP BY day ORDER BY day</code> returns chronological aggregates"
  },
  "optimize-query": {
    user: "Optimize this revenue query",
    reply: "Optimization checklist:\n\n• Add index: <code>CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders(created_at DESC);</code>\n• Keep stats fresh: <code>ANALYZE orders;</code>\n• For heavy dashboards, pre-aggregate into a materialized view and refresh on schedule"
  },
  "write-query": {
    user: "Write a query",
    reply: "Describe what you want and I'll write the SQL. For example:\n\n\"Top 10 customers by revenue in the last 30 days\"\n\nI'll use your connected schema (<code>ecommerce_demo</code>) as context. Use <code>@tablename</code> to reference specific tables."
  },
  "optimize": {
    user: "Optimize slow query",
    reply: "Paste your query below or click \"Optimize\" in the notebook cell toolbar. I'll analyze it for:\n\n• Missing indexes\n• Sequential scans on large tables\n• Inefficient JOIN order\n• Subquery vs CTE opportunities\n\nOr open <code>query.pgsql</code> and click the Optimize CodeLens button."
  },
  "explain": {
    user: "Explain a concept",
    reply: "What would you like explained? I can cover:\n\n• <code>WITH</code> — Common Table Expressions\n• <code>ROW_NUMBER()</code>, <code>RANK()</code> — window functions\n• Index types: btree, hash, gin, gist\n• JOIN types and performance implications\n• MVCC and transaction isolation levels"
  },
  "review": {
    user: "Review my schema",
    reply: "For a schema review I'll check:\n\n• Normalisation — redundant columns or groups\n• Missing foreign key constraints\n• Column types (<code>timestamptz</code> vs <code>timestamp</code>)\n• Index coverage for query patterns\n• Partition strategy for large tables\n\nOpen the Explorer, right-click a table → Inspect, and share the DDL."
  }
};

const SNIPPET_RESPONSES = {
  "INNER JOIN ... ON ... = ...": "Here's an INNER JOIN example:\n\n<code>SELECT\n  c.id, c.name,\n  COUNT(o.id) AS orders\nFROM customers c\nINNER JOIN orders o ON c.id = o.customer_id\nGROUP BY c.id, c.name\nORDER BY orders DESC;</code>\n\nINNER JOIN returns only rows that match in both tables. Use LEFT JOIN to include customers with no orders.",
  "WITH cte AS (&#10;  SELECT ...&#10;)&#10;SELECT * FROM cte;": "Common Table Expression example:\n\n<code>WITH monthly_revenue AS (\n  SELECT date_trunc('month', created_at) AS month,\n         SUM(amount) AS revenue\n  FROM orders\n  GROUP BY 1\n)\nSELECT month, revenue,\n       revenue - LAG(revenue) OVER (ORDER BY month) AS delta\nFROM monthly_revenue;</code>\n\nCTEs make complex queries readable and reusable within a single statement.",
  "ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)": "<code>ROW_NUMBER()</code> assigns a sequential number to each row within a partition:\n\n<code>SELECT customer_id, amount,\n  ROW_NUMBER() OVER (\n    PARTITION BY customer_id\n    ORDER BY amount DESC\n  ) AS rank\nFROM orders;</code>\n\nUse this to get \"top N per group\" efficiently.",
  "EXPLAIN ANALYZE": "<code>EXPLAIN ANALYZE</code> runs the query and shows the actual execution plan:\n\n<code>EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)\nSELECT * FROM orders\nWHERE created_at >= NOW() - INTERVAL '7 days';</code>\n\nLook for Seq Scans on large tables — they usually mean a missing index.",
  "ON CONFLICT (id) DO UPDATE SET col = EXCLUDED.col": "Upsert pattern using <code>ON CONFLICT</code>:\n\n<code>INSERT INTO products (id, name, price)\nVALUES ($1, $2, $3)\nON CONFLICT (id) DO UPDATE SET\n  name = EXCLUDED.name,\n  price = EXCLUDED.price,\n  updated_at = NOW();</code>\n\nRequires a unique constraint or index on the conflict column(s).",
  "jsonb_agg(row_to_json(t)) FROM t": "Aggregate rows into a JSON array:\n\n<code>SELECT customer_id,\n  jsonb_agg(\n    jsonb_build_object(\n      'order_id', id,\n      'amount', amount,\n      'date', created_at\n    ) ORDER BY created_at DESC\n  ) AS orders\nFROM orders\nGROUP BY customer_id;</code>\n\nUseful for building nested API responses in a single query."
};

// ── Tour step configuration (4 steps) ────────────────────
const TOUR_STEPS_CONFIG = [
  {
    file: "connections", panel: "pgstudio",
    target: "#file-connections",
    title: "Connect",
    body: "Label environments as DEV, STAGE, or PROD. NexQL makes it obvious which database you're working on — before you run anything. Test & Connect validates credentials first."
  },
  {
    file: "doc-explorer", panel: "pgstudio",
    target: "#sidebar-pgstudio",
    title: "Explore",
    body: "The Database Explorer gives you a live tree of every table, view, function, and index. Right-click anything to generate ready-to-run SQL — SELECT, INSERT, CREATE, ALTER, DROP."
  },
  {
    file: "query", panel: "explorer",
    target: ".cell",
    title: "Query",
    body: "Write SQL in .pgsql notebooks with inline results. Run individual cells, see formatted tables, and get Execution Insights — all without leaving VS Code."
  },
  {
    file: "doc-ai", panel: "explorer",
    target: "#right-panel",
    title: "Ask AI",
    body: "The SQL Assistant understands your connected schema. Ask in plain English, get SQL back with explanations. Works with OpenAI, Claude, Gemini, and GitHub Models."
  }
];

// ── Constants ─────────────────────────────────────────────
const TYPING_INTERVAL_MS = 16;
const RUN_RESULT_DELAY_MS = 900;
const THEME_KEY = "pgstudio-docs-theme";
const CLOSE_REDIRECT_MIN_MS = 1000;
const CLOSE_REDIRECT_MAX_MS = 2000;

// ── Utilities ─────────────────────────────────────────────
function setStatusText(element, text) {
  if (!element) return;
  element.textContent = "";
  let cursor = 0;
  const id = window.setInterval(() => {
    element.textContent = text.slice(0, cursor);
    cursor += 1;
    if (cursor > text.length) window.clearInterval(id);
  }, TYPING_INTERVAL_MS);
}

function getTabLabel(fileName) {
  return BREADCRUMB_LABELS[fileName] || fileName;
}

function createTabElement(fileName) {
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.type = "button";
  tab.dataset.open = fileName;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "false");

  if (fileName === "query") {
    const dot = document.createElement("span");
    dot.className = "tab-dot";
    tab.appendChild(dot);
  }

  tab.appendChild(document.createTextNode(` ${getTabLabel(fileName)} `));

  const close = document.createElement("span");
  close.className = "tab-close";
  close.setAttribute("aria-label", "Close tab");
  close.setAttribute("tabindex", "-1");
  close.textContent = "×";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  tab.appendChild(close);

  tab.addEventListener("click", () => openFile(fileName));
  tab.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(tab);
    }
  });

  return tab;
}

function ensureTabExists(fileName) {
  const tabsContainer = document.querySelector(".tabs");
  if (!tabsContainer) return null;

  let tab = tabsContainer.querySelector(`.tab[data-open="${fileName}"]`);
  if (!tab) {
    tab = createTabElement(fileName);
    tabsContainer.appendChild(tab);
  }

  if (tab.classList.contains("closing")) tab.classList.remove("closing");
  return tab;
}

function closeTab(tab) {
  if (!tab) return;
  const wasActive = tab.classList.contains("active");
  tab.classList.add("closing");
  if (wasActive) {
    const remaining = [...document.querySelectorAll(".tab:not(.closing)")];
    if (remaining.length) openFile(remaining[0].getAttribute("data-open"));
  }

  window.setTimeout(() => {
    tab.remove();
  }, 420);
}

// ── openFile ──────────────────────────────────────────────
