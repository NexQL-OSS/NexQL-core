import * as vscode from 'vscode';
import type { Pool, PoolConfig } from 'pg';

/** Matches vscode.ProgressLocation.Notification (mock-safe under tsconfig-paths). */
const PROGRESS_NOTIFICATION = 1;
import { IMessageHandler } from '../MessageHandler';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import { SecretStorageService } from '../../services/SecretStorageService';
import { PostgresMetadata } from '../../common/types';
import { PlanStoreWorkspace } from '../../features/planStudio/PlanStoreWorkspace';
import { PlanStudioPanel } from '../../features/planStudio/PlanStudioPanel';
import { requirePro, ProFeature } from '../../services/featureGates';
import { ConnectionManager } from '../../services/ConnectionManager';

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
    // Focus is handled deterministically by AssistantGateway/ChatSurfaceRegistry — no explicit focus here.
    if (this.chatViewProvider) {
      await this.chatViewProvider.handleAnalyzeData(message.data, message.query, message.rowCount);
    }
  }
}

export class OptimizeQueryHandler implements IMessageHandler {
  constructor(private chatViewProvider: ChatViewProvider | undefined) { }

  async handle(message: any) {
    if (this.chatViewProvider) {
      await this.chatViewProvider.handleOptimizeQuery(message.query, message.executionTime);
    }
  }
}

export class SendToChatHandler implements IMessageHandler {
  constructor(private chatViewProvider: ChatViewProvider | undefined) { }

  async handle(message: any) {
    if (this.chatViewProvider) {
      await this.chatViewProvider.sendToChat(message.data);
    }
  }
}

export class ShowExplainPlanHandler implements IMessageHandler {
  constructor(
    private extensionUri: vscode.Uri,
    private planStore: PlanStoreWorkspace
  ) { }

  async handle(message: any, context?: { editor?: vscode.NotebookEditor }) {
    if (!(await requirePro(ProFeature.ExplainStudio))) return;
    const metadata = context?.editor?.notebook?.metadata as PostgresMetadata | undefined;
    PlanStudioPanel.show(this.extensionUri, this.planStore, {
      plan: message.plan,
      query: message.query,
      connectionId: metadata?.connectionId,
      databaseName: metadata?.databaseName,
      source: 'notebook',
      sourceCellIndex: typeof message.sourceCellIndex === 'number' ? message.sourceCellIndex : undefined,
      performanceAnalysis: message.performanceAnalysis,
      notebookUri: context?.editor?.notebook?.uri?.toString(),
    });
  }
}

export class ConvertExplainHandler implements IMessageHandler {
  constructor(
    private context: vscode.ExtensionContext,
    private planStore: PlanStoreWorkspace,
    private createPool: (config: PoolConfig) => Pool = (config) => {
      const pg = require('pg') as typeof import('pg');
      return new pg.Pool(config);
    }
  ) { }

