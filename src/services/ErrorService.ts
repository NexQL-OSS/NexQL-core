import * as vscode from 'vscode';

export interface IErrorService {
  showError(message: string, actionLabel?: string, actionCommand?: string): Promise<void>;
  handleCommandError(err: any, operation: string): Promise<void>;
}

const PG_ERROR_EXPLANATIONS: Record<string, string> = {
  '42P01': 'Table not found. The specified table does not exist in the current schema.',
  '42703': 'Column not found. The specified column does not exist in the table.',
  '23505': 'Unique constraint violation. A row with this value already exists.',
  '23503': 'Foreign key violation. The referenced row does not exist in the parent table.',
  '23502': 'Not null violation. A required column was not provided a value.',
  '42601': 'Syntax error. The SQL statement contains invalid syntax.',
  '42P02': 'Undefined parameter. A query parameter was referenced but not defined.',
  '08006': 'Connection failure. The connection to the database server was lost.',
  '40001': 'Serialization failure (deadlock). Two transactions conflicted and one was rolled back.',
  '22001': 'String too long. The value exceeds the maximum length for the column.',
  '22003': 'Numeric overflow. The value is outside the allowed range for the numeric type.',
  '42501': 'Insufficient privilege. You do not have permission to perform this operation.',
  '53300': 'Too many connections. The server has reached its maximum number of connections.',
  '57014': 'Query cancelled. The query was cancelled before it completed.',
};

/**
 * Returns a plain-English explanation for a PostgreSQL error code,
 * or undefined if the code is not recognized.
 */
export function getErrorExplanation(code: string): string | undefined {
  return PG_ERROR_EXPLANATIONS[code];
}

export class ErrorService implements IErrorService {
  private static instance: ErrorService;

  private constructor() { }

  public static getInstance(): ErrorService {
    if (!ErrorService.instance) {
      ErrorService.instance = new ErrorService();
    }
    return ErrorService.instance;
  }

  /**
   * Show error with optional action button
   */
  public async showError(message: string, actionLabel?: string, actionCommand?: string): Promise<void> {
    if (actionLabel && actionCommand) {
      const selection = await vscode.window.showErrorMessage(message, actionLabel);
      if (selection === actionLabel) {
        await vscode.commands.executeCommand(actionCommand);
      }
    } else {
      vscode.window.showErrorMessage(message);
    }
  }

  /**
   * Standard error handler for command operations
   */
  public async handleCommandError(err: any, operation: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Status: Failed to ${operation}`, err);
    vscode.window.showErrorMessage(`Failed to ${operation}: ${message}`);
  }
}
