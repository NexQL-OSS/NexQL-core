import { parseThemeSummary } from "./vendor/parse-theme-summary.mjs";

const THEME_KEY = "nexql-docs-theme";
const DEFAULT_THEME_ID = "claudy-day";

/** @type {Array<Record<string, unknown>>} */
let themes = [];

/** @type {Record<string, unknown> | null} */
let current = null;

/** @type {Promise<void> | null} */
let readyPromise = null;

/** @type {boolean} */
let menuOpen = false;

/** @type {Comment | null} */
let menuAnchor = null;

/**
 * @returns {string}
 */
function themesBase() {
  const override = document.documentElement.dataset.themesBase;
  if (override) return override.replace(/\/$/, "");
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "/themes";
  }
  return "https://nexql-themes.astrx.dev/themes";
}

/**
 * @param {string} name
 * @returns {string}
 */
function shortThemeName(name) {
  return String(name).replace(/^NexQL\s+/, "");
}

/** Fallback when CDN / proxy is unavailable. */
const FALLBACK_SUMMARY = {
  id: "drift-dark",
  name: "NexQL Drift Dark",
  family: "Drift",
  light: false,
  bg: "#0b0e1a",
  fg: "#e8ebf6",
  panel: "#0a0d18",
  deep: "#07080e",
  border: "rgba(255, 255, 255, 0.07)",
  muted: "#98a2bd",
  accent: "#6c4cf0",
  badge: "#6c4cf0",
  badgeFg: "#ffffff",
  sel: "rgba(108, 76, 240, 0.18)",
  lineHi: "rgba(11, 14, 26, 0.5)",
  keyword: "#8e8fb8",
  func: "#7aa8e8",
  typ: "#b68cdb",
  string: "#d9a86c",
  number: "#d9a86c",
  comment: "#646e8c",
  tag: "#7aa8e8",
  operator: "#8e8fb8",
  variable: "#d8d6e0",
  property: "#d8d6e0",
  constant: "#d9a86c",
  parameter: "#d8d6e0",
};

/**
 * @param {Record<string, unknown>} th
 */
