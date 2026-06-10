import * as vscode from 'vscode';
import { TelemetryService } from '../../services/TelemetryService';
import { isProFeatureEnabled, ProFeature } from '../../services/featureGates';
import { recordSyncActivity } from '../sync/SyncActivityLog';
import { triggerInstantSync } from '../sync/syncTriggers';

const FREE_SAVED_QUERIES_LIMIT = 5;

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
  /** When last modified */
  updatedAt?: number;
  /** Monotonic revision for sync conflict resolution */
  revision?: number;
  /** Tombstone marker for sync deletes */
  deleted?: boolean;
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

export interface SavedQueryImportResult {
  imported: number;
  updated: number;
  skipped: number;
}

/**
 * Manages saved queries for quick reuse across sessions.
 * Persists in VS Code global memento (cross-workspace storage).
 */
export class SavedQueriesService {
  private static instance: SavedQueriesService;
  private context: vscode.ExtensionContext | null = null;
  private queries: Map<string, SavedQuery> = new Map();
  private tombstones: SavedQuery[] = [];
  private readonly STORAGE_KEY = 'postgres-explorer.savedQueries';
  private readonly LEGACY_WORKSPACE_KEY = 'postgres-explorer.savedQueries';
  private readonly MIGRATION_KEY = 'postgres-explorer.savedQueries.migratedToGlobal';

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
   * Load saved queries from global memento, migrating legacy workspace data once.
   */
  private loadQueries(): void {
    if (!this.context) {
      return;
    }
    void this.migrateFromWorkspaceState();
    const stored = this.context.globalState.get<SavedQuery[]>(this.STORAGE_KEY, []);
    this.queries.clear();
    stored.forEach((query) => {
      const normalized = this.normalizeQuery(query);
      if (normalized.deleted) {
        this.tombstones.push(normalized);
      } else {
        this.queries.set(normalized.id, normalized);
      }
    });
  }

  private async migrateFromWorkspaceState(): Promise<void> {
    if (!this.context) {
      return;
    }
    const migrated = this.context.globalState.get<boolean>(this.MIGRATION_KEY, false);
    if (migrated) {
      return;
    }
    const legacy = this.context.workspaceState.get<SavedQuery[]>(this.STORAGE_KEY, []);
    const existing = this.context.globalState.get<SavedQuery[]>(this.STORAGE_KEY, []);
    if (legacy.length > 0 && existing.length === 0) {
      await this.context.globalState.update(this.STORAGE_KEY, legacy.map((q) => this.normalizeQuery(q)));
      await this.context.workspaceState.update(this.STORAGE_KEY, undefined);
    }
    await this.context.globalState.update(this.MIGRATION_KEY, true);
  }

  /**
   * Save queries to global memento.
   */
  private async saveQueries(): Promise<void> {
    if (!this.context) {
      return;
    }
    const queryArray = [...Array.from(this.queries.values()), ...this.tombstones];
    await this.context.globalState.update(this.STORAGE_KEY, queryArray);
  }

  private normalizeQuery(query: SavedQuery): SavedQuery {
    const now = Date.now();
    return {
      ...query,
      createdAt: query.createdAt ?? now,
      updatedAt: query.updatedAt ?? query.createdAt ?? now,
      revision: query.revision ?? 1,
      usageCount: query.usageCount ?? 0,
    };
  }

  private bumpRevision(query: SavedQuery): SavedQuery {
    const now = Date.now();
    return {
      ...query,
      updatedAt: now,
      revision: (query.revision ?? 1) + 1,
    };
  }

