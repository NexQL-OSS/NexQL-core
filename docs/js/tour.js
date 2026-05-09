// ── Narrated Tour ─────────────────────────────────────────
let currentTourStep = 0;
let pendingTourStartTimer = null;

function openEditorViewForTour() {
  const wasMinimized = document.body.classList.contains("editor-minimized");
  if (wasMinimized && typeof setEditorMinimizedState === "function") {
    setEditorMinimizedState(false);
  }
  return wasMinimized;
}

function getElementRect(selector) {
  const el = selector ? document.querySelector(selector) : null;
  return el ? el.getBoundingClientRect() : null;
}

function positionTourTooltip(tooltipEl, spotlightEl, rect) {
  if (!rect) return;
  const GAP = 14, TW = 280;

  // Spotlight
  spotlightEl.style.top = `${rect.top - 4}px`;
  spotlightEl.style.left = `${rect.left - 4}px`;
  spotlightEl.style.width = `${rect.width + 8}px`;
  spotlightEl.style.height = `${rect.height + 8}px`;

  // Tooltip — prefer right of target, fall back to left
  let top = Math.max(8, rect.top);
  let left = rect.right + GAP;
  if (left + TW > window.innerWidth - 16) left = rect.left - TW - GAP;
  left = Math.max(8, left);
  if (top + tooltipEl.offsetHeight > window.innerHeight - 16) top = Math.max(8, window.innerHeight - tooltipEl.offsetHeight - 16);

  tooltipEl.style.top = `${top}px`;
  tooltipEl.style.left = `${left}px`;
}

function renderTourStep(index) {
  const step = TOUR_STEPS_CONFIG[index];
  if (!step) return;

  if (step.file) openFile(step.file);
  if (step.panel) switchSidebarPanel(step.panel);

  document.getElementById("tt-step").textContent = `Step ${index + 1} of ${TOUR_STEPS_CONFIG.length}`;
  document.getElementById("tt-title").textContent = step.title;
  document.getElementById("tt-body").textContent = step.body;
  document.getElementById("tour-counter").textContent = `${index + 1} / ${TOUR_STEPS_CONFIG.length}`;

  document.querySelectorAll(".tour-dot").forEach((d, i) => d.classList.toggle("active", i === index));

  const prevBtn = document.getElementById("tour-prev");
  const nextBtn = document.getElementById("tour-next");
  if (prevBtn) prevBtn.style.display = index === 0 ? "none" : "";
  if (nextBtn) nextBtn.textContent = index === TOUR_STEPS_CONFIG.length - 1 ? "Finish ✓" : "Next →";

  const tooltip = document.getElementById("tour-tooltip");
  const spotlight = document.getElementById("tour-spotlight");
  tooltip?.classList.remove("visible");

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const rect = getElementRect(step.target);
      if (tooltip && spotlight) positionTourTooltip(tooltip, spotlight, rect);
      tooltip?.classList.add("visible");
    });
  });
}

function startTour() {
  currentTourStep = 0;
  document.getElementById("tour-overlay")?.classList.add("active");
  document.getElementById("tour-overlay")?.setAttribute("aria-hidden", "false");
  document.querySelector(".titlebar")?.classList.add("tour-active");
  const playTourBtn = document.getElementById("play-tour");
  if (playTourBtn) {
    playTourBtn.setAttribute("data-tooltip", "Stop product tour");
    playTourBtn.setAttribute("aria-label", "Stop guided product tour");
    playTourBtn.setAttribute("title", "Stop guided product tour");
    playTourBtn.classList.add("tour-running");
  }
  renderTourStep(0);
}

function stopTour() {
  if (pendingTourStartTimer !== null) {
    window.clearTimeout(pendingTourStartTimer);
    pendingTourStartTimer = null;
  }

  document.getElementById("tour-overlay")?.classList.remove("active");
  document.getElementById("tour-overlay")?.setAttribute("aria-hidden", "true");
  document.getElementById("tour-tooltip")?.classList.remove("visible");
  document.querySelector(".titlebar")?.classList.remove("tour-active");
  const playTourBtn = document.getElementById("play-tour");
  if (playTourBtn) {
    playTourBtn.setAttribute("data-tooltip", "Play product tour");
    playTourBtn.setAttribute("aria-label", "Start guided product tour");
    playTourBtn.setAttribute("title", "Start guided product tour");
    playTourBtn.classList.remove("tour-running");
  }
}

