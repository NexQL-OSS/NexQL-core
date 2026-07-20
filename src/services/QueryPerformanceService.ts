import * as vscode from 'vscode';
import { QueryBaseline, BASELINE_MIN_SAMPLES, OUTLIER_SIGMA_THRESHOLD } from './queryPerformance/QueryPerformanceAnalyzer';

/** Current shape version — increment if QueryBaseline fields change. */
const SCHEMA_VERSION = 2;

export class QueryPerformanceService {
  private static instance: QueryPerformanceService;
  private storage: vscode.Memento;
  private readonly STORAGE_KEY = 'postgres-explorer.queryPerformanceBaselines';

  // Cache in memory to avoid redundant reads
  private cache: Map<string, QueryBaseline> = new Map();

  private constructor(storage: vscode.Memento) {
    this.storage = storage;
    this.loadCache();
  }

  public static initialize(storage: vscode.Memento): void {
    if (!QueryPerformanceService.instance) {
      QueryPerformanceService.instance = new QueryPerformanceService(storage);
    }
  }

  public static getInstance(): QueryPerformanceService {
    if (!QueryPerformanceService.instance) {
      throw new Error('QueryPerformanceService not initialized');
    }
    return QueryPerformanceService.instance;
  }

  private loadCache() {
    const data = this.storage.get<Record<string, QueryBaseline>>(this.STORAGE_KEY, {});
    this.cache = new Map(
      Object.entries(data).map(([k, v]) => [k, this._migrate(v)])
    );
  }

  private _migrate(b: any): QueryBaseline {
    // Upgrade records from schema v1 (no m2 field) to v2
    if (!b.schemaVersion || b.schemaVersion < SCHEMA_VERSION) {
      return {
        queryHash: b.queryHash ?? '',
        avgExecutionTime: b.avgExecutionTime ?? 0,
        minExecutionTime: b.minExecutionTime ?? 0,
        maxExecutionTime: b.maxExecutionTime ?? 0,
        m2: 0,
        stdDev: 0,
        sampleCount: b.sampleCount ?? 1,
        lastUpdated: b.lastUpdated ?? Date.now(),
        schemaVersion: SCHEMA_VERSION,
      };
    }
    return b as QueryBaseline;
  }

  private async saveCache() {
    const data = Object.fromEntries(this.cache);
    await this.storage.update(this.STORAGE_KEY, data);
  }

  public getBaseline(queryHash: string): QueryBaseline | null {
    return this.cache.get(queryHash) || null;
  }

  /**
   * Record a new execution time for a query using Welford's online algorithm
   * for numerically stable mean and variance.
   *
   * Outliers (> OUTLIER_SIGMA_THRESHOLD σ from the mean) are logged but not
   * incorporated into the baseline to avoid skewing the statistics.
   */
  public async recordExecution(queryHash: string, executionTimeMs: number): Promise<void> {
    const existing = this.cache.get(queryHash);
    const now = Date.now();

    let baseline: QueryBaseline;

    if (existing) {
      // Outlier guard — skip samples that are statistically extreme
      if (existing.sampleCount >= BASELINE_MIN_SAMPLES && existing.stdDev > 0) {
        const zScore = (executionTimeMs - existing.avgExecutionTime) / existing.stdDev;
        if (zScore > OUTLIER_SIGMA_THRESHOLD) {
          // Do not incorporate outlier — just update lastUpdated
          baseline = { ...existing, lastUpdated: now };
          this.cache.set(queryHash, baseline);
          await this.saveCache();
          return;
        }
      }

      const newCount = existing.sampleCount + 1;

      // Welford's online algorithm:
      //   delta  = x - mean_old
      //   mean   = mean_old + delta / n
      //   delta2 = x - mean_new
      //   M2     = M2_old + delta * delta2
      //   variance = M2 / n   (population variance)
      const delta = executionTimeMs - existing.avgExecutionTime;
      const newAvg = existing.avgExecutionTime + delta / newCount;
      const delta2 = executionTimeMs - newAvg;
      const newM2 = (existing.m2 ?? 0) + delta * delta2;
      const newVariance = newM2 / newCount;

      baseline = {
        queryHash,
        avgExecutionTime: newAvg,
        minExecutionTime: Math.min(existing.minExecutionTime, executionTimeMs),
        maxExecutionTime: Math.max(existing.maxExecutionTime, executionTimeMs),
        m2: newM2,
        stdDev: Math.sqrt(newVariance),
        sampleCount: newCount,
        lastUpdated: now,
        schemaVersion: SCHEMA_VERSION,
      };
    } else {
      // First sample — variance is undefined; initialise to zero
      baseline = {
        queryHash,
        avgExecutionTime: executionTimeMs,
        minExecutionTime: executionTimeMs,
        maxExecutionTime: executionTimeMs,
        m2: 0,
        stdDev: 0,
        sampleCount: 1,
        lastUpdated: now,
        schemaVersion: SCHEMA_VERSION,
      };
    }

    this.cache.set(queryHash, baseline);
    await this.saveCache();
  }

  /**
   * Returns a human-readable degradation alert string when:
   *  - at least BASELINE_MIN_SAMPLES have been recorded (confidence gate), AND
   *  - the current execution time exceeds the mean by more than one σ above
   *    the threshold (currently avg + max(1σ, 20%)).
   *
   * Returns null when there is insufficient data or no degradation.
   */
  public getDegradationAlert(queryHash: string, executionTimeMs: number): string | null {
    const baseline = this.cache.get(queryHash);
    if (!baseline || baseline.sampleCount < BASELINE_MIN_SAMPLES) {
      return null; // Not enough data to be confident
    }

    const { avgExecutionTime, stdDev, sampleCount } = baseline;

    // Use the larger of 1 σ or 20% of avg as the warning threshold
    const sigmaThreshold = Math.max(stdDev, avgExecutionTime * 0.2);
    const warningLevel = avgExecutionTime + sigmaThreshold;

    if (executionTimeMs > warningLevel) {
      const pct = Math.round(((executionTimeMs - avgExecutionTime) / avgExecutionTime) * 100);
      return (
        `Query is ${pct}% slower than the ${sampleCount}-run average ` +
        `(avg: ${avgExecutionTime.toFixed(0)} ms, now: ${executionTimeMs.toFixed(0)} ms, ` +
        `σ: ${stdDev.toFixed(0)} ms)`
      );
    }
    return null;
  }

  public async clear(): Promise<void> {
    this.cache.clear();
    await this.storage.update(this.STORAGE_KEY, {});
  }
}
