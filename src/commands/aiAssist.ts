import * as vscode from 'vscode';
import { ErrorHandlers, StringUtils } from './helper';
import { ConnectionManager } from '../services/ConnectionManager';
import { PostgresMetadata } from '../common/types';
import { AiService } from '../providers/chat/AiService';
import { SQL_SELF_CHECK_RULE } from '../providers/chat/prompts';
import { QueryCodeLensProvider } from '../providers/QueryCodeLensProvider';

interface TableSchemaInfo {
  tableName: string;
  schemaName: string;
  columns: Array<{
    name: string;
    dataType: string;
    isNullable: boolean;
    defaultValue: string | null;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
    references?: string;
  }>;
  indexes: Array<{
    name: string;
    columns: string[];
    isUnique: boolean;
    isPrimary: boolean;
  }>;
  constraints: Array<{
    name: string;
    type: string;
    definition: string;
  }>;
}

interface CellContext {
  currentQuery: string;
  cellIndex: number;
  previousCells: string[];
  lastOutput?: string;
  tableSchemas: TableSchemaInfo[];
  databaseInfo?: {
    name: string;
    version?: string;
  };
}

export async function cmdAiAssist(cell: vscode.NotebookCell | undefined, context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
  if (!cell) {
    const editor = vscode.window.activeNotebookEditor;
    if (editor?.selection && editor.selection.start < editor.notebook.cellCount) {
      cell = editor.notebook.cellAt(editor.selection.start);
    }
  }

  if (!cell) {
    vscode.window.showErrorMessage('No cell selected');
    return;
  }

  // TypeScript now knows cell is vscode.NotebookCell because of the return above
  const validCell = cell;

  const userInput = await AiTaskSelector.selectTask();
  if (!userInput) {
    return;
  }

  // Apply visual feedback to the cell while AI is working
  const cellUri = validCell.document.uri.toString();
  const codeLensProvider = QueryCodeLensProvider.getInstance();

  // Option 6: CodeLens spinner
  codeLensProvider?.setAiWorking(cellUri, true);

  // Option 3: background tint + animated after-line spinner
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  let activeSpinnerType: vscode.TextEditorDecorationType | null = null;

  const bgDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(99, 179, 237, 0.07)',
  });

  const getCellEditor = () => vscode.window.visibleTextEditors.find(
    e => e.document.uri.toString() === validCell.document.uri.toString()
  );

  const applyBgDecoration = () => {
    const cellEditor = getCellEditor();
    if (!cellEditor) { return; }
    const lineCount = cellEditor.document.lineCount;
    const fullRanges = Array.from({ length: lineCount }, (_, i) =>
      new vscode.Range(i, 0, i, cellEditor.document.lineAt(i).text.length)
    );
    cellEditor.setDecorations(bgDecorationType, fullRanges);
  };

  const updateSpinner = () => {
    const cellEditor = getCellEditor();
    if (!cellEditor) { return; }
    // Clear previous spinner decoration
    if (activeSpinnerType) {
      cellEditor.setDecorations(activeSpinnerType, []);
      activeSpinnerType.dispose();
    }
    // Create new one with updated frame
    activeSpinnerType = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: spinnerFrames[spinnerIndex],
        color: 'rgba(99, 179, 237, 0.9)',
        margin: '0 0 0 12px',
      }
    });
    const lastLine = cellEditor.document.lineCount - 1;
    cellEditor.setDecorations(activeSpinnerType, [
      new vscode.Range(lastLine, 0, lastLine, cellEditor.document.lineAt(lastLine).text.length)
    ]);
  };

  const removeDecorations = () => {
    clearInterval(spinnerInterval);
    const cellEditor = getCellEditor();
    if (cellEditor) {
      cellEditor.setDecorations(bgDecorationType, []);
      if (activeSpinnerType) {
        cellEditor.setDecorations(activeSpinnerType, []);
      }
    }
    bgDecorationType.dispose();
    activeSpinnerType?.dispose();
    activeSpinnerType = null;
    codeLensProvider?.setAiWorking(cellUri, false);
  };

  applyBgDecoration();
  updateSpinner();

  const spinnerInterval = setInterval(() => {
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    updateSpinner();
  }, 100);

  try {
    const config = vscode.workspace.getConfiguration('postgresExplorer');
    const { readAiScopeSettings } = await import('../features/aiAssistant/aiConfig');
    const notebookSettings = readAiScopeSettings(config, 'notebook');
    const provider = notebookSettings.provider;

    const aiService = new AiService();
    const modelInfo = await aiService.getModelInfo(provider, config, 'notebook');

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `AI (${modelInfo}) is analyzing your query...`,
      cancellable: true
    }, async (progress, token) => {

      progress.report({ message: "Gathering context..." });
      const cellContext = await gatherCellContext(validCell, context, outputChannel);

      progress.report({ message: "Generating response..." });

      const systemPrompt = buildPrompt(userInput, cellContext);
      const userTrigger = "Please provide the SQL query based on the instructions above.";

      const result = await aiService.callProvider(provider, userTrigger, config, systemPrompt, 'notebook');
      const responseText = result.text;
      const { query, placement } = parseAiResponse(responseText);
      const cleanedQuery = StringUtils.cleanMarkdownCodeBlocks(query);

      if (cleanedQuery.trim()) {
        if (placement === 'new_cell') {
          const notebook = validCell.notebook;
          const targetIndex = validCell.index + 1;
          const newCellData = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            cleanedQuery,
            'sql'
          );
          const notebookEdit = new vscode.NotebookEdit(
            new vscode.NotebookRange(targetIndex, targetIndex),
            [newCellData]
          );

          const workspaceEdit = new vscode.WorkspaceEdit();
          workspaceEdit.set(notebook.uri, [notebookEdit]);
          await vscode.workspace.applyEdit(workspaceEdit);

          vscode.window.showInformationMessage(`AI (${modelInfo}) added response as new cell.`);
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            validCell.document.uri,
            new vscode.Range(0, 0, validCell.document.lineCount, 0),
            cleanedQuery
          );
          await vscode.workspace.applyEdit(edit);

          vscode.window.showInformationMessage(`AI (${modelInfo}) updated cell content.`);
        }
      }
    });

    removeDecorations();

  } catch (error) {
    removeDecorations();

    console.error('AI Assist Error:', error);
    const message = error instanceof Error ? error.message : String(error);
    await ErrorHandlers.showError(
      `AI Assist failed: ${message}`,
      'Configure Settings',
      'workbench.action.openSettings'
    );
  }
}