function wireTour() {
  document.getElementById("play-tour")?.addEventListener("click", () => {
    const overlayActive = document.getElementById("tour-overlay")?.classList.contains("active");
    if (overlayActive || pendingTourStartTimer !== null) {
      stopTour();
      return;
    }

    const wasMinimized = openEditorViewForTour();
    const beginTour = () => {
      pendingTourStartTimer = null;
      startTour();
    };

    if (wasMinimized) {
      // Wait for the editor restore transition so the first spotlight anchors correctly.
      pendingTourStartTimer = window.setTimeout(beginTour, 520);
    } else {
      window.requestAnimationFrame(beginTour);
    }
  });

  document.getElementById("tour-next")?.addEventListener("click", () => {
    if (currentTourStep >= TOUR_STEPS_CONFIG.length - 1) { stopTour(); return; }
    currentTourStep += 1;
    renderTourStep(currentTourStep);
  });

  document.getElementById("tour-prev")?.addEventListener("click", () => {
    if (currentTourStep <= 0) return;
    currentTourStep -= 1;
    renderTourStep(currentTourStep);
  });

  // Click backdrop to close
  document.getElementById("tour-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("tour-overlay")) stopTour();
  });

  // Keyboard navigation
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("tour-overlay")?.classList.contains("active")) return;
    if (e.key === "ArrowRight" || e.key === "Enter") document.getElementById("tour-next")?.click();
    else if (e.key === "ArrowLeft") document.getElementById("tour-prev")?.click();
    else if (e.key === "Escape") stopTour();
  });
}

