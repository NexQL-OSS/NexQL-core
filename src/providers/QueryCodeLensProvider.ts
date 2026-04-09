import * as vscode from 'vscode';

export interface PillData {
  success: boolean;
  elapsedSeconds?: number;
  rowCount?: number;
}

/**
 * Provides CodeLens actions for SQL queries in notebook cells
 * Detects SELECT queries and offers EXPLAIN and EXPLAIN ANALYZE options
 */
export class QueryCodeLensProvider implements vscode.CodeLensProvider {
  private static _instance: QueryCodeLensProvider | undefined;

  public static getInstance(): QueryCodeLensProvider | undefined {
    return QueryCodeLensProvider._instance;
  }

  public static setInstance(instance: QueryCodeLensProvider): void {
    QueryCodeLensProvider._instance = instance;
  }

  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
  private pillData: Map<string, PillData> = new Map();
  private aiWorkingCells: Set<string> = new Set();

  public setAiWorking(cellUri: string, working: boolean): void {
    if (working) {
      this.aiWorkingCells.add(cellUri);
    } else {
      this.aiWorkingCells.delete(cellUri);
    }
    this._onDidChangeCodeLenses.fire();
  }

  public isAiWorking(cellUri: string): boolean {
    return this.aiWorkingCells.has(cellUri);
  }

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  public updatePill(cellUri: string, data: PillData): void {
    this.pillData.set(cellUri, data);
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
    // Only provide CodeLens for SQL in notebook cells
    if (document.uri.scheme !== 'vscode-notebook-cell') {
      return [];
    }

    if (document.languageId !== 'postgres' && document.languageId !== 'sql') {
      return [];
    }

    const text = document.getText().trim();

    // Don't show CodeLens for empty cells
    if (!text) {
      return [];
    }

    // Check if it's already an EXPLAIN query
    const isExplainQuery = /^\s*EXPLAIN/i.test(text);

    const codeLenses: vscode.CodeLens[] = [];
    const range = new vscode.Range(0, 0, 0, 0);
    const isAiWorking = this.aiWorkingCells.has(document.uri.toString());

    // 1. Ask AI (shows spinner while working)
    codeLenses.push(
      new vscode.CodeLens(range, {
        title: isAiWorking ? '$(loading~spin) Working...' : '✦ Ask AI',
        tooltip: isAiWorking ? 'AI is analyzing your query...' : 'Ask AI to modify this query',
        command: isAiWorking ? '' : 'postgres-explorer.aiAssist',
        arguments: []
      })
    );

    // 2. Chat
    codeLenses.push(
      new vscode.CodeLens(range, {
        title: '◻ Chat',
        tooltip: 'Open SQL Assistant chat with this query',
        command: 'postgres-explorer.chatWithQuery',
        arguments: []
      })
    );

    // 3. Save Query (Always available)
    codeLenses.push(
      new vscode.CodeLens(range, {
        title: '⊞ Save Query',
        tooltip: 'Save this query to the library for easy reuse',
        command: 'postgres-explorer.saveQueryToLibraryUI'
      })
    );

    // Show EXPLAIN options for any query that isn't already EXPLAIN
    if (!isExplainQuery) {
      // 4. EXPLAIN ANALYZE
      codeLenses.push(
        new vscode.CodeLens(range, {
          title: '⟐ Explain Analyze',
          tooltip: 'Show query execution plan with actual runtime statistics',
          command: 'postgres-explorer.explainQuery',
          arguments: [document.uri, true]
        })
      );
    }

    // 5. Execution time pill (shown after execution)
    const pill = this.pillData.get(document.uri.toString());
    if (pill) {
      const pillTitle = pill.success
        ? `${pill.elapsedSeconds}s · ${pill.rowCount} rows`
        : 'failed';
      codeLenses.push(
        new vscode.CodeLens(range, {
          title: pillTitle,
          tooltip: pill.success ? 'Last execution result' : 'Last execution failed',
          command: ''
        })
      );
    }

    return codeLenses;
  }
}
