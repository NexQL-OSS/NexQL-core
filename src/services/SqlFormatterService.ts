/**
 * SqlFormatterService.ts
 * Wraps the sql-formatter library with PostgreSQL dialect and VS Code configuration.
 */

import * as vscode from 'vscode';
import { SqlFormatterConfig } from '../common/types';

// Lazy import to avoid loading sql-formatter on extension activate
let formatFn: ((sql: string, opts: any) => string) | null = null;

async function getFormatter(): Promise<(sql: string, opts: any) => string> {
  if (formatFn) { return formatFn; }
  // Dynamic import handles both ESM and CommonJS builds
  try {
    const mod = await import('sql-formatter');
    formatFn = mod.format;
    return formatFn!;
  } catch {
    // Fallback if import fails
    throw new Error('sql-formatter is not available. Run: npm install sql-formatter');
  }
}

export class SqlFormatterService {
  private static instance: SqlFormatterService;

  static getInstance(): SqlFormatterService {
    if (!SqlFormatterService.instance) {
      SqlFormatterService.instance = new SqlFormatterService();
    }
    return SqlFormatterService.instance;
  }

  getConfig(): SqlFormatterConfig {
    const cfg = vscode.workspace.getConfiguration('postgresExplorer.formatter');
    return {
      keywordCase: cfg.get<'upper' | 'lower' | 'preserve'>('keywordCase', 'upper'),
      indentStyle: cfg.get<'standard' | 'tabularLeft' | 'tabularRight'>('indentStyle', 'standard'),
      tabWidth: cfg.get<number>('tabWidth', 2),
      useTabs: cfg.get<boolean>('useTabs', false),
      linesBetweenQueries: cfg.get<number>('linesBetweenQueries', 1),
      formatOnSave: cfg.get<boolean>('formatOnSave', false),
    };
  }

  async format(sql: string, overrides?: Partial<SqlFormatterConfig>): Promise<string> {
    const config = { ...this.getConfig(), ...overrides };
    const format = await getFormatter();

    return format(sql, {
      language: 'postgresql',
      keywordCase: config.keywordCase,
      indentStyle: config.indentStyle,
      tabWidth: config.tabWidth,
      useTabs: config.useTabs,
      linesBetweenQueries: config.linesBetweenQueries,
    });
  }

  async formatDocument(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
    const text = document.getText();
    try {
      const formatted = await this.format(text);
      if (formatted === text) { return []; }
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length)
      );
      return [vscode.TextEdit.replace(fullRange, formatted)];
    } catch (err) {
      vscode.window.showErrorMessage(`SQL formatter error: ${(err as Error).message}`);
      return [];
    }
  }
}
