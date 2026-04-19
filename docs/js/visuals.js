// ── Count-up animation ────────────────────────────────────
function animateCountUp(el, target, suffix, durationMs) {
  if (!el) return;
  const FRAME_MS = 16;
  const steps = Math.ceil(durationMs / FRAME_MS);
  let step = 0;
  const isFloat = String(target).includes(".");
  el.textContent = isFloat ? "0.0" : "0";
  const interval = window.setInterval(() => {
    step++;
    const progress = Math.min(step / steps, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = target * eased;
    el.textContent = (isFloat ? current.toFixed(1) : Math.round(current).toLocaleString()) + (suffix || "");
    if (step >= steps) window.clearInterval(interval);
  }, FRAME_MS);
}

// ── Marketplace stats ─────────────────────────────────────
function formatCompactNumber(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return `${value}`;
}

async function hydrateMarketplaceStats() {
  try {
    const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json;api-version=3.0-preview.1" },
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: "ric-v.postgres-explorer" }] }], flags: 914 })
    });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const ext = data?.results?.[0]?.extensions?.[0];
    if (!ext) throw new Error("missing");
    const installs = ext.statistics?.find((s) => s.statisticName === "install")?.value ?? 0;
    const rating = ext.statistics?.find((s) => s.statisticName === "weightedRating")?.value ?? 0;
    const version = ext.versions?.[0]?.version ?? "0.0.0";

    const dlEl = document.getElementById("stat-downloads");
    const rtEl = document.getElementById("stat-rating");
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("stat-version", `v${version}`);
    set("badge-version", `v${version}`);
    set("min-overview-version", version);

    document.querySelectorAll('[itemprop="softwareVersion"]').forEach((el) => {
      if (el.tagName === "META") {
        el.setAttribute("content", version);
      } else {
        el.textContent = version;
      }
    });

    window.setTimeout(() => {
      animateCountUp(dlEl, installs >= 1e3 ? installs / 1e3 : installs, installs >= 1e3 ? "K" : "", 1200);
      animateCountUp(rtEl, rating, "", 800);
    }, 600);
  } catch (e) { console.error("Marketplace stats failed", e); }
}

// ── Revenue bar chart (Chart.js) ──────────────────────────
function renderRevenueChart() {
  const canvas = document.getElementById("revenue-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const isDark = document.body.getAttribute("data-theme") === "dark";
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(77,94,252,0.08)";
  const textColor = isDark ? "#9ca6d4" : "#667096";
  const barColor = isDark ? "rgba(24,214,255,0.55)" : "rgba(77,94,252,0.62)";
  const barBorder = isDark ? "rgba(24,214,255,0.85)" : "#4d5efc";

  new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Apr 7", "Apr 8", "Apr 9", "Apr 10", "Apr 11", "Apr 12", "Apr 13"],
      datasets: [{
        label: "Revenue ($)",
        data: [18420, 21340.5, 17890, 24110.25, 27905.4, 22490, 26331.75],
        backgroundColor: barColor,
        borderColor: barBorder,
        borderWidth: 1,
        borderRadius: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? "#1c1d4f" : "#ffffff",
          borderColor: isDark ? "rgba(24,214,255,0.3)" : "rgba(77,94,252,0.3)",
          borderWidth: 1,
          titleColor: isDark ? "#eff3ff" : "#14162b",
          bodyColor: isDark ? "#9ca6d4" : "#667096",
          cornerRadius: 6,
          callbacks: {
            label: (ctx) => `$${ctx.parsed.y.toLocaleString()}`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: textColor, font: { size: 10 } }
        },
        y: {
          grid: { color: gridColor },
          ticks: {
            color: textColor,
            font: { size: 10 },
            callback: (v) => `$${(v / 1000).toFixed(0)}K`
          }
        }
      }
    }
  });
}

// ── SQL typing animation on query tab ─────────────────────
let sqlTypingDone = false;

function animateSqlTyping() {
  if (sqlTypingDone) return;
  sqlTypingDone = true;

  const sqlBlock = document.querySelector("#file-query .sql code");
  if (!sqlBlock) return;

  const lines = sqlBlock.innerHTML.split("\n");
  sqlBlock.innerHTML = "";

  lines.forEach((line, i) => {
    const span = document.createElement("span");
    span.className = "sql-typing-line";
    span.innerHTML = line + (i < lines.length - 1 ? "\n" : "");
    sqlBlock.appendChild(span);
    window.setTimeout(() => span.classList.add("visible"), 200 + i * 120);
  });
}

