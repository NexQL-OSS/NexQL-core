import * as vscode from 'vscode';

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required: string[];
  };
}

export const DB_TOOLS: ToolSpec[] = [
  {
    name: 'select_connection_context',
    description: 'Ask the user to choose or confirm a database connection to use for the conversation when the prompt is vague, lacks context, or references a database not currently selected.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'The explanation to show the user as to why they are being prompted to select a connection (e.g. "I need to know which database contains the active brands table").'
        }
      },
      required: ['reason']
    }
  },
  {
    name: 'search_schema',
    description: 'Search the live, auto-indexed database schema using natural language or keywords to find tables, views, materialized views, and functions matching the query. Call this FIRST before writing any SQL — do not assume a table exists without finding it here.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query or keywords (e.g. "users", "order transactions", "active clients").'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'describe_object',
    description: 'Get structural details of a specific database object (table, view, or materialized view) including columns, data types, constraints, and indexes.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Fully qualified reference to the database object in format "schema.object_name" (e.g., "public.users").'
        }
      },
      required: ['ref']
    }
  },
  {
    name: 'get_join_path',
    description: 'Find the shortest path of join relationships and foreign keys between two database tables.',
    parameters: {
      type: 'object',
      properties: {
        a: {
          type: 'string',
          description: 'Fully qualified reference to the first table (e.g., "public.orders").'
        },
        b: {
          type: 'string',
          description: 'Fully qualified reference to the second table (e.g., "public.customers").'
        }
      },
      required: ['a', 'b']
    }
  },
  {
    name: 'sample_values',
    description: 'Retrieve a list of sample values from a specific table column to inspect its contents. Only works on read-only SELECT queries.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Fully qualified reference to the table (e.g., "public.users").'
        },
        col: {
          type: 'string',
          description: 'The name of the column to sample (e.g., "status").'
        }
      },
      required: ['ref', 'col']
    }
  },
  {
    name: 'run_select',
    description: 'Run a read-only SELECT or WITH query against the database to fetch actual data rows. Modifying queries (INSERT, UPDATE, DELETE, etc.) are strictly prohibited. Only reference tables/columns already confirmed via search_schema, list_objects, or describe_object in this conversation — never guess schema names from assumptions.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL SELECT or WITH query to execute.'
        }
      },
      required: ['sql']
    }
  },
  {
    name: 'explain_query',
    description: 'Get the EXPLAIN query execution plan for a SELECT or WITH SQL query to analyze its performance and bottlenecks.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL SELECT or WITH query to explain.'
        }
      },
      required: ['sql']
    }
  },
  {
    name: 'list_connections',
    description: 'List all configured database connections including their name, host, port, database, environment, and ID. No passwords or credentials are returned.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'list_databases',
    description: 'List all databases available for a specific connection.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          description: 'The unique ID of the connection.'
        }
      },
      required: ['connectionId']
    }
  },
  {
    name: 'list_schemas',
    description: 'List all non-system schemas in the currently selected database.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'list_objects',
    description: 'List all database objects (tables, views, materialized views, functions, etc.) in a specific schema.',
    parameters: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'The schema name (defaults to "public").'
        },
        kind: {
          type: 'string',
          description: 'Optional object kind filter.',
          enum: ['table', 'view', 'matview', 'function', 'enum', 'domain', 'sequence']
        }
      },
      required: []
    }
  },
  {
    name: 'get_current_context',
    description: 'Get the connection ID and database name currently targeted by the tool executor.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  // ── Monitoring / performance tools (shared by chat + MCP) ──────────────
  {
    name: 'table_stats',
    description: 'Get size, row-count, activity (scans, inserts/updates/deletes, dead tuples, vacuum/analyze times) and per-column statistics for a specific table.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Fully qualified table reference in format "schema.table" (e.g., "public.orders").'
        }
      },
      required: ['ref']
    }
  },
  {
    name: 'index_usage',
    description: 'Get index usage statistics (scan counts, size, definition, type) for a specific table\'s indexes. Useful for finding unused or missing indexes.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Fully qualified table reference in format "schema.table" (e.g., "public.orders").'
        }
      },
      required: ['ref']
    }
  },
  {
    name: 'list_running_queries',
    description: 'List currently executing (non-idle) queries in the connected database with pid, user, state, wait events, and duration.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'find_blocking_locks',
    description: 'Find lock contention: which queries are blocked waiting on locks and which pids/queries are blocking them.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'slow_queries',
    description: 'List the slowest statements by mean execution time from pg_stat_statements (requires the extension; returns a hint if not installed).',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of statements to return (default 10, max 50).'
        }
      },
      required: []
    }
  },
  {
    name: 'db_health_check',
    description: 'Run a database health overview: size/connection stats, cache hit ratio, tables with dead tuples needing vacuum, active connections, and blocking-lock count. Sections that fail are reported individually; partial results are still returned.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_ddl',
    description: 'Get the DDL / definition of a database object. Views, materialized views, functions, and indexes return their CREATE statement; tables return structured DDL (columns, constraints, indexes).',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Fully qualified reference in format "schema.name" (e.g., "public.orders").'
        },
        kind: {
          type: 'string',
          description: 'Object kind. Defaults to "table".',
          enum: ['table', 'view', 'matview', 'function', 'index']
        }
      },
      required: ['ref']
    }
  },
  {
    name: 'explain_analyze',
    description: 'Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on a SELECT/WITH query inside a read-only transaction that is always rolled back. WARNING: the query actually executes (volatile functions run), so expect real query runtime.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL SELECT or WITH query to execute with EXPLAIN ANALYZE.'
        }
      },
      required: ['sql']
    }
  },
  {
    name: 'analyze_query_plan',
    description: 'Run EXPLAIN (FORMAT JSON) on a SELECT/WITH query and return parsed plan metrics (scan counts, bottlenecks, buffer stats) plus performance recommendations. Set analyze=true to also execute the query for actual timings.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL SELECT or WITH query to analyze.'
        },
        analyze: {
          type: 'boolean',
          description: 'If true, use EXPLAIN ANALYZE (query executes) for actual row counts and timings. Default false.'
        }
      },
      required: ['sql']
    }
  },
  {
    name: 'switch_connection',
    description: 'Programmatically switch the active connection context to a different connection ID and/or database name.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          description: 'The unique ID of the connection to switch to.'
        },
        databaseName: {
          type: 'string',
          description: 'Optional database name to switch to.'
        }
      },
      required: ['connectionId']
    }
  }
];

