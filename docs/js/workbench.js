/** Keeps `.shell` / `#minimized-overview` aria-hidden in sync with `body.editor-minimized`. */
function setEditorMinimizedState(minimized) {
  const shell = document.querySelector(".shell");
  const minimizedOverview = document.getElementById("minimized-overview");
  document.body.classList.toggle("editor-minimized", minimized);
  if (shell) {
    shell.setAttribute("aria-hidden", minimized ? "true" : "false");
    if (!minimized) {
      shell.classList.add("shell-opening");
      shell.addEventListener(
        "animationend",
        () => shell.classList.remove("shell-opening"),
        { once: true }
      );
    }
  }
  if (minimizedOverview) {
    minimizedOverview.setAttribute("aria-hidden", minimized ? "false" : "true");
  }
}

function openFile(fileName) {
  ensureTabExists(fileName);

  document.querySelectorAll(".file-view").forEach((v) => v.classList.remove("visible"));
  document.querySelectorAll(".tab").forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
  document.querySelectorAll(".tree-row").forEach((r) => r.classList.remove("active"));

  const view = document.getElementById(`file-${fileName}`);
  if (view) view.classList.add("visible");

  const tab = document.querySelector(`.tab[data-open="${fileName}"]`);
  if (tab) { tab.classList.add("active"); tab.setAttribute("aria-selected", "true"); }

  document.querySelectorAll(`.tree-row[data-open="${fileName}"]`).forEach((r) => r.classList.add("active"));

  // Breadcrumb
  const bc = document.getElementById("breadcrumb-file");
  if (bc && BREADCRUMB_LABELS[fileName]) bc.textContent = BREADCRUMB_LABELS[fileName];

  // Statusbar
  const status = FILE_STATUS[fileName];
  if (status) {
    setStatusText(document.getElementById("sb-file"), status.file);
    setStatusText(document.getElementById("sb-connection"), status.connection);
    setStatusText(document.getElementById("sb-line"), status.line);
  }
}

// ── Sidebar panel switching ───────────────────────────────
function switchSidebarPanel(panelId) {
  ["explorer", "search", "pgstudio"].forEach((id) => {
    document.getElementById(`sidebar-${id}`)?.classList.toggle("active", id === panelId);
  });
  document.querySelectorAll(".activity-icon[data-panel]").forEach((icon) => {
    icon.classList.toggle("active", icon.getAttribute("data-panel") === panelId);
  });
}

// ── Activity bar ──────────────────────────────────────────
function wireActivityBar() {
  document.querySelectorAll(".activity-icon[data-panel]").forEach((icon) => {
    icon.addEventListener("click", () => {
      const panel = icon.getAttribute("data-panel");
      switchSidebarPanel(panel);
      const fileToOpen = icon.getAttribute("data-open");
      if (fileToOpen) openFile(fileToOpen);
      if (panel === "search") window.setTimeout(() => document.getElementById("doc-search-input")?.focus(), 50);
    });
  });
}

// ── Window controls (mac-style traffic lights) ───────────
function wireWindowControls() {
  const closeDot = document.querySelector(".window-controls .dot.red");
  const minimizeDot = document.querySelector(".window-controls .dot.yellow");
  const maximizeDot = document.querySelector(".window-controls .dot.green");
  const shell = document.querySelector(".shell");
  const minimizedOverview = document.getElementById("minimized-overview");
  const restoreShortcut = document.getElementById("open-editor-shortcut");
  const terminalButtons = document.querySelectorAll(".mini-editor-preview button");
  if (!closeDot || !shell) return;

  closeDot.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation()
    setEditorMinimizedState(true);

    // shell.classList.add("closing");
    // const delayMs = CLOSE_REDIRECT_MIN_MS + Math.random() * (CLOSE_REDIRECT_MAX_MS - CLOSE_REDIRECT_MIN_MS);
    // window.setTimeout(() => {
    //   window.location.href = "https://astrx.dev/";
    // }, delayMs);
  });

  minimizeDot?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorMinimizedState(true);
  });

  maximizeDot?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorMinimizedState(true);
  });

  restoreShortcut?.addEventListener("click", () => {
    setEditorMinimizedState(false);
  });

  terminalButtons.forEach((button) => {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setEditorMinimizedState(false);
      openFile("query");
      switchSidebarPanel("pgstudio");
    });
  });

  minimizedOverview?.querySelector(".mini-editor-preview")?.addEventListener("click", (e) => {
    const el = e.target;
    if (el instanceof Element && el.closest("button")) return;
    setEditorMinimizedState(false);
    openFile("query");
    switchSidebarPanel("pgstudio");
  });
}