  async handle(message: any, context: { editor: vscode.NotebookEditor; postMessage?: (message: unknown) => Thenable<boolean> }) {
    if (!context.editor) return;

    // Convert text EXPLAIN to FORMAT JSON and show visual plan
    const originalQuery = message.query;

    if (!originalQuery) {
      vscode.window.showErrorMessage('No query available to convert');
      return;
    }

    // Extract the actual SQL statement after EXPLAIN options.
    // Supports:
    // - EXPLAIN SELECT ...
    // - EXPLAIN ANALYZE SELECT ...
    // - EXPLAIN (ANALYZE, BUFFERS) SELECT ...
    const extractInnerQuery = (query: string): string => {
      const src = query.trim();
      const explainPrefix = src.match(/^EXPLAIN\b/i);
      if (!explainPrefix) {
        return src;
      }

      let i = explainPrefix[0].length;
      const len = src.length;
      const skipWs = () => {
        while (i < len && /\s/.test(src[i])) i++;
      };

      skipWs();

      // Optional parenthesized options: EXPLAIN (...)
      if (src[i] === '(') {
        let depth = 0;
        while (i < len) {
          const ch = src[i];
          if (ch === '(') depth++;
          if (ch === ')') {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
      } else {
        // Legacy option tokens before the actual statement.
        const optionTokens = new Set([
          'ANALYZE',
          'ANALYSE',
          'VERBOSE',
          'COSTS',
          'SETTINGS',
          'BUFFERS',
          'WAL',
          'TIMING',
          'SUMMARY',
          'FORMAT',
          'TRUE',
          'FALSE',
          'TEXT',
          'XML',
          'JSON',
          'YAML',
          'ON',
          'OFF'
        ]);

        while (i < len) {
          skipWs();
          const tokenMatch = src.slice(i).match(/^([A-Za-z_]+)/);
          if (!tokenMatch) {
            break;
          }
          const token = tokenMatch[1].toUpperCase();
          if (!optionTokens.has(token)) {
            break;
          }
          i += tokenMatch[1].length;
        }
      }

      skipWs();
      return src.slice(i).trim();
    };

    const innerQuery = extractInnerQuery(originalQuery);

    if (!innerQuery) {
      vscode.window.showErrorMessage('Could not extract query after EXPLAIN');
      return;
    }

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
        const connectionConfig = {
          ...connection,
          database: metadata.databaseName || connection.database
        };
        const client = await ConnectionManager.getInstance().getPooledClient(connectionConfig);

        try {
          const result = await client.query(jsonQuery);

          if (result.rows?.length) {
            const planCell = result.rows[0]['QUERY PLAN'] ?? result.rows[0]['query_plan'];
            if (planCell) {
              const explainPlan = typeof planCell === 'string' ? JSON.parse(planCell) : planCell;
              const saved = this.planStore.savePlan({
                query: innerQuery,
                connectionId: metadata.connectionId,
                databaseName: metadata.databaseName,
                plan: explainPlan,
                source: 'converted',
                notebookUri: context.editor.notebook.uri.toString(),
                sourceCellIndex: typeof message.sourceCellIndex === 'number' ? message.sourceCellIndex : undefined,
              });
              this.planStore.linkPlanToNotebook(context.editor.notebook.uri.toString(), saved.id);
              await context.postMessage?.({
                type: 'explainJsonConverted',
                explainPlan,
                query: innerQuery,
                sourceCellIndex: typeof message.sourceCellIndex === 'number' ? message.sourceCellIndex : undefined,
                planId: saved.id,
              });

              if (message?.openInPlanStudio === true) {
                PlanStudioPanel.show(this.context.extensionUri, this.planStore, {
                plan: explainPlan,
                query: innerQuery,
                connectionId: metadata.connectionId,
                databaseName: metadata.databaseName,
                source: 'converted',
                sourceCellIndex: typeof message.sourceCellIndex === 'number' ? message.sourceCellIndex : undefined,
                notebookUri: context.editor.notebook.uri.toString(),
                });
              }
            } else {
              vscode.window.showErrorMessage('No plan data returned from query');
            }
          } else {
            vscode.window.showErrorMessage('No results returned from EXPLAIN query');
          }
        } finally {
          client.release();
        }
      });
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to convert EXPLAIN query: ${error.message}`);
      console.error('EXPLAIN conversion error:', error);
    }
  }
}

export class OpenPlanStudioHandler implements IMessageHandler {
  constructor(
    private extensionUri: vscode.Uri,
    private planStore: PlanStoreWorkspace
  ) { }

  async handle(message: any, context?: { editor?: vscode.NotebookEditor }) {
    if (!(await requirePro(ProFeature.ExplainStudio))) return;
    const metadata = context?.editor?.notebook?.metadata as PostgresMetadata | undefined;
    PlanStudioPanel.show(this.extensionUri, this.planStore, {
      plan: message.plan,
      query: message.query,
      connectionId: metadata?.connectionId,
      databaseName: metadata?.databaseName,
      source: 'notebook',
      sourceCellIndex: typeof message.sourceCellIndex === 'number' ? message.sourceCellIndex : undefined,
      performanceAnalysis: message.performanceAnalysis,
      notebookUri: context?.editor?.notebook?.uri?.toString(),
    });
  }
}

export class SyncPlanStudioFromRunHandler implements IMessageHandler {
  constructor(
    private extensionUri: vscode.Uri,
    private planStore: PlanStoreWorkspace
  ) { }

  async handle(message: any, context?: { editor?: vscode.NotebookEditor }) {
    const metadata = context?.editor?.notebook?.metadata as PostgresMetadata | undefined;
    PlanStudioPanel.syncIfOpen(this.extensionUri, this.planStore, {
      plan: message.plan,
      query: message.query,
      connectionId: metadata?.connectionId,
      databaseName: metadata?.databaseName,
      source: 'notebook',
      sourceCellIndex: typeof message.sourceCellIndex === 'number' ? message.sourceCellIndex : undefined,
      performanceAnalysis: message.performanceAnalysis,
      notebookUri: context?.editor?.notebook?.uri?.toString(),
    });
  }
}