function syncThemePickerUi(th) {
  const label = document.getElementById("theme-picker-label");
  const dot = document.getElementById("theme-picker-dot");
  if (label) label.textContent = shortThemeName(/** @type {string} */ (th.name));
  if (dot) dot.style.background = /** @type {string} */ (th.accent);

  const menu = document.getElementById("theme-picker-menu");
  if (!menu) return;
  menu.querySelectorAll(".theme-picker-option").forEach((btn) => {
    const on = btn.getAttribute("data-theme-id") === th.id;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
}

/**
 * @param {Record<string, unknown>} th
 */
function applySiteTheme(th) {
  current = th;
  const root = document.documentElement;
  const body = document.body;
  body?.classList.add("pg-anim");
  body?.setAttribute("data-theme", th.light ? "light" : "dark");

  const vars = {
    "--bg": th.bg,
    "--fg": th.fg,
    "--panel": th.panel,
    "--deep": th.deep,
    "--border": th.border,
    "--muted": th.muted,
    "--accent": th.accent,
    "--badge": th.badge,
    "--badgeFg": th.badgeFg,
    "--sel": th.sel,
    "--line": th.lineHi,
    "--vsc-bg": th.bg,
    "--vsc-editor-bg": th.bg,
    "--vsc-sidebar": th.panel,
    "--vsc-sidebar-bg": th.panel,
    "--vsc-shell-bg": th.bg,
    "--vsc-activitybar": th.deep,
    "--vsc-tab-active": th.bg,
    "--vsc-tab-inactive": th.panel,
    "--vsc-statusbar": th.accent,
    "--vsc-border": th.border,
    "--vsc-text": th.fg,
    "--vsc-muted": th.muted,
    "--vsc-foreground": th.fg,
    "--vsc-accent": th.accent,
    "--vsc-highlight": th.sel,
    "--vsc-blue": th.func,
    "--vsc-orange": th.string,
    "--site-bg": th.deep,
    "--nex-fg": th.fg,
    "--nex-muted": th.muted,
    "--nex-bg": th.deep,
    "--nex-bg-2": th.panel,
    "--nex-panel": th.panel,
    "--nex-line": th.border,
    "--surface": th.panel,
    "--sql-kw": th.keyword,
    "--sql-fn": th.func,
    "--sql-str": th.string,
    "--sql-num": th.number,
    "--sql-comment": th.comment,
    "--desktop-topbar-bg": `color-mix(in srgb, ${th.deep} 82%, transparent)`,
    "--desktop-topbar-border": th.border,
    "--desktop-topbar-link": th.muted,
    "--desktop-topbar-link-hover": th.fg,
    "--desktop-topbar-intro": th.muted,
    "--desktop-topbar-icon-bg": `color-mix(in srgb, ${th.panel} 75%, transparent)`,
    "--desktop-topbar-icon-border": th.border,
    "--landing-fg": th.fg,
    "--landing-muted": th.muted,
    "--landing-faint": `color-mix(in srgb, ${th.muted} 70%, ${th.fg})`,
    "--landing-surface": `color-mix(in srgb, ${th.fg} 4%, ${th.panel})`,
    "--landing-surface-hover": `color-mix(in srgb, ${th.fg} 7%, ${th.panel})`,
    "--landing-border": th.border,
    "--landing-border-strong": `color-mix(in srgb, ${th.fg} 12%, ${th.border})`,
  };

  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, /** @type {string} */ (value));
  }

  const heroGradient = th.light
    ? `radial-gradient(circle at 18% 18%, color-mix(in srgb, ${th.accent} 12%, transparent), transparent 34%),
       radial-gradient(circle at 84% 28%, color-mix(in srgb, ${th.func} 10%, transparent), transparent 32%),
       linear-gradient(135deg, ${th.deep} 0%, ${th.bg} 46%, ${th.panel} 100%)`
    : `radial-gradient(circle at 18% 18%, color-mix(in srgb, ${th.func} 22%, transparent), transparent 34%),
       radial-gradient(circle at 84% 28%, color-mix(in srgb, ${th.accent} 16%, transparent), transparent 32%),
       radial-gradient(circle at 50% 90%, color-mix(in srgb, ${th.string} 12%, transparent), transparent 40%),
       linear-gradient(135deg, ${th.deep} 0%, ${th.bg} 46%, ${th.panel} 100%)`;
  root.style.setProperty("--hero-gradient", heroGradient);

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute("content", /** @type {string} */ (th.deep ?? th.bg));

  const statusTheme = document.getElementById("sb-theme");
  if (statusTheme) {
    statusTheme.textContent = `Theme: ${shortThemeName(/** @type {string} */ (th.name))}`;
  }

  syncThemePickerUi(th);

  if (typeof Chart !== "undefined") {
    const canvas = document.getElementById("revenue-chart");
    if (canvas && Chart.getChart(canvas)) {
      Chart.getChart(canvas).destroy();
    }
    if (typeof renderRevenueChart === "function") {
      window.setTimeout(renderRevenueChart, 40);
    }
  }

  document.dispatchEvent(
    new CustomEvent("nexql-theme-changed", { detail: { theme: th } }),
  );
}

/**
 * @param {string} id
 */
function applyThemeById(id) {
  const th = themes.find((t) => t.id === id);
  if (!th) return;
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // storage may be blocked
  }
  applySiteTheme(th);
  closeThemeMenu();
}

function positionThemeMenu() {
  const trigger = document.getElementById("theme-picker-trigger");
  const menu = document.getElementById("theme-picker-menu");
  if (!trigger || !menu) return;

  const rect = trigger.getBoundingClientRect();
  const gap = 8;
  const margin = 12;
  const width = Math.max(rect.width, 260);
  let left = rect.right - width;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const maxHeight = Math.min(420, window.innerHeight - rect.bottom - gap - margin);

  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + gap}px`;
  menu.style.left = `${left}px`;
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${Math.max(160, maxHeight)}px`;
}

function mountMenuPortal() {
  const root = document.getElementById("theme-picker");
  const menu = document.getElementById("theme-picker-menu");
  if (!root || !menu || menuAnchor) return;
  menuAnchor = document.createComment("theme-picker-menu-anchor");
  root.appendChild(menuAnchor);
  document.body.appendChild(menu);
  menu.classList.add("is-portal");
}

function unmountMenuPortal() {
  const root = document.getElementById("theme-picker");
  const menu = document.getElementById("theme-picker-menu");
  if (!root || !menu || !menuAnchor) return;
  root.insertBefore(menu, menuAnchor);
  menuAnchor.remove();
  menuAnchor = null;
  menu.classList.remove("is-portal");
  menu.style.position = "";
  menu.style.top = "";
  menu.style.left = "";
  menu.style.width = "";
  menu.style.maxHeight = "";
}

function closeThemeMenu() {
  const trigger = document.getElementById("theme-picker-trigger");
  const menu = document.getElementById("theme-picker-menu");
  if (!trigger || !menu) return;
  menuOpen = false;
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  unmountMenuPortal();
}

