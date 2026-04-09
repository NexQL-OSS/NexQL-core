import * as vscode from 'vscode';
import type { Pool, PoolConfig } from 'pg';

/** Matches vscode.ProgressLocation.Notification (mock-safe under tsconfig-paths). */
const PROGRESS_NOTIFICATION = 1;
import { IMessageHandler } from '../MessageHandler';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import { ExplainProvider } from '../../providers/ExplainProvider';
import { SecretStorageService } from '../../services/SecretStorageService';
import { PostgresMetadata } from '../../common/types';

export class ExplainErrorHandler implements IMessageHandler {
  constructor(private chatViewProvider: ChatViewProvider | undefined) { }

  async handle(message: any) {
    if (this.chatViewProvider) {
      await this.chatViewProvider.handleExplainError(message.error, message.query);
    }
  }
}

export class FixQueryHandler implements IMessageHandler {
  constructor(private chatViewProvider: ChatViewProvider | undefined) { }

  async handle(message: any) {
    if (this.chatViewProvider) {
      await this.chatViewProvider.handleFixQuery(message.error, message.query);
    }
  }
}

export class AnalyzeDataHandler implements IMessageHandler {
  constructor(private chatViewProvider: ChatViewProvider | undefined) { }

  async handle(message: any) {
    if (this.chatViewProvider) {
      await vscode.commands.executeCommand('postgresExplorer.chatView.focus');
      await this.chatViewProvider.handleAnalyzeData(message.data, message.query, message.rowCount);
    }
  }
}

export class OptimizeQueryHandler implements IMessageHandler {
  constructor(private chatViewProvider: ChatViewProvider | undefined) { }

  async handle(message: any) {
    if (this.chatViewProvider) {
      await vscode.commands.executeCommand('postgresExplorer.chatView.focus');
      await this.chatViewProvider.handleOptimizeQuery(message.query, message.executionTime);
    }
  }
}

export class SendToChatHandler implements IMessageHandler {
  constructor(private chatViewProvider: ChatViewProvider | undefined) { }

  async handle(message: any) {
    if (this.chatViewProvider) {
      await vscode.commands.executeCommand('postgresExplorer.chatView.focus');
      await this.chatViewProvider.sendToChat(message.data);
    }
  }
}

export class ShowExplainPlanHandler implements IMessageHandler {
  constructor(private extensionUri: vscode.Uri) { }

  async handle(message: any) {
    ExplainProvider.show(this.extensionUri, message.plan, message.query);
  }
}

export class ConvertExplainHandler implements IMessageHandler {
  constructor(
    private context: vscode.ExtensionContext,
    private createPool: (config: PoolConfig) => Pool = (config) => {
      const pg = require('pg') as typeof import('pg');
      return new pg.Pool(config);
    }
  ) { }

  async handle(message: any, context: { editor: vscode.NotebookEditor }) {
    if (!context.editor) return;

    // Convert text EXPLAIN to FORMAT JSON and show visual plan
    const originalQuery = message.query;

    if (!originalQuery) {
      vscode.window.showErrorMessage('No query available to convert');
      return;
    }

    // Extract the actual query from EXPLAIN statement
    const explainMatch = originalQuery.match(/^\s*EXPLAIN\s*(?:\([^)]*\))?\s*(.+)$/is);
    const innerQuery = explainMatch ? explainMatch[1].trim() : originalQuery;

    // Create new query with FORMAT JSON
    const jsonQuery = `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS, VERBOSE)\n${innerQuery}`;

    // Execute and show plan
    try {
      const notebook = context.editor.notebook;
      const metadata = notebook.metadata as PostgresMetadata;

      // Get connection config from workspace settings
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const connection = connections.find(c => c.id === metadata.connectionId);

      if (!connection) {
        vscode.window.showErrorMessage('No active database connection');
        return;
      }

      const password = await SecretStorageService.getInstance().getPassword(metadata.connectionId);
      if (!password && connection.authMode === 'password') {
        vscode.window.showErrorMessage('Password not found for connection');
        return;
      }

      // Show progress
      await vscode.window.withProgress({
        location: PROGRESS_NOTIFICATION,
        title: 'Converting EXPLAIN to JSON format...',
        cancellable: false
      }, async () => {
        const client = this.createPool({
          host: connection.host,
          port: connection.port,
          user: connection.username,
          password: password || undefined,
          database: metadata.databaseName,
          ssl: connection.ssl ? { rejectUnauthorized: false } : false
        });

        try {
          const result = await client.query(jsonQuery);

          if (result.rows?.length) {
            const planCell = result.rows[0]['QUERY PLAN'] ?? result.rows[0]['query_plan'];
            if (planCell) {
              const explainPlan = typeof planCell === 'string' ? JSON.parse(planCell) : planCell;
              ExplainProvider.show(this.context.extensionUri, explainPlan, innerQuery);
            } else {
              vscode.window.showErrorMessage('No plan data returned from query');
            }
          } else {
            vscode.window.showErrorMessage('No results returned from EXPLAIN query');
          }
        } finally {
          await client.end();
        }
      });
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to convert EXPLAIN query: ${error.message}`);
      console.error('EXPLAIN conversion error:', error);
    }
  }
}
