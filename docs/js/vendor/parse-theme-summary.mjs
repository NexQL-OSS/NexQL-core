/**
 * Derive the marketing-site palette summary from a VS Code color-theme JSON.
 * Keys mirror the standalone NexQL Site canvas component.
 */

/** @typedef {import("../static-themes.mjs").StaticThemeSpec} StaticThemeSpec */

const TOKEN_RULE_MAP = [
  ["Keywords", "keyword"],
  ["Functions", "func"],
  ["Types", "typ"],
  ["Strings", "string"],
  ["Numbers and language constants", "number"],
  ["Comments", "comment"],
  ["Operators and punctuation", "operator"],
  ["Tables and classes", "tag"],
  ["Tags (HTML/JSX)", "tag"],
  ["Variables, columns, parameters", "variable"],
  ["Properties and object keys", "property"],
  ["Constants", "constant"],
];

const SEMANTIC_FALLBACK = {
  keyword: "keyword",
  function: "func",
  method: "func",
  type: "typ",
  class: "typ",
  string: "string",
  number: "number",
  comment: "comment",
  operator: "operator",
  variable: "variable",
  parameter: "parameter",
  property: "property",
};

/**
 * @param {string} filename
 * @returns {string}
 */
export function themeIdFromFilename(filename) {
  return filename.replace(/^nexql-/, "").replace(/-color-theme\.json$/, "");
}

/**
 * @param {string} id
 * @returns {string}
 */
export function familyFromId(id) {
  if (id.startsWith("claudy")) return "Claudy";
  if (id.startsWith("sage")) return "Sage";
  if (id.startsWith("postgres")) return "Postgres";
  if (id.startsWith("drift")) return "Drift";
  if (id.startsWith("mute")) return "Mute";
  if (id.startsWith("ember")) return "Ember";
  if (id.startsWith("oled")) return "OLED";
  if (id.startsWith("break-of-dawn")) return "Break of Dawn";
  if (id.startsWith("contrast")) return "Contrast";
  if (id.startsWith("first-light") || id.startsWith("high-noon") || id.startsWith("golden-hour") || id.startsWith("midnight-oil")) return "Circadian";
  if (id.startsWith("focus") || id.startsWith("spectrum") || id.startsWith("zen")) return "Cognitive Load";
  if (id.startsWith("rustacean") || id.startsWith("pythonic") || id.startsWith("webflow") || id.startsWith("data-pipeline")) return "Language-Optimized";
  if (id.startsWith("redacted") || id.startsWith("audit-trail")) return "Security";
  if (id.startsWith("aurora") || id.startsWith("solstice") || id.startsWith("harvest") || id.startsWith("bloom")) return "Seasonal";
  return "NexQL";
}

/**
 * @param {string | { foreground?: string } | undefined} value
 * @returns {string | undefined}
 */
function semanticColor(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return value.foreground;
}

/**
 * @param {unknown} themeJson
 * @param {StaticThemeSpec} spec
 * @returns {Record<string, unknown>}
 */
export function parseThemeSummary(themeJson, spec) {
  const theme = /** @type {{ name?: string; type?: string; colors?: Record<string, string>; tokenColors?: Array<{ name?: string; settings?: { foreground?: string } }>; semanticTokenColors?: Record<string, string | { foreground?: string }> }} */ (
    themeJson
  );
  const colors = theme.colors ?? {};
  const id = themeIdFromFilename(spec.filename);
  const light = spec.uiTheme === "vs" || spec.uiTheme === "hc-light";

  /** @type {Record<string, string>} */
  const tokens = {};

  for (const rule of theme.tokenColors ?? []) {
    const fg = rule.settings?.foreground;
    if (!rule.name || !fg) continue;
    for (const [ruleName, key] of TOKEN_RULE_MAP) {
      if (rule.name === ruleName && !tokens[key]) tokens[key] = fg;
    }
  }

  const semantic = theme.semanticTokenColors ?? {};
  for (const [semKey, summaryKey] of Object.entries(SEMANTIC_FALLBACK)) {
    if (!tokens[summaryKey]) {
      const fg = semanticColor(semantic[semKey]);
      if (fg) tokens[summaryKey] = fg;
    }
  }

  const fg = colors["editor.foreground"] ?? "#cccccc";
  const accent = colors["activityBarBadge.background"] ?? colors["focusBorder"] ?? fg;

  return {
    id,
    name: theme.name ?? spec.label,
    family: familyFromId(id),
    light,
    bg: colors["editor.background"] ?? "#1e1e1e",
    fg,
    panel: colors["sideBar.background"] ?? colors["activityBar.background"] ?? colors["editor.background"] ?? "#252526",
    deep: colors["activityBar.background"] ?? colors["editor.background"] ?? "#1e1e1e",
    border: colors["editorGroup.border"] ?? colors["panel.border"] ?? "#3c3c3c",
    muted: colors["descriptionForeground"] ?? colors["editorCodeLens.foreground"] ?? fg,
    accent,
    badge: colors["activityBarBadge.background"] ?? accent,
    badgeFg: colors["activityBarBadge.foreground"] ?? "#ffffff",
    sel: colors["editor.selectionBackground"] ?? `${accent}40`,
    lineHi: colors["editor.lineHighlightBackground"] ?? `${colors["editor.background"] ?? "#1e1e1e"}80`,
    keyword: tokens.keyword ?? fg,
    func: tokens.func ?? fg,
    typ: tokens.typ ?? fg,
    string: tokens.string ?? fg,
    number: tokens.number ?? fg,
    comment: tokens.comment ?? colors["descriptionForeground"] ?? fg,
    tag: tokens.tag ?? tokens.func ?? fg,
    operator: tokens.operator ?? tokens.func ?? fg,
    variable: tokens.variable ?? fg,
    property: tokens.property ?? tokens.typ ?? fg,
    constant: tokens.constant ?? tokens.number ?? fg,
    parameter: tokens.parameter ?? tokens.variable ?? fg,
    filename: spec.filename,
    uiTheme: spec.uiTheme,
  };
}