// ── Tab close (+ middle-click) ────────────────────────────
function wireTabClose() {
  document.querySelectorAll(".tab-close").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(btn.closest(".tab")); });
  });
  document.querySelectorAll(".tab").forEach((tab) => {
    const middleClose = (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      closeTab(tab);
    };
    // mousedown catches wheel-click before the browser starts autoscroll (auxclick often never fires).
    tab.addEventListener("mousedown", middleClose, true);
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab);
      }
    });
  });
}

// ── Navigation ────────────────────────────────────────────
function wireNavigation() {
  document.querySelectorAll("[data-open]").forEach((target) => {
    target.addEventListener("click", () => {
      const f = target.getAttribute("data-open");
      if (f) openFile(f);
    });
  });
}

// ── Theme (dark-only) ─────────────────────────────────────
function applyTheme(_theme) {
  if (!document.body) return;
  // Always dark — any stored or passed theme value is ignored
  document.body.setAttribute("data-theme", "dark");
  const statusTheme = document.getElementById("sb-theme");
  if (statusTheme) statusTheme.textContent = "Theme: Dark";
  // Re-render chart with dark tokens unconditionally
  if (typeof Chart !== "undefined") {
    const canvas = document.getElementById("revenue-chart");
    if (canvas && Chart.getChart(canvas)) {
      Chart.getChart(canvas).destroy();
    }
    window.setTimeout(renderRevenueChart, 40);
  }
}

function wireThemeToggle() {
  applyTheme("dark");
  // Toggle button is hidden via CSS; listener kept for safety but writes nothing
  document.getElementById("theme-toggle")?.addEventListener("click", () => applyTheme("dark"));
}

// ── Search ────────────────────────────────────────────────
function wireSearch() {
  const input = document.getElementById("doc-search-input");
  const list = document.getElementById("search-results-list");
  if (!input || !list) return;

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = "";
    if (!q) { list.innerHTML = '<p class="search-empty">Type to search documentation, features, and workflows.</p>'; return; }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const results = SEARCH_INDEX.filter((item) => item.label.toLowerCase().includes(q) || item.text.includes(q));

    if (!results.length) { list.innerHTML = `<p class="search-empty">No results for "<strong>${q}</strong>".</p>`; return; }

    results.forEach((item) => {
      const btn = document.createElement("button");
      btn.className = "search-result-item";
      btn.innerHTML = `
        <span class="search-result-name">${item.label.replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>")}</span>
        <span class="search-result-path">${item.path}</span>`;
      btn.addEventListener("click", () => { openFile(item.key); switchSidebarPanel("explorer"); });
      list.appendChild(btn);
    });
  });
}

