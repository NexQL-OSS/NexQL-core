import * as vscode from 'vscode';

export interface QueryHistoryItem {
  id: string;
  query: string;
  timestamp: number;
  success: boolean;
  duration?: number;
  durationMs?: number;
  rowCount?: number;
  connectionName?: string;
  connectionId?: string;
  databaseName?: string;
  slow?: boolean;
}

export class QueryHistoryService {
  private static instance: QueryHistoryService;
  private storage: vscode.Memento;
  private readonly STORAGE_KEY = 'postgres-explorer.queryHistory';

  private _onDidChangeHistory = new vscode.EventEmitter<void>();
  public readonly onDidChangeHistory = this._onDidChangeHistory.event;

  private constructor(storage: vscode.Memento) {
    this.storage = storage;
  }

  private get maxItems(): number {
    const v = vscode.workspace.getConfiguration().get<number>('postgresExplorer.queryHistory.maxItems', 200);
    return Math.max(10, Math.min(1000, v));
  }

  public static initialize(storage: vscode.Memento): void {
    if (!QueryHistoryService.instance) {
      QueryHistoryService.instance = new QueryHistoryService(storage);
    }
  }

  public static getInstance(): QueryHistoryService {
    if (!QueryHistoryService.instance) {
      throw new Error('QueryHistoryService not initialized');
    }
    return QueryHistoryService.instance;
  }

  public getHistory(): QueryHistoryItem[] {
    return this.storage.get<QueryHistoryItem[]>(this.STORAGE_KEY, []);
  }

  /** History entries scoped to a single connection (newest first). */
  public getByConnection(connectionId: string): QueryHistoryItem[] {
    return this.getHistory().filter(h => h.connectionId === connectionId);
  }

  public async add(item: Omit<QueryHistoryItem, 'id' | 'timestamp'>): Promise<void> {
    const history = this.getHistory();
    const newItem: QueryHistoryItem = {
      ...item,
      id: this.generateId(),
      timestamp: Date.now()
    };

    // Add to beginning
    history.unshift(newItem);

    // Trim oldest entries for this connection (or global if no connectionId)
    const limit = this.maxItems;
    if (newItem.connectionId && newItem.databaseName) {
      // Walk newest-first; keep first `limit` entries for this (connection, db) pair, remove the rest
      let seen = 0;
      for (let i = 0; i < history.length; ) {
        if (history[i].connectionId === newItem.connectionId && history[i].databaseName === newItem.databaseName) {
          seen++;
          if (seen > limit) {
            history.splice(i, 1);
            continue;
          }
        }
        i++;
      }
    } else {
      // Legacy entries without connectionId/databaseName — global cap at limit * 10 to avoid unbounded growth
      if (history.length > limit * 10) {
        history.splice(limit * 10);
      }
    }

    await this.storage.update(this.STORAGE_KEY, history);
    this._onDidChangeHistory.fire();
  }

  public async clear(): Promise<void> {
    await this.storage.update(this.STORAGE_KEY, []);
    this._onDidChangeHistory.fire();
  }

  public async delete(id: string): Promise<void> {
    const history = this.getHistory();
    const newHistory = history.filter(item => item.id !== id);
    await this.storage.update(this.STORAGE_KEY, newHistory);
    this._onDidChangeHistory.fire();
  }

  /**
   * Trend stats for recent query history
   */
  public getTrendStats(): { avgMs: number; successRate: number; slowRate: number; total: number } {
    const history = this.getHistory();
    if (history.length === 0) {
      return { avgMs: 0, successRate: 0, slowRate: 0, total: 0 };
    }

    const total = history.length;
    const avgMs = history.reduce((sum, h) => sum + (h.durationMs ?? (h.duration ? h.duration * 1000 : 0)), 0) / total;
    const successRate = history.filter(h => h.success).length / total;
    const slowRate = history.filter(h => h.slow).length / total;

    return { avgMs, successRate, slowRate, total };
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
}