function buildFreeFormTeaser(text) {
  const lower = text.toLowerCase();

  if (lower.includes("slow") || lower.includes("performance") || lower.includes("latency")) {
    return [
      "Slow query — let's diagnose it properly.",
      "• First move: `EXPLAIN (ANALYZE, BUFFERS) <your query>` — look for 'Seq Scan' on a large table. That's your culprit.",
      "• Fix is usually one line: `CREATE INDEX CONCURRENTLY idx_col ON table (col DESC);` — drops 3s queries to sub-100ms. Install PgStudio and I'll write the exact statement against your live schema."
    ];
  }

  if (lower.includes("schema") || lower.includes("design") || lower.includes("normal")) {
    return [
      "Schema question — I have opinions. Here's where I'd start:",
      "• First thing I'd check: missing FK constraints, `timestamp` vs `timestamptz` mismatches, and any `text` column that should be an enum.",
      "• Connect me and I'll run a full schema audit — missing indexes, type issues, denormalization — in about 30 seconds."
    ];
  }

  if (lower.includes("error") || lower.includes("fail") || lower.includes("crash") || lower.includes("broken")) {
    return [
      "That sounds painful. Here's the diagnostic checklist:",
      "• Paste the full error — especially the DETAIL and HINT lines. Those tell the real story, not the headline.",
      "• Install PgStudio — I can read `pg_stat_activity` and logs directly, not just the vibe you're describing. 🫠"
    ];
  }

  if (lower.includes("index") || lower.includes("btree") || lower.includes("gin") || lower.includes("gist")) {
    return [
      "Index question — the answer depends on your access pattern:",
      "• Template: `CREATE INDEX CONCURRENTLY idx_name ON table (column DESC);` — concurrent so it doesn't lock writes.",
      "• For text search use GIN, for ranges use BRIN, for everything else start with btree. Connect me and I'll pick the right one for your query. 🧊"
    ];
  }

  if (lower.includes("join") || lower.includes("left join") || lower.includes("inner join")) {
    return [
      "JOIN performance is almost always about indexes and cardinality:",
      "• Check: are both join columns indexed? A missing index on the FK side turns an O(log n) lookup into a full scan.",
      "• `EXPLAIN ANALYZE` will show nested loops vs hash joins — I'll tell you which one is costing you. Need your row counts to say more."
    ];
  }

  if (lower.includes("write") || lower.includes("generate") || lower.includes("create query") || lower.includes("sql")) {
    return [
      "Happy to write that — here's the honest caveat:",
      "• I'd write it right now, but I'd be inventing column names and guessing types. That's how you get queries that don't run. 😅",
      "• Connect me to your DB and I'll generate SQL that actually executes against your real schema, first try."
    ];
  }

  if (lower.includes("backup") || lower.includes("restore") || lower.includes("migrate")) {
    return [
      "Migration work — let's do this without drama:",
      "• `pg_dump -Fc dbname | pg_restore -d newdb` is the starting point, but you need to think about sequences, extensions, and search_path.",
      "• Install PgStudio — migration tooling is built in and I promise it's less scary than the docs."
    ];
  }

  if (lower.includes("permission") || lower.includes("role") || lower.includes("grant") || lower.includes("access")) {
    return [
      "Postgres permissions — here's the lay of the land:",
      "• `GRANT SELECT ON ALL TABLES IN SCHEMA public TO role;` covers most read-only use cases. Add `ALTER DEFAULT PRIVILEGES` so new tables inherit it.",
      "• I could give you a generic statement... or I could inspect your actual roles. Connect me and we skip the guesswork. 🔐"
    ];
  }

  if (lower.includes("deadlock") || lower.includes("lock") || lower.includes("blocked") || lower.includes("waiting")) {
    return [
      "Deadlock — act fast. Here's how to triage:",
      "• Check `pg_stat_activity` filtered to `wait_event_type = 'Lock'` — that shows you what's blocked and who's blocking.",
      "• Connect me immediately — deadlocks don't get better with time and I know exactly where to look. ⏳"
    ];
  }

  const DEFAULT_TEASERS = [
    [
      "Honest answer: I need your schema to say anything useful.",
      "• I have a hunch, but hunches without schema context age poorly.",
      "• Install PgStudio — I'll give you the real answer in about 30 seconds. ⚡"
    ],
    [
      "That's a real question — it deserves a real answer, not a generic one. 🎯",
      "• The answer depends entirely on your table sizes, indexes, and query patterns.",
      "• Connect your DB and I'll stop guessing and start actually helping."
    ],
    [
      "I *could* make something up — but you seem like you'd notice. 🤓",
      "• Without your schema I'd just be inventing facts about your database.",
      "• Install PgStudio — real schema, real answer, no vibes-based SQL."
    ],
    [
      "My crystal ball says: it depends on your data. Shocking, I know. 🔮",
      "• Every database is different — row counts, indexes, and pg version all change the answer.",
      "• Give me actual access and I'll trade the crystal ball for an EXPLAIN plan."
    ],
    [
      "Strong gut feeling here. Weak evidence though. Classic demo AI problem. 😅",
      "• I can see patterns — but not *your* patterns without a live connection.",
      "• Install PgStudio and I'll back my gut with your actual query stats."
    ],
    [
      "I've seen this question before. I've never answered it correctly without the schema. 📊",
      "• Context is everything — table sizes, null rates, index coverage.",
      "• Connect me once. Get a real answer. It's embarrassingly easy to set up."
    ],
    [
      "The answer exists in your database. I just can't see it from here. 👀",
      "• It's probably in `pg_stat_*` or the query plan — both need a live connection.",
      "• Install PgStudio — I'll find it before you finish your coffee. ☕"
    ],
    [
      "The honest answer involves your table sizes. I don't have those. You do. 📏",
      "• Row counts, null rates, index cardinality — these all change what I'd recommend.",
      "• Connect PgStudio and we'll stop theorizing and start optimizing."
    ],
    [
      "I refuse to give you a generic non-answer. You deserve better than that. 🙅",
      "• Generic advice for Postgres questions is almost always wrong or incomplete.",
      "• Install PgStudio and ask me this again with a live connection. Night and day difference."
    ],
    [
      "If I had a dollar for every time I've guessed wrong without schema context... 💸",
      "• I'd have a lot of dollars. The schema changes everything.",
      "• Install PgStudio. Let's not add to the pile."
    ],
    [
      "I won't pretend I can help without your data. That's just helpfulness theatre. 🎭",
      "• Real tool. Real answers. The install takes about 2 minutes.",
      "• Connect me once and you'll wonder why you ever asked a demo AI."
    ],
  ];

  return DEFAULT_TEASERS[Math.floor(Math.random() * DEFAULT_TEASERS.length)];
}