  /**
   * Save a new query or update existing one.
   */
  async saveQuery(query: SavedQuery): Promise<void> {
    // Soft cap: free tier limited to FREE_SAVED_QUERIES_LIMIT (no-op while enforcement=off).
    const isNew = !query.id || !this.queries.has(query.id);
    if (
      isNew &&
      this.queries.size >= FREE_SAVED_QUERIES_LIMIT &&
      !isProFeatureEnabled(ProFeature.UnlimitedSavedQueries)
    ) {
      const choice = await vscode.window.showWarningMessage(
        `Free tier is limited to ${FREE_SAVED_QUERIES_LIMIT} saved queries. Upgrade for unlimited.`,
        'View Plans',
      );
      if (choice === 'View Plans') {
        await vscode.commands.executeCommand('postgres-explorer.license.openUpgrade');
      }
      return;
    }
    if (!query.id) {
      query.id = this.generateId();
    }
    if (!query.createdAt) {
      query.createdAt = Date.now();
    }
    const normalized = this.bumpRevision(this.normalizeQuery(query));
    this.queries.set(normalized.id, normalized);
    recordSyncActivity({
      kind: 'query',
      action: isNew ? 'create' : 'update',
      itemId: normalized.id,
      name: normalized.title,
    });
    triggerInstantSync();
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
      query.revision = existing.revision;
    }
    const normalized = this.bumpRevision(this.normalizeQuery(query));
    this.queries.set(normalized.id, normalized);
    recordSyncActivity({
      kind: 'query',
      action: 'update',
      itemId: normalized.id,
      name: normalized.title,
    });
    triggerInstantSync();
    await this.saveQueries();
  }

  /**
   * Delete a saved query by ID (tombstone for sync).
   */
  async deleteQuery(queryId: string): Promise<void> {
    const existing = this.queries.get(queryId);
    if (existing) {
      const tombstone = this.bumpRevision({ ...existing, deleted: true });
      recordSyncActivity({
        kind: 'query',
        action: 'delete',
        itemId: queryId,
        name: existing.title,
      });
      triggerInstantSync();
      this.queries.delete(queryId);
      this.tombstones = this.tombstones.filter((t) => t.id !== queryId);
      this.tombstones.push(tombstone);
    }
    await this.saveQueries();
  }

  /**
   * Get all saved queries.
   */
  getQueries(): SavedQuery[] {
    return Array.from(this.queries.values())
      .filter((q) => !q.deleted)
      .sort(
        (a, b) => (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt)
      );
  }

  /** All queries including tombstones — for sync collection. */
  getAllQueriesForSync(): SavedQuery[] {
    return [...Array.from(this.queries.values()), ...this.tombstones];
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
      const now = Date.now();
      query.lastUsed = now;
      query.usageCount = (query.usageCount || 0) + 1;
      await this.saveQueries();

      // Track saved query usage
      const ageBucket = this.bucketQueryAge(now - query.createdAt);
      const querySize = query.query.length;
      TelemetryService.getInstance().trackSavedQueryUsed(ageBucket, querySize);
    }
  }

  /**
   * Bucket query age in milliseconds
   */
  private bucketQueryAge(ageMs: number): string {
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;
    const monthMs = 30 * dayMs;

    if (ageMs < dayMs) return 'new';
    if (ageMs < weekMs) return 'lt_1w';
    if (ageMs < monthMs) return 'lt_1m';
    return 'gte_1m';
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
  async importQueries(jsonData: string): Promise<SavedQueryImportResult> {
    try {
      const imported = JSON.parse(jsonData) as SavedQuery[];
      if (!Array.isArray(imported)) {
        throw new Error('Expected an array of saved queries.');
      }
      let importedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      const byTitle = new Map(
        Array.from(this.queries.values()).map((q) => [q.title.trim().toLowerCase(), q]),
      );
      for (const query of imported) {
        if (!query || typeof query.query !== 'string' || typeof query.title !== 'string') {
          skippedCount++;
          continue;
        }
        const normalizedTitle = query.title.trim().toLowerCase();
        const existingById = query.id ? this.queries.get(query.id) : undefined;
        const existingByTitle = byTitle.get(normalizedTitle);
        if (existingById) {
          await this.updateQuery({
            ...existingById,
            ...query,
            id: existingById.id,
          });
          updatedCount++;
          continue;
        }
        if (existingByTitle) {
          await this.updateQuery({
            ...existingByTitle,
            ...query,
            id: existingByTitle.id,
          });
          updatedCount++;
          continue;
        }
        await this.saveQuery(query);
        importedCount++;
        const saved = query.id ? this.queries.get(query.id) : undefined;
        if (saved) {
          byTitle.set(normalizedTitle, saved);
        }
      }
      return { imported: importedCount, updated: updatedCount, skipped: skippedCount };
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
