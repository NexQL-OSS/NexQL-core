/**
 * Static MCP prompts: canned diagnostic workflows that script NexQL's DB
 * tools. `prompts/get` never touches the database, so these are instant and
 * cannot fail against an unreachable server.
 */

interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgument[];
  build: (args: Record<string, string>) => string;
}

function rpcError(code: number, message: string): Error {
  const err: any = new Error(message);
  err.rpcCode = code;
  return err;
}

const PROMPTS: PromptDefinition[] = [
  {
    name: 'health-check',
    description: 'Run a full database health assessment and summarize issues by severity.',
    arguments: [],
    build: () =>
      [
        'Assess the health of the connected PostgreSQL database:',
        '1. Run the db_health_check tool for the overview (size, connections, cache hit ratio, dead tuples).',
        '2. Run find_blocking_locks to check for lock contention.',
        '3. Run list_running_queries to spot long-running or stuck queries.',
        'Then produce a summary grouped by severity (critical / warning / ok):',
        '- Flag cache hit ratio below 0.95, any blocking locks, queries running longer than 5 minutes, and tables with high dead-tuple counts.',
        '- For each issue, state the evidence and a concrete remediation (e.g. VACUUM, index, terminate pid).'
      ].join('\n')
  },
  {
    name: 'analyze-slow-queries',
    description: 'Find the slowest queries and propose index or rewrite improvements.',
    arguments: [],
    build: () =>
      [
        'Identify and improve the slowest queries in the connected database:',
        '1. Run the slow_queries tool to get the top statements by mean execution time.',
        '2. For each of the top 3 offenders, run analyze_query_plan on the query text to get plan metrics and bottlenecks.',
        '3. Before proposing any index, verify the referenced tables and columns exist using describe_object.',
        'Deliver: for each slow query — the bottleneck (seq scan, spill, misestimate), a proposed fix (CREATE INDEX CONCURRENTLY statement or query rewrite), and the expected impact.'
      ].join('\n')
  },
  {
    name: 'explore-schema',
    description: 'Explore and summarize the database schema around a topic.',
    arguments: [
      {
        name: 'topic',
        description: 'What to explore, e.g. "orders", "user accounts", "billing".',
        required: true
      }
    ],
    build: (args) =>
      [
        `Explore the database schema related to: ${args.topic}`,
        '1. Run search_schema with the topic to find relevant tables, views, and functions.',
        '2. Run describe_object on each of the top hits to get columns, keys, and indexes.',
        '3. Run get_join_path between related tables to understand how they connect.',
        'Deliver a schema summary: the core tables with their purpose, key columns, relationships (as a join diagram in text), and any views or functions that operate on them.'
      ].join('\n')
  },
  {
    name: 'debug-blocking',
    description: 'Diagnose lock contention and identify the root blocking session.',
    arguments: [],
    build: () =>
      [
        'Diagnose lock contention in the connected database:',
        '1. Run find_blocking_locks to get blocked/blocking pid pairs with their queries.',
        '2. Run list_running_queries to see the full activity picture (states, wait events, durations).',
        'Then explain the lock chain: which pid is the root blocker, what query it is running, how long it has been running, and which sessions are waiting on it (directly or transitively).',
        'Recommend an action: wait, or terminate the root blocker (give the exact pg_terminate_backend(pid) statement, but do NOT execute it — all tools are read-only).'
      ].join('\n')
  }
];

export class McpPrompts {
  list(): { prompts: Array<{ name: string; description: string; arguments: PromptArgument[] }> } {
    return {
      prompts: PROMPTS.map(({ name, description, arguments: args }) => ({
        name,
        description,
        arguments: args
      }))
    };
  }

  get(name: string, args: Record<string, string> = {}): {
    description: string;
    messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
  } {
    const prompt = PROMPTS.find((p) => p.name === name);
    if (!prompt) {
      throw rpcError(-32602, `Unknown prompt: ${name}`);
    }
    for (const arg of prompt.arguments) {
      if (arg.required && !args[arg.name]) {
        throw rpcError(-32602, `Missing required argument "${arg.name}" for prompt "${name}"`);
      }
    }
    return {
      description: prompt.description,
      messages: [
        { role: 'user', content: { type: 'text', text: prompt.build(args) } }
      ]
    };
  }
}
