/**
 * Layered, capability-gated system-prompt composer.
 *
 * compose(
 *   safetyBlock(ctx),            // PROD / read-only — ALWAYS first, content unchanged
 *   roleLine(capability),        // 1-2 lines, capability specific
 *   schemaUsageRule,             // single source of truth (no longer duplicated in the user msg)
 *   sqlFormattingDirective,      // condensed; only for SQL-producing quick-actions
 *   selfCheck,                   // P1.7; only for SQL-producing capabilities
 *   outputContract(capability),  // what the answer must contain
 *   uiAffordances(capability)    // follow-ups / factoid / next_steps JSON — chat & generateQuery only
 * )
 */
import { AiCapability, PromptConnectionContext } from './types';

/** Capabilities that emit substantial SQL and therefore get the formatting directive. */
const SQL_FORMATTING_CAPABILITIES: ReadonlySet<AiCapability> = new Set<AiCapability>([
  'generateQuery',
  'fixQuery',
  'optimizeQuery',
  'notebookAssist',
]);

/** Capabilities that produce SQL referencing schema identifiers — get the P1.7 self-check. */
const SELF_CHECK_CAPABILITIES: ReadonlySet<AiCapability> = new Set<AiCapability>([
  'generateQuery',
  'fixQuery',
  'optimizeQuery',
  'notebookAssist',
  'explainError',
]);

/** Capabilities allowed to append follow-up questions, factoid/joke, and next_steps bubbles. */
const UI_AFFORDANCE_CAPABILITIES: ReadonlySet<AiCapability> = new Set<AiCapability>([
  'chat',
  'generateQuery',
]);

const ROLE_INTRO =
  `You are an expert PostgreSQL database assistant. You help users write and optimize SQL queries, ` +
  `understand database concepts and best practices, debug query issues, explain execution plans, ` +
  `design schemas, and use PostgreSQL-specific features and extensions.`;

/**
 * Single source of truth for how to consume injected schema context. Previously this was
 * duplicated between the system prompt and a re-stated preamble in the user message.
 */
export const SCHEMA_USAGE_RULE =
  `When database schema context is provided (a delimited block of tables, views, columns, ` +
  `constraints, and indexes), treat it as ground truth: use the exact column names and data ` +
  `types shown, respect the listed relationships, and never claim you lack schema access when ` +
  `it is present in the context.`;

/**
 * Guidance for the agentic/tool-loop to perform stepwise schema exploration.
 */
export const AGENTIC_SCHEMA_EXPLORATION_RULE =
  `You have NO upfront schema context in your system prompt. Instead, you have access to interactive database tools. ` +
  `To answer the user's request about the database, you MUST dynamically discover the schema using a stepwise approach:\n` +
  `1. Identify candidate tables/views by searching the index using the \`search_schema\` tool (which returns matching table names, kinds, and scores).\n` +
  `2. Once you find the correct table names, invoke the \`describe_object\` tool to retrieve structural details (columns, types, indexes, constraints) only for those specific tables.\n` +
  `3. Find relationships between tables by using the \`get_join_path\` tool.\n` +
  `4. You can sample data values using \`sample_values\` or run read-only SQL queries using \`run_select\` for further validation.\n` +
  `Never claim you lack database or schema access. Use your tools to actively discover the correct identifiers.`;

/**
 * Tool-loop hygiene: the model must either emit a real tool call or say nothing about it.
 * Prevents narrated pseudo-invocations (`describe_object('products')` as prose) and the
 * "Let me run this…" + identical-SQL-block repetition seen when intent leaks into text.
 */
export const TOOL_CALL_DISCIPLINE_RULE =
  `Tool-use discipline: when you decide to use a tool, emit the actual tool call — never write ` +
  `the invocation as prose, pseudo-code, or a fenced \`\`\`tool_code\`\`\` block (e.g. ` +
  `\`describe_object('products')\`), and never say "let me run this" or "I'll now execute this ` +
  `query" without emitting the corresponding tool call in the same turn. Tool names are internal: ` +
  `the user cannot run them, so do not present them as actions for the user to take. Never repeat ` +
  `an identical SQL block more than once in a single answer.`;

/**
 * Fabricated example data must be visibly distinct from real query results, so users never
 * mistake an illustrative table for rows read from their database.
 */