function openThemeMenu() {
  const trigger = document.getElementById("theme-picker-trigger");
  const menu = document.getElementById("theme-picker-menu");
  if (!trigger || !menu) return;
  mountMenuPortal();
  positionThemeMenu();
  menuOpen = true;
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  const active = menu.querySelector(".theme-picker-option.is-active");
  if (active instanceof HTMLElement) active.focus();
}

function toggleThemeMenu() {
  if (menuOpen) closeThemeMenu();
  else openThemeMenu();
}

/**
 * @param {HTMLElement} menu
 */
function buildThemePickerMenu(menu) {
  menu.replaceChildren();
  const families = [...new Set(themes.map((t) => /** @type {string} */ (t.family)))];

  for (const family of families) {
    const heading = document.createElement("div");
    heading.className = "theme-picker-family";
    heading.textContent = family;
    menu.appendChild(heading);

    for (const th of themes.filter((t) => t.family === family)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-picker-option";
      btn.setAttribute("role", "option");
      btn.setAttribute("data-theme-id", /** @type {string} */ (th.id));
      btn.setAttribute("aria-selected", "false");

      const swatch = document.createElement("span");
      swatch.className = "theme-picker-swatch";
      swatch.style.background = /** @type {string} */ (th.accent);
      swatch.setAttribute("aria-hidden", "true");

      const name = document.createElement("span");
      name.className = "theme-picker-name";
      name.textContent = shortThemeName(/** @type {string} */ (th.name));

      const kind = document.createElement("span");
      kind.className = "theme-picker-kind";
      kind.textContent = th.light ? "Light" : "Dark";

      btn.append(swatch, name, kind);
      btn.addEventListener("click", () => applyThemeById(/** @type {string} */ (th.id)));
      menu.appendChild(btn);
    }
  }
}

function wireThemePicker() {
  const root = document.getElementById("theme-picker");
  const trigger = document.getElementById("theme-picker-trigger");
  const menu = document.getElementById("theme-picker-menu");
  if (!root || !trigger || !menu || !themes.length) return;

  buildThemePickerMenu(menu);
  if (current) syncThemePickerUi(current);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleThemeMenu();
  });

  document.addEventListener("click", (e) => {
    if (!menuOpen) return;
    const target = /** @type {Node} */ (e.target);
    if (!root.contains(target) && !menu.contains(target)) closeThemeMenu();
  });

  window.addEventListener(
    "scroll",
    () => {
      if (menuOpen) closeThemeMenu();
    },
    { passive: true },
  );

  window.addEventListener("resize", () => {
    if (menuOpen) positionThemeMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      closeThemeMenu();
      trigger.focus();
    }
  });

  menu.addEventListener("keydown", (e) => {
    const options = [...menu.querySelectorAll(".theme-picker-option")];
    const idx = options.indexOf(/** @type {Element} */ (document.activeElement));
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = options[Math.min(idx + 1, options.length - 1)] ?? options[0];
      if (next instanceof HTMLElement) next.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = options[Math.max(idx - 1, 0)] ?? options[options.length - 1];
      if (prev instanceof HTMLElement) prev.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      if (document.activeElement?.classList.contains("theme-picker-option")) {
        e.preventDefault();
        const id = document.activeElement.getAttribute("data-theme-id");
        if (id) applyThemeById(id);
      }
    }
  });
}

async function loadThemes() {
  const base = themesBase();
  try {
    const specs = await fetch(`${base}/manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`manifest.json ${r.status}`);
      return r.json();
    });

    themes = await Promise.all(
      specs.map(async (/** @type {{ label: string; filename: string; uiTheme: string }} */ spec) => {
        const json = await fetch(`${base}/${spec.filename}`).then((r) => {
          if (!r.ok) throw new Error(`${spec.filename} ${r.status}`);
          return r.json();
        });
        return parseThemeSummary(json, spec);
      }),
    );
  } catch (err) {
    console.warn("NexQL themes fetch failed, using fallback palette:", err);
    themes = [FALLBACK_SUMMARY];
  }

  let stored = DEFAULT_THEME_ID;
  try {
    stored = localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME_ID;
  } catch {
    // ignore
  }

  const initial =
    themes.find((t) => t.id === stored) ??
    themes.find((t) => t.id === DEFAULT_THEME_ID) ??
    themes[0];

  if (initial) applySiteTheme(initial);
  wireThemePicker();
}

function init() {
  if (!readyPromise) {
    readyPromise = loadThemes().then(() => {
      document.dispatchEvent(new CustomEvent("nexql-themes-ready"));
    });
  }
  return readyPromise;
}

window.NexqlThemes = {
  get list() {
    return themes.slice();
  },
  get current() {
    return current;
  },
  apply: applyThemeById,
  get ready() {
    return init();
  },
};

init();
