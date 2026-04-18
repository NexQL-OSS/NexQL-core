import * as vscode from 'vscode';

/**
 * Saved query with metadata for quick access and reuse
 */
export interface SavedQuery {
  /** Unique identifier */
  id: string;
  /** Query title/name */
  title: string;
  /** SQL query text */
  query: string;
  /** Optional description */
  description?: string;
  /** Tags for organization (e.g., "analytics", "maintenance") */
  tags?: string[];
  /** When created */
  createdAt: number;
  /** When last used */
  lastUsed?: number;
  /** Usage count */
  usageCount: number;
  /** Optional connection preset ID to use with this query */
  preferredProfileId?: string;
  /** Connection context for reopening with same DB */
  connectionId?: string;
  /** Database name to use when opening */
  databaseName?: string;
  /** Schema name for context */
  schemaName?: string;
  /** Set when the query uses `:name` placeholders (detected on save). */
  isTemplate?: boolean;
}

/**
 * Manages saved queries for quick reuse across sessions.
 * Persists in VS Code workspace memento (workspace-local storage).
 */
export class SavedQueriesService {
  private static instance: SavedQueriesService;
  private context: vscode.ExtensionContext | null = null;
  private queries: Map<string, SavedQuery> = new Map();
  private readonly STORAGE_KEY = 'postgres-explorer.savedQueries';

  private constructor() {}

  static getInstance(): SavedQueriesService {
    if (!SavedQueriesService.instance) {
      SavedQueriesService.instance = new SavedQueriesService();
    }
    return SavedQueriesService.instance;
  }

  /**
   * Initialize SavedQueriesService with extension context.
   * Must be called during extension activation.
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.loadQueries();
  }

  /**
   * Load saved queries from workspace memento.
   */
  private loadQueries(): void {
    if (!this.context) {
      return;
    }
    const stored = this.context.workspaceState.get<SavedQuery[]>(this.STORAGE_KEY, []);
    this.queries.clear();
    stored.forEach((query) => {
      this.queries.set(query.id, query);
    });
  }

  /**
   * Save queries to workspace memento.
   */
  private async saveQueries(): Promise<void> {
    if (!this.context) {
      return;
    }
    const queryArray = Array.from(this.queries.values());
    await this.context.workspaceState.update(this.STORAGE_KEY, queryArray);
  }

  /**
   * Save a new query or update existing one.
   */
  async saveQuery(query: SavedQuery): Promise<void> {
    if (!query.id) {
      query.id = this.generateId();
    }
    if (!query.createdAt) {
      query.createdAt = Date.now();
    }
    this.queries.set(query.id, query);
    await this.saveQueries();
  }

  /**
   * Update an existing saved query.
   */
  async updateQuery(query: SavedQuery): Promise<void> {
    if (!query.id) {
      throw new Error('Cannot update query without ID');
    }
    // Preserve original createdAt date
    const existing = this.queries.get(query.id);
    if (existing) {
      query.createdAt = existing.createdAt;
    }
    this.queries.set(query.id, query);
    await this.saveQueries();
  }

  /**
   * Delete a saved query by ID.
   */
  async deleteQuery(queryId: string): Promise<void> {
    this.queries.delete(queryId);
    await this.saveQueries();
  }

  /**
   * Get all saved queries.
   */
  getQueries(): SavedQuery[] {
    return Array.from(this.queries.values()).sort(
      (a, b) => (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt)
    );
  }

  /**
   * Get saved queries filtered by tag.
   */
  getQueriesByTag(tag: string): SavedQuery[] {
    return this.getQueries().filter((q) => q.tags?.includes(tag));
  }

  /**
   * Search saved queries by title or description.
   */
  searchQueries(searchText: string): SavedQuery[] {
    const lower = searchText.toLowerCase();
    return this.getQueries().filter((q) =>
      q.title.toLowerCase().includes(lower) ||
      q.description?.toLowerCase().includes(lower)
    );
  }

  /**
   * Get a saved query by ID.
   */
  getQuery(queryId: string): SavedQuery | undefined {
    return this.queries.get(queryId);
  }

  /**
   * Mark a query as used (updates lastUsed and usageCount).
   */
  async recordUsage(queryId: string): Promise<void> {
    const query = this.queries.get(queryId);
    if (query) {
      query.lastUsed = Date.now();
      query.usageCount = (query.usageCount || 0) + 1;
      await this.saveQueries();
    }
  }

  /**
   * Get most frequently used queries.
   */
  getMostUsedQueries(limit: number = 10): SavedQuery[] {
    return this.getQueries()
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
      .slice(0, limit);
  }

  /**
   * Get recently used queries.
   */
  getRecentQueries(limit: number = 10): SavedQuery[] {
    return this.getQueries()
      .sort((a, b) => (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt))
      .slice(0, limit);
  }

  /**
   * Export all queries as JSON.
   */
  exportQueries(): string {
    return JSON.stringify(Array.from(this.queries.values()), null, 2);
  }

  /**
   * Import queries from JSON.
   */
  async importQueries(jsonData: string): Promise<void> {
    try {
      const imported = JSON.parse(jsonData) as SavedQuery[];
      for (const query of imported) {
        await this.saveQuery(query);
      }
    } catch (error) {
      throw new Error(`Failed to import queries: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all unique tags across all queries.
   */
  getAllTags(): string[] {
    const tags = new Set<string>();
    this.getQueries().forEach((q) => {
      if (q.tags) {
        q.tags.forEach((tag) => tags.add(tag));
      }
    });
    return Array.from(tags).sort();
  }

  /**
   * Generate unique query ID.
   */
  private generateId(): string {
    return `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