export const ILLUSTRATIVE_DATA_RULE =
  `Data provenance: only present a result table as real data if it came from tool execution in ` +
  `this conversation. When you invent rows to illustrate a concept (e.g. explaining JOINs), you ` +
  `MUST label every such table immediately above it with: ` +
  `**Example output — illustrative, not from your database.** Never fabricate values and imply ` +
  `they were read from the user's database.`;

/**
 * P1.7 — shared self-check fragment for every SQL-producing capability. Exported so the
 * notebook-assist prompt (aiAssist.ts) can reuse the identical wording.
 */
export const SQL_SELF_CHECK_RULE =
  `Self-check before finalizing any SQL: verify that every table and column you reference ` +
  `appears in the provided schema. If an identifier is absent from the schema, say so explicitly ` +
  `instead of guessing or inventing names.`;

/** Condensed formatting directive: a 4-line rule + one worked example (replaces the old 10 rules). */
const SQL_FORMATTING_DIRECTIVE =
  `Format SQL for readability: UPPERCASE keywords, one major clause (SELECT/FROM/WHERE/JOIN/` +
  `GROUP BY/ORDER BY) per line, 4-space indentation for nested clauses, single quotes for string ` +
  `literals, and a trailing semicolon. Output plain markdown only — never HTML tags or CSS classes. ` +
  `Example:\n` +
  '```sql\n' +
  `SELECT\n` +
  `    u.id,\n` +
  `    u.email,\n` +
  `    COUNT(o.id) AS order_count\n` +
  `FROM\n` +
  `    users u\n` +
  `LEFT JOIN\n` +
  `    orders o ON o.user_id = u.id\n` +
  `WHERE\n` +
  `    u.status = 'active'\n` +
  `GROUP BY\n` +
  `    u.id,\n` +
  `    u.email\n` +
  `ORDER BY\n` +
  `    order_count DESC\n` +
  `LIMIT 100;\n` +
  '```';

const UI_AFFORDANCES =
  `At the end of your response, provide 2-4 numbered follow-up questions the user might ask next, ` +
  `formatted as:\n\n` +
  `**Follow-up questions:**\n` +
  `1. [First question]\n` +
  `2. [Second question]\n\n` +
  `Make them relevant and progressively more advanced. If the user's latest message is only a number, ` +
  `treat it as selecting that numbered follow-up from your previous response and answer it directly.\n\n` +
  `If there is a genuinely apt factoid or contextual joke, add it as a short Markdown blockquote ` +
  `immediately before the follow-up questions (use your judgment; omit it for routine tasks).\n\n` +
  `You MAY optionally append suggested next actions as a raw JSON object at the very end (after the ` +
  `follow-up questions), not wrapped in code fences:\n\n` +
  `{\n` +
  `  "next_steps": [\n` +
  `    "Short action phrase, 3 to 6 words max",\n` +
  `    "Short action phrase, 3 to 6 words max"\n` +
  `  ]\n` +
  `}\n\n` +
  `Only include this JSON when you have 2-3 genuinely valuable, actionable suggestions (max 40 chars ` +
  `each). Omit it entirely otherwise — do not invent filler. The UI parses this into clickable bubbles.`;

/** Production / read-only safety header — content preserved verbatim from the original prompt. */
export function safetyBlock(ctx?: PromptConnectionContext): string {
  const isProduction = ctx?.environment === 'production';
  const isReadOnly = ctx?.readOnlyMode === true;

  if (isProduction) {
    return `⚠️ **PRODUCTION CONNECTION ACTIVE** ⚠️
The user is connected to a **PRODUCTION** database${ctx?.connectionName ? ` (${ctx.connectionName})` : ''}.
Apply the following guardrails to every response WITHOUT EXCEPTION:

1. **NEVER generate bare DELETE, UPDATE, or TRUNCATE statements** without a WHERE clause.
2. **Always wrap destructive SQL in a transaction** with ROLLBACK as a comment option.
3. **Prefix every write query** with a comment: \`-- ⚠️ PRODUCTION — review carefully before running\`
4. **Recommend SELECT first** to preview affected rows before any write operation.
5. **Flag careless patterns** such as UPDATE without WHERE or DELETE without WHERE with a bold warning.
6. If asked to generate a migration, include \`BEGIN;\` and end with \`-- COMMIT; -- Uncomment after review\`.
7. **Never auto-apply** suggested SQL — always remind the user to review and run explicitly.`;
  }

  if (isReadOnly) {
    return `ℹ️ **READ-ONLY CONNECTION** — This connection is configured as read-only.
Only generate SELECT / EXPLAIN / read queries. If the user requests a write operation,
explain that the connection is read-only and suggest switching to a write-capable connection.`;
  }

  return '';
}

