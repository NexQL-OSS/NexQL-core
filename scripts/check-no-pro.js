#!/usr/bin/env node
/**
 * check-no-pro.js — IP guardrail for the NexQL-Core (public) repo.
 *
 * Fails with exit code 1 if any of the following are found:
 *   1. Premium implementation symbols in src/ (excluding the seam files)
 *   2. packages/ directory tracked in git (premium source must not be committed here)
 *
 * Run: node scripts/check-no-pro.js
 * CI:  Triggered on every PR to main via .github/workflows/check-no-pro.yml
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// ---------------------------------------------------------------------------
// Allowlisted files that ARE allowed to mention premium seam identifiers
// ---------------------------------------------------------------------------
const ALLOWLISTED_PATHS = new Set([
  path.join(SRC, 'pro', 'api.ts'),
  path.join(SRC, 'pro', 'index.ts'),
  path.join(SRC, 'services', 'chatViewRegistry.ts'),
  path.join(SRC, 'services', 'featureGates.ts'),
]);

// Allowlisted patterns (prefixes) — lazy renderer stubs under src/ui/
const ALLOWLISTED_PREFIXES = [
  path.join(SRC, 'ui', 'renderer'),
];

// ---------------------------------------------------------------------------
// Forbidden patterns — if any of these appear as a runtime import or class
// reference in a non-allowlisted core file, it's a leak.
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = [
  /\bChatViewProvider\b(?!\s*\})/,          // class reference (not just type export brace)
  /\bDashboardPanel\b/,
  /\bPlanStudioPanel\b/,
  /\bPlanStoreWorkspace\b/,
  /\bNexqlMcpServer\b/,
  /\bBackupRestorePanel\b/,
  /schemaDesigner\//,
  /\baiAssistant\//,
  /\bopencode\//,
  /\bToolExecutor\b/,
  /from ['"]\.\.\/dashboard\//,
  /from ['"]\.\.\/mcp\//,
  /from ['"]\.\.\/providers\/ChatViewProvider['"]/,
  /from ['"]\.\.\/features\/planStudio\//,
  /from ['"]\.\.\/features\/backup\//,
  /from ['"]\.\.\/features\/aiAssistant\//,
  // moved to packages/pro in the free/pro gating pass
  /\bDbIndexPanel\b/,
  /features\/dbindex\//,
  /import\((['"])[^'"]*commands\/license\1\)/,
  /from (['"])[^'"]*commands\/license\1/,
];

// ---------------------------------------------------------------------------
// Proprietary header check — core files must NOT carry the proprietary header
// ---------------------------------------------------------------------------
const PROPRIETARY_HEADER = 'PROPRIETARY AND CONFIDENTIAL';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isAllowlisted(filePath) {
  if (ALLOWLISTED_PATHS.has(filePath)) return true;
  return ALLOWLISTED_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

function walkTs(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      walkTs(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Check 1: Premium symbol leakage in src/
// ---------------------------------------------------------------------------
let violations = 0;

console.log('NexQL check-no-pro: scanning src/ for premium symbol leakage...\n');

const files = walkTs(SRC);
for (const filePath of files) {
  if (isAllowlisted(filePath)) continue;

  const rawContent = fs.readFileSync(filePath, 'utf8');
  const relPath = path.relative(ROOT, filePath);

  // Check for proprietary header (raw content — must never appear)
  if (rawContent.includes(PROPRIETARY_HEADER)) {
    console.error(`  ❌ PROPRIETARY HEADER in core file: ${relPath}`);
    violations++;
  }

  // Strip single-line comments and block comments before pattern scanning
  // to avoid false positives from JSDoc mentioning moved types.
  const content = rawContent
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '');         // line comments

  // Check for forbidden patterns
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      console.error(`  ❌ Forbidden pattern [${pattern.source}] in: ${relPath}`);
      violations++;
      break; // one violation per file is enough
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: packages/ must not be tracked by git
// ---------------------------------------------------------------------------
let trackedPackages = '';
try {
  trackedPackages = execSync('git ls-files packages/', { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  // git not available or packages/ doesn't exist — not a failure
}

if (trackedPackages.length > 0) {
  console.error('\n  ❌ packages/ directory contains git-tracked files:');
  console.error('  ' + trackedPackages.split('\n').slice(0, 5).join('\n  '));
  console.error('  → packages/ must only exist as an untracked symlink (private repo build) or be absent.\n');
  violations++;
}

// ---------------------------------------------------------------------------
// Check 3: package.json must not contain a merged pro manifest
// (make dev-pro / merge-pro-manifest.js mutate it; make dev-free restores it)
// ---------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const mergedMarkers = [];
if (pkg.contributes && pkg.contributes.mcpServerDefinitionProviders) {
  mergedMarkers.push('contributes.mcpServerDefinitionProviders');
}
const views = (pkg.contributes && pkg.contributes.views) || {};
for (const container of Object.keys(views)) {
  if (views[container].some((v) => v.id === 'postgresExplorer.chatView')) {
    mergedMarkers.push(`views.${container}: postgresExplorer.chatView`);
  }
}
if ((pkg.activationEvents || []).includes('onView:postgresExplorer.chatView')) {
  mergedMarkers.push('activationEvents: onView:postgresExplorer.chatView');
}
if (mergedMarkers.length > 0) {
  console.error('\n  ❌ package.json contains merged pro manifest entries:');
  console.error('  ' + mergedMarkers.join('\n  '));
  console.error("  → run 'make dev-free' (or restore package.json) before committing.\n");
  violations++;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
if (violations === 0) {
  console.log(`✅ check-no-pro passed — ${files.length} files scanned, no leakage found.`);
  process.exit(0);
} else {
  console.error(`\n❌ check-no-pro FAILED — ${violations} violation(s) found.`);
  console.error('   Fix: move premium implementations into packages/pro/src/ and import via IChatViewProvider or dynamic require.\n');
  process.exit(1);
}
