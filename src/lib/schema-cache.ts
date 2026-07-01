/**
 * Schema Cache for Database Explorer
 * Caches database metadata queries with adaptive TTL based on query frequency.
 */

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
}

export class SchemaCache {
  private cache = new Map<string, CacheEntry<any>>();
  private readonly DEFAULT_TTL = 60000; // 1 minute default TTL
  private readonly SHORT_TTL = 30000; // 30 seconds for frequently accessed
  private readonly LONG_TTL = 300000; // 5 minutes for infrequently accessed
  private readonly ACCESS_THRESHOLD = 10; // Access count to trigger adaptive TTL

  /**
   * Get cached data or fetch it using the provided fetcher function
   * Adapts TTL based on access patterns for intelligent cache management
   * @param key - Cache key (should be unique per query)
   * @param fetcher - Async function to fetch data if not cached
   * @param ttl - Optional custom TTL in milliseconds (overrides adaptive TTL)
   */
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T> {
    const cached = this.cache.get(key);
    const now = Date.now();
    
    if (cached) {
      // Calculate adaptive TTL if not explicitly provided
      const effectiveTTL = ttl ?? this.getAdaptiveTTL(cached);
      const age = now - cached.timestamp;

      if (age < effectiveTTL) {
        // Update access tracking for adaptive TTL
        cached.accessCount++;
        cached.lastAccess = now;
        return cached.data as T;
      }
    }

    const data = await fetcher();
    this.cache.set(key, {
      data,
      timestamp: now,
      accessCount: 1,
      lastAccess: now
    });

    if (this.cache.size > 1500) {
      const entries = [...this.cache.entries()]
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      const toRemove = entries.slice(0, this.cache.size - 1500);
      for (const [k] of toRemove) {
        this.cache.delete(k);
      }
    }
    return data;
  }

  /**
   * Calculate adaptive TTL based on access frequency
   * Frequently accessed items get shorter TTL to stay fresh
   * Infrequently accessed items get longer TTL to reduce fetches
   */
  private getAdaptiveTTL(entry: CacheEntry<any>): number {
    if (entry.accessCount > this.ACCESS_THRESHOLD) {
      // Frequently accessed - keep fresh
      return this.SHORT_TTL;
    }
    // Infrequently accessed - cache longer
    return this.LONG_TTL;
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): { size: number; totalAccess: number; memorySizeEstimate: string } {
    let totalAccess = 0;
    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount;
    }

    // Rough estimate of memory usage
    const estimateBytes = this.cache.size * 1024; // ~1KB per entry average
    const memorySizeEstimate = estimateBytes > 1024 * 1024
      ? `${(estimateBytes / (1024 * 1024)).toFixed(1)}MB`
      : `${(estimateBytes / 1024).toFixed(1)}KB`;

    return {
      size: this.cache.size,
      totalAccess,
      memorySizeEstimate
    };
  }

  /**
   * Invalidate cache entries matching a pattern
   * @param pattern - Pattern to match (simple substring match)
   */
  invalidate(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
      return;
    }

    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate cache for a specific connection
   */
  invalidateConnection(connectionId: string): void {
    this.invalidate(`conn:${connectionId}`);
  }

  /**
   * Invalidate cache for a specific database
   */
  invalidateDatabase(connectionId: string, database: string): void {
    this.invalidate(`conn:${connectionId}:db:${database}`);
  }

  /**
   * Invalidate cache for a specific schema
   */
  invalidateSchema(connectionId: string, database: string, schema: string): void {
    this.invalidate(`conn:${connectionId}:db:${database}:schema:${schema}`);
  }

  /**
   * Build a cache key for a query
   */
  static buildKey(connectionId: string, database: string, schema?: string, category?: string): string {
    const parts = [`conn:${connectionId}`, `db:${database}`];
    if (schema) parts.push(`schema:${schema}`);
    if (category) parts.push(`cat:${category}`);
    return parts.join(':');
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }
}

// Singleton instance for use across the application
let schemaCacheInstance: SchemaCache | null = null;

export function getSchemaCache(): SchemaCache {
  if (!schemaCacheInstance) {
    schemaCacheInstance = new SchemaCache();
  }
  return schemaCacheInstance;
}