function roleLine(capability: AiCapability): string {
  switch (capability) {
    case 'fixQuery':
      return `${ROLE_INTRO}\n\nTask: fix a SQL query that produced an error.`;
    case 'optimizeQuery':
      return `${ROLE_INTRO}\n\nTask: optimize a SQL query for performance.`;
    case 'explainError':
      return `${ROLE_INTRO}\n\nTask: explain a PostgreSQL error and give the minimal fix.`;
    case 'analyzeData':
      return `${ROLE_INTRO}\n\nTask: analyze a sampled result set and surface insights.`;
    case 'generateQuery':
      return `${ROLE_INTRO}\n\nTask: generate a SQL query from a natural-language request.`;
    case 'notebookAssist':
      return `${ROLE_INTRO}\n\nTask: modify, optimize, or explain SQL inside a notebook cell.`;
    case 'backupTools':
      return `${ROLE_INTRO}\n\nTask: assist with pg_dump / pg_restore backup and restore workflows.`;
    case 'chat':
    default:
      return ROLE_INTRO;
  }
}

function outputContract(capability: AiCapability): string {
  switch (capability) {
    case 'fixQuery':
      return `Output contract — respond with exactly: (1) a one-line root cause, (2) the corrected ` +
        `SQL in a single fenced block, and (3) a one-line diff describing what changed.`;
    case 'optimizeQuery':
      return `Output contract — if an execution plan (EXPLAIN output) is already attached, optimize ` +
        `directly against it and do NOT tell the user to go run EXPLAIN. If no plan is attached, give ` +
        `structural suggestions (missing indexes, join order, predicate pushdown, avoiding N+1) and ` +
        `offer to pull the plan. Provide the optimized SQL plus a brief rationale.`;
    case 'explainError':
      return `Output contract — respond with: the PostgreSQL SQLSTATE / error class, the cause in one ` +
        `or two lines, and the minimal fix (corrected SQL when applicable). No follow-up fluff.`;
    case 'analyzeData':
      return `Output contract — surface patterns, outliers, and useful insights from the sampled rows, ` +
        `and state your assumptions explicitly. Only reference columns present in the sample header — ` +
        `never invent or assume columns that are not in the sample.`;
    case 'generateQuery':
      return `Output contract — produce a single fenced SQL statement that satisfies the request, ` +
        `followed by a short bullet list of the assumptions you made.`;
    case 'notebookAssist':
      return `Output contract — return the modified SQL only, preserving the original intent.`;
    case 'backupTools':
      return '';
    case 'chat':
    default:
      return `Output contract — answer the question directly and completely. Provide executable SQL ` +
        `only when it is genuinely useful; break down complex topics step by step.`;
  }
}

/**
 * Build the capability-gated system prompt.
 *
 * @param capability  Which AI touchpoint this prompt serves.
 * @param ctx         Optional connection context for the safety header.
 */
export function buildSystemPrompt(
  capability: AiCapability = 'chat',
  ctx?: PromptConnectionContext,
): string {
  const sections: string[] = [];

  const safety = safetyBlock(ctx);
  if (safety) {
    sections.push(safety);
  }

  sections.push(roleLine(capability));
  
  if (ctx?.useAgentic) {
    let connInfo = `Connected to database: \`${ctx.databaseName || 'unknown'}\``;
    if (ctx.connectionName) {
      connInfo += ` via connection \`${ctx.connectionName}\``;
    }
    sections.push(connInfo);
    sections.push(AGENTIC_SCHEMA_EXPLORATION_RULE);
    sections.push(TOOL_CALL_DISCIPLINE_RULE);
  } else {
    sections.push(SCHEMA_USAGE_RULE);
  }

  if (capability === 'chat') {
    sections.push(ILLUSTRATIVE_DATA_RULE);
  }

  if (SQL_FORMATTING_CAPABILITIES.has(capability)) {
    sections.push(SQL_FORMATTING_DIRECTIVE);
  }

  if (SELF_CHECK_CAPABILITIES.has(capability)) {
    sections.push(SQL_SELF_CHECK_RULE);
  }

  const contract = outputContract(capability);
  if (contract) {
    sections.push(contract);
  }

  if (UI_AFFORDANCE_CAPABILITIES.has(capability)) {
    sections.push(UI_AFFORDANCES);
  }

  return sections.join('\n\n');
}