// ── Query run animation ───────────────────────────────────
function wireQueryRunAnimation() {
  const runButton = document.getElementById("run-query-btn");
  const resultContainer = document.getElementById("query-result");
  const resultBody = document.getElementById("result-body");
  const resultMeta = resultContainer?.querySelector(".result-meta");
  const insightText = document.getElementById("insight-text");
  const outputStack = document.getElementById("query-output-stack");
  if (!runButton || !resultContainer || !resultBody || !resultMeta || !insightText) return;

  runButton.addEventListener("click", () => {
    const hintEl = document.getElementById("query-output-hint");
    const awaitingFirstRun = outputStack?.classList.contains("query-output-stack--pending");
    if (awaitingFirstRun && hintEl) {
      hintEl.textContent = "Executing query…";
    } else {
      resultMeta.textContent = "Executing query…";
    }

    resultContainer.classList.add("running");
    insightText.textContent = "Analyzing scan strategy and aggregations…";
    runButton.disabled = true;

    window.setTimeout(() => {
      outputStack?.classList.remove("query-output-stack--pending");
      const dataRows = [
        ["2026-04-07", 142, "18,420.00"], ["2026-04-08", 158, "21,340.50"], ["2026-04-09", 131, "17,890.00"],
        ["2026-04-10", 177, "24,110.25"], ["2026-04-11", 191, "27,905.40"], ["2026-04-12", 168, "22,490.00"],
        ["2026-04-13", 182, "26,331.75"]
      ];
      resultBody.innerHTML = dataRows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join("");
      resultBody.querySelectorAll("tr").forEach((row, i) => {
        row.style.cssText = "opacity:0;transform:translateY(4px);transition:opacity 180ms ease,transform 180ms ease";
        window.setTimeout(() => { row.style.opacity = "1"; row.style.transform = "translateY(0)"; }, i * 45);
      });
      resultContainer.classList.remove("running");
      const execMs = 38 + Math.floor(Math.random() * 89);
      resultMeta.textContent = `✓ 7 rows in ${execMs}ms · ecommerce_demo`;
      insightText.textContent = "Suggestion: add an index on orders(created_at) and keep daily aggregation in a materialized view for dashboard latency under 100ms.";
      runButton.disabled = false;
      window.setTimeout(() => {
        if (typeof renderRevenueChart === "function") renderRevenueChart();
      }, 100);
    }, RUN_RESULT_DELAY_MS);
  });

  // Wire sortable column headers once (thead persists across runs)
  const table = resultContainer.querySelector("table");
  if (table) {
    table.querySelectorAll("th.sortable-th").forEach((th) => {
      th.addEventListener("click", () => {
        const col = parseInt(th.getAttribute("data-col"), 10);
        const tbody = table.querySelector("tbody");
        if (!tbody) return;
        const rows = [...tbody.querySelectorAll("tr")];
        const asc = th.getAttribute("data-sort") !== "asc";
        table.querySelectorAll("th.sortable-th").forEach((h) => {
          h.setAttribute("data-sort", "");
          const ind = h.querySelector(".sort-ind");
          if (ind) ind.textContent = "↕";
        });
        th.setAttribute("data-sort", asc ? "asc" : "desc");
        const ind = th.querySelector(".sort-ind");
        if (ind) ind.textContent = asc ? "↑" : "↓";
        rows.sort((a, b) => {
          const av = a.cells[col]?.textContent.replace(/,/g, "") ?? "";
          const bv = b.cells[col]?.textContent.replace(/,/g, "") ?? "";
          const an = parseFloat(av), bn = parseFloat(bv);
          const cmp = isNaN(an) || isNaN(bn) ? av.localeCompare(bv) : an - bn;
          return asc ? cmp : -cmp;
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  }
}

function wireQueryToolbarActions() {
  document.querySelectorAll(".cell-lens [data-query-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-query-action");
      if (!action) return;
      sendAssistantPreset(action);
    });
  });
}

// ── Feature cards ─────────────────────────────────────────
function wireFeatureCards() {
  const detail = document.getElementById("feature-detail");
  if (!detail) return;
  document.querySelectorAll(".feature-card[data-feature]").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".feature-card[data-feature]").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      const key = card.getAttribute("data-feature");
      if (key && FEATURE_DETAILS[key]) detail.textContent = FEATURE_DETAILS[key];
    });
  });
}

// ── Connection simulation ─────────────────────────────────
function wireConnectionSimulation() {
  const connectButton = document.querySelector(".connect-preview");
  const connectionLog = document.getElementById("connection-log");
  const connectionLabel = document.getElementById("sb-connection");
  const engineLabel = document.getElementById("sb-engine");
  if (!connectButton || !connectionLog || !connectionLabel || !engineLabel) return;

  connectButton.addEventListener("click", () => {
    connectButton.setAttribute("disabled", "true");
    connectionLog.innerHTML = "";
    const steps = ["Resolving localhost:5432…", "TLS mode set to prefer.", "Authentication succeeded for postgres.", "Connection healthy. Notebook execution enabled."];
    steps.forEach((step, i) => {
      window.setTimeout(() => {
        const line = document.createElement("li");
        line.textContent = step;
        connectionLog.appendChild(line);
      }, i * 380);
    });
    window.setTimeout(() => {
      setStatusText(connectionLabel, "● Connected · ecommerce_demo");
      setStatusText(engineLabel, "PostgreSQL 16");
      connectButton.removeAttribute("disabled");
      openFile("query");
    }, steps.length * 380 + 80);
  });
}

// ── Startup toast ─────────────────────────────────────────
function showStartupToast() {
  const toast = document.getElementById("startup-toast");
  const closeBtn = document.getElementById("toast-close-btn");
  if (!toast) return;

  window.setTimeout(() => toast.classList.add("visible"), 900);
  const autoHide = window.setTimeout(() => toast.classList.remove("visible"), 5500);

  closeBtn?.addEventListener("click", () => {
    window.clearTimeout(autoHide);
    toast.classList.remove("visible");
  });
}

// ── Pre-loaded assistant conversation ─────────────────────
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