async function gatherCellContext(cell: vscode.NotebookCell, context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Promise<CellContext> {
  const currentQuery = cell.document.getText();
  const idx = cell.index;

  const previousCells: string[] = [];
  for (let i = Math.max(0, idx - 5); i < idx; i++) {
    const prevCell = cell.notebook.cellAt(i);
    if (prevCell.kind === vscode.NotebookCellKind.Code) {
      previousCells.push(prevCell.document.getText());
    }
  }

  let lastOutput: string | undefined;
  if (cell.outputs && cell.outputs.length > 0) {
    const lastOutputItem = cell.outputs[cell.outputs.length - 1];
    if (lastOutputItem.items && lastOutputItem.items.length > 0) {
      const outputItem = lastOutputItem.items[0];
      if (outputItem.mime === 'application/x-postgres-result') {
        try {
          const data = JSON.parse(new TextDecoder().decode(outputItem.data));
          if (data.rows && data.columns) {
            const totalRows = data.rows.length;
            const maxSampleRows = 5; // Limit sample rows for context
            const maxColumns = 20; // Limit columns to avoid token bloat

            // Truncate columns if too many
            const displayColumns = data.columns.length > maxColumns
              ? [...data.columns.slice(0, maxColumns), `... and ${data.columns.length - maxColumns} more columns`]
              : data.columns;

            // Only include sample rows if total is reasonable (< 1000 rows)
            // For very large result sets, just show metadata
            if (totalRows > 1000) {
              lastOutput = `Query returned ${totalRows} rows (large result set - sample omitted)\nColumns (${data.columns.length}): ${displayColumns.join(', ')}`;
            } else if (totalRows > 100) {
              // For medium result sets, show fewer sample rows
              const sampleRows = data.rows.slice(0, 3);
              // Truncate each row's values to avoid huge JSON
              const truncatedSamples = sampleRows.map((row: any) => {
                const truncated: any = {};
                const cols = data.columns.slice(0, maxColumns);
                for (const col of cols) {
                  const val = row[col];
                  if (typeof val === 'string' && val.length > 100) {
                    truncated[col] = val.substring(0, 100) + '... (truncated)';
                  } else {
                    truncated[col] = val;
                  }
                }
                return truncated;
              });
              lastOutput = `Columns (${data.columns.length}): ${displayColumns.join(', ')}\nSample data (showing 3 of ${totalRows} rows):\n${JSON.stringify(truncatedSamples, null, 2)}`;
            } else {
              // For small result sets, show more samples
              const sampleRows = data.rows.slice(0, maxSampleRows);
              const truncatedSamples = sampleRows.map((row: any) => {
                const truncated: any = {};
                const cols = data.columns.slice(0, maxColumns);
                for (const col of cols) {
                  const val = row[col];
                  if (typeof val === 'string' && val.length > 200) {
                    truncated[col] = val.substring(0, 200) + '... (truncated)';
                  } else {
                    truncated[col] = val;
                  }
                }
                return truncated;
              });
              lastOutput = `Columns (${data.columns.length}): ${displayColumns.join(', ')}\nSample data (showing ${sampleRows.length} of ${totalRows} rows):\n${JSON.stringify(truncatedSamples, null, 2)}`;
            }
          } else if (data.command) {
            lastOutput = `Command: ${data.command}, Rows affected: ${data.rowCount || 0}`;
          }
        } catch (e) {
          outputChannel.appendLine('Failed to parse cell output: ' + e);
        }
      }
    }
  }
  const tableSchemas: TableSchemaInfo[] = [];
  const tableNames = extractTableNames(currentQuery);

  if (tableNames.length > 0) {
    try {
      const metadata = cell.notebook.metadata as PostgresMetadata;
      if (metadata?.connectionId) {
        const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
        const connection = connections.find(c => c.id === metadata.connectionId);

        if (connection) {
          let client;
          try {
            client = await ConnectionManager.getInstance().getPooledClient({
              id: connection.id,
              host: connection.host,
              port: connection.port,
              username: connection.username,
              database: metadata.databaseName || connection.database,
              name: connection.name
            });

            for (const tableName of tableNames) {
              try {
                const schema = await fetchTableSchema(client, tableName);
                if (schema) {
                  tableSchemas.push(schema);
                }
              } catch (e) {
                outputChannel.appendLine(`Failed to fetch schema for ${tableName}: ${e}`);
              }
            }
          } finally {
            if (client) client.release();
          }
        }
      }
    } catch (e) {
      outputChannel.appendLine('Failed to connect for schema fetch: ' + e);
    }
  }
  let databaseInfo: { name: string; version?: string } | undefined;
  try {
    const metadata = cell.notebook.metadata as PostgresMetadata;
    if (metadata?.databaseName) databaseInfo = { name: metadata.databaseName };
  } catch { }

  return {
    currentQuery,
    cellIndex: idx,
    previousCells,
    lastOutput,
    tableSchemas,
    databaseInfo
  };
}

function parseAiResponse(response: string): { query: string; placement: 'replace' | 'new_cell' } {
  const lines = response.trim().split('\n');
  let placement: 'replace' | 'new_cell' = 'replace';
  const queryLines: string[] = [];
  const placementRegex = /\[PLACEMENT:\s*(new_cell|replace)\]/i;

  for (const line of lines) {
    const match = line.match(placementRegex);
    if (match) {
      placement = match[1].toLowerCase() as 'replace' | 'new_cell';
    } else {
      queryLines.push(line);
    }
  }

  const commentPlacementRegex = /--\s*PLACEMENT:\s*(new_cell|replace)/i;
  const filteredLines: string[] = [];

  for (const line of queryLines) {
    const match = line.match(commentPlacementRegex);
    if (match) {
      placement = match[1].toLowerCase() as 'replace' | 'new_cell';
    } else {
      filteredLines.push(line);
    }
  }

  return {
    query: filteredLines.join('\n').trim(),
    placement
  };
}

function extractTableNames(query: string): Array<{ schema: string; table: string }> {
  const tables: Array<{ schema: string; table: string }> = [];
  const patterns = [
    // FROM/JOIN clause: FROM schema.table or FROM table
    /(?:FROM|JOIN)\s+(?:"?(\w+)"?\.)?"?(\w+)"?(?:\s+(?:AS\s+)?\w+)?/gi,
    // UPDATE table
    /UPDATE\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi,
    // INSERT INTO table
    /INSERT\s+INTO\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi,
    // DELETE FROM table
    /DELETE\s+FROM\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi,
    // CREATE TABLE / ALTER TABLE / DROP TABLE
    /(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi,
    // TRUNCATE table
    /TRUNCATE\s+(?:TABLE\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      const schema = match[1] || 'public';
      const table = match[2];

      // Avoid duplicates and SQL keywords
      const sqlKeywords = ['select', 'from', 'where', 'and', 'or', 'not', 'null', 'true', 'false', 'as', 'on', 'in', 'is', 'like', 'between', 'exists', 'case', 'when', 'then', 'else', 'end'];
      if (table && !sqlKeywords.includes(table.toLowerCase()) && !tables.some(t => t.schema === schema && t.table === table)) {
        tables.push({ schema, table });
      }
    }
  }

  return tables;
}

async function fetchTableSchema(client: any, tableRef: { schema: string; table: string }): Promise<TableSchemaInfo | null> {
  const { schema, table } = tableRef;
  const columnsResult = await client.query(`
        SELECT 
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
            CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
            fk.foreign_table_schema || '.' || fk.foreign_table_name || '(' || fk.foreign_column_name || ')' as references_to
        FROM information_schema.columns c
        LEFT JOIN (
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu 
                ON tc.constraint_name = kcu.constraint_name 
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_schema = $1
                AND tc.table_name = $2
        ) pk ON c.column_name = pk.column_name
        LEFT JOIN (
            SELECT 
                kcu.column_name,
                ccu.table_schema as foreign_table_schema,
                ccu.table_name as foreign_table_name,
                ccu.column_name as foreign_column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu 
                ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage ccu 
                ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = $1
                AND tc.table_name = $2
        ) fk ON c.column_name = fk.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
    `, [schema, table]);
  if (columnsResult.rows.length === 0) return null;
  const indexesResult = await client.query(`
        SELECT 
            i.relname as index_name,
            array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns,
            ix.indisunique as is_unique,
            ix.indisprimary as is_primary
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname = $1 AND t.relname = $2
        GROUP BY i.relname, ix.indisunique, ix.indisprimary
    `, [schema, table]);
  const constraintsResult = await client.query(`
        SELECT 
            tc.constraint_name,
            tc.constraint_type,
            pg_get_constraintdef(c.oid) as definition
        FROM information_schema.table_constraints tc
        JOIN pg_constraint c ON c.conname = tc.constraint_name
        JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = tc.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name = $2
    `, [schema, table]);

  return {
    tableName: table,
    schemaName: schema,
    columns: columnsResult.rows.map((row: any) => ({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      isPrimaryKey: row.is_primary_key,
      isForeignKey: row.is_foreign_key,
      references: row.is_foreign_key ? row.references_to : undefined
    })),
    indexes: indexesResult.rows.map((row: any) => ({
      name: row.index_name,
      columns: row.columns,
      isUnique: row.is_unique,
      isPrimary: row.is_primary
    })),
    constraints: constraintsResult.rows.map((row: any) => ({
      name: row.constraint_name,
      type: row.constraint_type,
      definition: row.definition
    }))
  };
}

function buildPrompt(userInput: string, cellContext: CellContext): string {
  const { currentQuery, previousCells, lastOutput, tableSchemas, databaseInfo } = cellContext;
  // Build table schema context
  let schemaContext = '';
  if (tableSchemas.length > 0) {
    schemaContext = '\n\n## Table Schemas Referenced in Query\n';
    for (const schema of tableSchemas) {
      schemaContext += `\n### Table: ${schema.schemaName}.${schema.tableName}\n`;
      schemaContext += '**Columns:**\n';
      schemaContext += '| Column | Type | Nullable | Default | PK | FK | References |\n';
      schemaContext += '|--------|------|----------|---------|----|----|------------|\n';
      for (const col of schema.columns) {
        schemaContext += `| ${col.name} | ${col.dataType} | ${col.isNullable ? 'YES' : 'NO'} | ${col.defaultValue || '-'} | ${col.isPrimaryKey ? '✓' : ''} | ${col.isForeignKey ? '✓' : ''} | ${col.references || '-'} |\n`;
      }

      if (schema.indexes.length > 0) {
        schemaContext += '\n**Indexes:**\n';
        for (const idx of schema.indexes) {
          const columnsStr = Array.isArray(idx.columns) ? idx.columns.join(', ') : String(idx.columns || '');
          schemaContext += `- ${idx.name}: (${columnsStr}) ${idx.isUnique ? '[UNIQUE]' : ''} ${idx.isPrimary ? '[PRIMARY]' : ''}\n`;
        }
      }

      if (schema.constraints.length > 0) {
        schemaContext += '\n**Constraints:**\n';
        for (const con of schema.constraints) {
          schemaContext += `- ${con.name} (${con.type}): ${con.definition}\n`;
        }
      }
    }
  }

  let previousContext = '';
  if (previousCells.length > 0) {
    previousContext = '\n\n## Previous Queries in Notebook (for context)\n```sql\n';
    previousContext += previousCells.slice(-3).join('\n\n-- Next query --\n');
    previousContext += '\n```';
  }
  let outputContext = '';
  if (lastOutput) outputContext = `\n\n## Last Execution Output\n\`\`\`\n${lastOutput}\n\`\`\``;
  let dbContext = '';
  if (databaseInfo) dbContext = `\n\n## Database: ${databaseInfo.name}`;

  return `# PostgreSQL Query Assistant

You are an expert PostgreSQL database developer and query optimizer. Your task is to help modify, optimize, or explain SQL queries based on the user's instructions.

## Important Guidelines

1. **Output Format**: Return ONLY the modified SQL query. Do not use markdown code fences (\`\`\`sql).
2. **Comments**: If you need to explain something, use SQL comments (-- or /* */).
3. **Preserve Intent**: Maintain the original query's purpose while applying the requested changes.
4. **Best Practices**: Follow PostgreSQL best practices for:
   - Proper quoting of identifiers when necessary
   - Efficient JOIN ordering
   - Appropriate use of indexes (check the schema info provided)
   - Avoiding SQL injection vulnerabilities (use parameterized queries when showing examples)
   - Proper NULL handling
   - Using appropriate data types
5. **Error Prevention**: If the original query has potential issues, fix them while applying the user's request.
6. **Schema Awareness**: Use the provided table schema information to:
   - Reference correct column names and types
   - Leverage existing indexes for better performance
   - Respect foreign key relationships
   - Understand nullability constraints
7. **Self-check (P1.7)**: ${SQL_SELF_CHECK_RULE}

## Placement Decision

At the very first line of your response, you MUST include a placement instruction to indicate whether the result should replace the original query or be added as a new cell for comparison:

- Use \`[PLACEMENT: replace]\` when:
  - Fixing syntax errors or bugs in the original query
  - Formatting or beautifying the query
  - Making minor modifications that improve the original
  - The user explicitly asks to "fix", "correct", or "format" the query

- Use \`[PLACEMENT: new_cell]\` when:
  - Creating a significantly different version of the query
  - Adding EXPLAIN ANALYZE or debugging versions
  - Generating INSERT/UPDATE/DELETE from a SELECT
  - Converting to a completely different structure (CTE, subquery, etc.)
  - The user might want to compare both versions
  - Adding explanatory comments that substantially change the query length
  - Creating alternative approaches to solve the same problem
${dbContext}${schemaContext}${previousContext}${outputContext}

## Current Query to Modify
\`\`\`sql
${currentQuery}
\`\`\`

## User Request
${userInput}

## Your Response
First line MUST be the placement instruction (e.g., [PLACEMENT: replace] or [PLACEMENT: new_cell]).
Then provide the SQL query. Remember: NO markdown formatting, just the raw SQL (you may include SQL comments for explanations).
`;
}

const AiTaskSelector = {
  tasks: [
    // Custom - Always First
    { label: '$(edit) Custom Instruction', description: 'Enter your own instruction', detail: 'Tell the AI exactly what you want to do with this query' },

    // Separator
    { label: '', kind: vscode.QuickPickItemKind.Separator },

    // Core Commands (Most Used)
    { label: '$(comment-discussion) Explain', description: 'Add comments explaining the query', detail: 'Adds inline comments explaining each clause' },
    { label: '$(bug) Fix Syntax Errors', description: 'Correct syntax mistakes', detail: 'Fixes missing keywords, brackets, quotes, typos' },
    { label: '$(warning) Fix Logic Issues', description: 'Fix logical problems', detail: 'Corrects JOINs, conditions, NULL handling, duplicates' },
    { label: '$(rocket) Optimize', description: 'Improve performance', detail: 'Rewrites for better execution plan' },
    { label: '$(telescope) Suggest Indexes', description: 'Recommend indexes', detail: 'Suggests CREATE INDEX statements for this query' },
    { label: '$(list-flat) Format', description: 'Beautify and standardize', detail: 'Applies consistent indentation, casing, line breaks' },

    // Separator
    { label: '', kind: vscode.QuickPickItemKind.Separator },

    // Conversions
    { label: '$(table) Convert to CTE', description: 'Refactor using WITH clauses', detail: 'Converts subqueries to Common Table Expressions' },
    { label: '$(refresh) Convert to View', description: 'Create VIEW from query', detail: 'Wraps query in CREATE OR REPLACE VIEW' },
    { label: '$(symbol-function) Convert to Function', description: 'Create Function from query', detail: 'Wraps query in CREATE OR REPLACE FUNCTION' }
  ],
  async selectTask(): Promise<string | undefined> {
    const selection = await vscode.window.showQuickPick(this.tasks, {
      placeHolder: 'Select an AI task or enter custom instruction',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    });

    if (!selection || selection.kind === vscode.QuickPickItemKind.Separator) {
      return undefined;
    }

    if (selection.label.includes('Custom Instruction')) {
      return await vscode.window.showInputBox({
        placeHolder: 'e.g., "Add pagination", "Filter by date", "Uppercase keywords"',
        prompt: 'Enter your specific instruction for the AI',
        ignoreFocusOut: true
      });
    }

    return selection.label.replace(/\$\([a-z-]+\)\s/, ''); // Return clean label as instruction
  }
};