/** Maps a ToolSpec to OpenAI / Ollama tool format. */
export function mapToOpenAiTools(specs: ToolSpec[]): any[] {
  return specs.map(spec => ({
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters
    }
  }));
}

/** Maps a ToolSpec to Anthropic tool format. */
export function mapToAnthropicTools(specs: ToolSpec[]): any[] {
  return specs.map(spec => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters
  }));
}

/** Maps a ToolSpec to Gemini tool format. */
export function mapToGeminiTools(specs: ToolSpec[]): any[] {
  return specs.map(spec => {
    // Gemini parameters properties require uppercase types (e.g. OBJECT, STRING)
    const properties: Record<string, any> = {};
    for (const [key, prop] of Object.entries(spec.parameters.properties)) {
      properties[key] = {
        type: prop.type.toUpperCase(),
        description: prop.description,
        ...(prop.enum ? { enum: prop.enum } : {})
      };
    }

    return {
      name: spec.name,
      description: spec.description,
      parameters: {
        type: 'OBJECT',
        properties,
        required: spec.parameters.required
      }
    };
  });
}

/** Maps a ToolSpec to VS Code LM LanguageModelChatTool format. */
export function mapToVsCodeLmTools(specs: ToolSpec[]): any[] {
  return specs.map(spec => {
    // vscode.LanguageModelChatTool expects inputSchema to match JSON Schema
    return {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.parameters
    } as any; // Cast as any to avoid strict version mismatch if types differ slightly
  });
}
