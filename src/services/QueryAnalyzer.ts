import { ConnectionConfig } from '../common/types';
import { SqlParser } from '../providers/kernel/SqlParser';

/**
 * Execution plan performance metrics extracted from EXPLAIN JSON
 */
export interface PlanMetrics {
  totalCost: number;
  planningTime: number;
  executionTime: number;
  sequentialScans: number;
  indexScans: number;
  bufferStats?: {
    bufferHits: number;
    bufferReads: number;
    hitRatio?: number;
  };
  bottlenecks: string[];
  recommendations: string[];
}

/**
 * Baseline statistics for a query (for trend comparison).
 * Uses Welford's online algorithm for variance so stdDev is always accurate.
 */
export interface QueryBaseline {
  queryHash: string;
  avgExecutionTime: number;
  minExecutionTime: number;
  maxExecutionTime: number;
  /** True running variance (M2 accumulator for Welford). */
  m2: number;
  /** Population standard deviation derived from m2 / sampleCount. */
  stdDev: number;
  sampleCount: number;
  lastUpdated: number;
  /** Metadata schema version — bump when shape changes. */
  schemaVersion: number;
}

/** Minimum samples required before degradation alerts are trustworthy. */
export const BASELINE_MIN_SAMPLES = 5;

/**
 * If the new execution time exceeds avg + OUTLIER_SIGMA_THRESHOLD * stdDev
 * it is flagged as a statistical outlier and excluded from the baseline.
 */
export const OUTLIER_SIGMA_THRESHOLD = 4;

/**
 * Query performance analysis result
 */
export interface PerformanceAnalysis {
  metrics: PlanMetrics | null;
  baseline: QueryBaseline | null;
  isDegraded: boolean;
  degradationPercent?: number;
  analysis: string;
}

/**
 * Represents a dangerous SQL operation detected by the analyzer
 */
export interface DangerousOperation {
  type: 'DROP' | 'TRUNCATE' | 'DELETE' | 'UPDATE' | 'ALTER' | 'GRANT' | 'REVOKE' | 'INSERT' | 'CREATE';
  severity: 'critical' | 'high' | 'medium';
  reason: string;
  affectedObjects: string[];
  hasWhereClause: boolean;
  estimatedImpact?: string;
}

/**
 * Result of query analysis
 */
export interface QueryAnalysis {
  isDangerous: boolean;
  operations: DangerousOperation[];
  riskScore: number; // 0-100
  requiresConfirmation: boolean;
  warningMessage?: string;
}

/**
 * Service for analyzing SQL queries to detect potentially dangerous operations
 */
export class QueryAnalyzer {
  private static instance: QueryAnalyzer;

  private constructor() { }

  public static getInstance(): QueryAnalyzer {
    if (!QueryAnalyzer.instance) {
      QueryAnalyzer.instance = new QueryAnalyzer();
    }
    return QueryAnalyzer.instance;
  }

  /**
   * Analyze a SQL query for dangerous operations
   */
  public analyzeQuery(
    query: string,
    connection?: ConnectionConfig
  ): QueryAnalysis {
    const normalizedQuery = this.normalizeQuery(query);
    const operations: DangerousOperation[] = [];

    // Detect DROP operations
    const dropMatch = normalizedQuery.match(
      /\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|FUNCTION|PROCEDURE|TRIGGER|INDEX|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i
    );
    if (dropMatch) {
      operations.push({
        type: 'DROP',
        severity: 'critical',
        reason: `Dropping ${dropMatch[1].toLowerCase()}: ${dropMatch[2]}`,
        affectedObjects: [dropMatch[2]],
        hasWhereClause: false,
        estimatedImpact: 'Permanent data loss',
      });
    }

    // Detect TRUNCATE operations
    const truncateMatch = normalizedQuery.match(/\bTRUNCATE\s+(?:TABLE\s+)?([^\s;]+)/i);
    if (truncateMatch) {
      operations.push({
        type: 'TRUNCATE',
        severity: 'critical',
        reason: `Truncating table: ${truncateMatch[1]}`,
        affectedObjects: [truncateMatch[1]],
        hasWhereClause: false,
        estimatedImpact: 'All rows will be deleted',
      });
    }

    // Detect DELETE without WHERE
    const deleteMatch = normalizedQuery.match(/\bDELETE\s+FROM\s+([^\s;]+)/i);
    if (deleteMatch) {
      const hasWhere = /\bWHERE\b/i.test(normalizedQuery);
      if (!hasWhere) {
        operations.push({
          type: 'DELETE',
          severity: 'critical',
          reason: `Deleting all rows from table: ${deleteMatch[1]}`,
          affectedObjects: [deleteMatch[1]],
          hasWhereClause: false,
          estimatedImpact: 'All rows will be deleted',
        });
      } else {
        // DELETE with WHERE is medium risk
        operations.push({
          type: 'DELETE',
          severity: 'medium',
          reason: `Deleting rows from table: ${deleteMatch[1]}`,
          affectedObjects: [deleteMatch[1]],
          hasWhereClause: true,
          estimatedImpact: 'Rows matching WHERE clause will be deleted',
        });
      }
    }

    // Detect UPDATE without WHERE
    const updateMatch = normalizedQuery.match(/\bUPDATE\s+([^\s;]+)\s+SET/i);
    if (updateMatch) {
      const hasWhere = /\bWHERE\b/i.test(normalizedQuery);
      if (!hasWhere) {
        operations.push({
          type: 'UPDATE',
          severity: 'high',
          reason: `Updating all rows in table: ${updateMatch[1]}`,
          affectedObjects: [updateMatch[1]],
          hasWhereClause: false,
          estimatedImpact: 'All rows will be modified',
        });
      } else {
        // UPDATE with WHERE is medium risk
        operations.push({
          type: 'UPDATE',
          severity: 'medium',
          reason: `Updating rows in table: ${updateMatch[1]}`,
          affectedObjects: [updateMatch[1]],
          hasWhereClause: true,
          estimatedImpact: 'Rows matching WHERE clause will be modified',
        });
      }
    }

    // Detect INSERT operations
    const insertMatch = normalizedQuery.match(/\bINSERT\s+INTO\s+([^\s;(]+)/i);
    if (insertMatch) {
      operations.push({
        type: 'INSERT',
        severity: 'medium',
        reason: `Inserting data into table: ${insertMatch[1]}`,
        affectedObjects: [insertMatch[1]],
        hasWhereClause: false,
        estimatedImpact: 'New rows will be added',
      });
    }

    // Detect ALTER operations
    const alterMatch = normalizedQuery.match(
      /\bALTER\s+(TABLE|DATABASE|SCHEMA|VIEW|FUNCTION|PROCEDURE)\s+([^\s;]+)(?:\s+(.+?))?(?:;|$)/i
    );
    if (alterMatch) {
      const objectType = alterMatch[1].toLowerCase();
      const objectName = alterMatch[2];
      const alterAction = (alterMatch[3] || '').trim();
      const actionSummary = alterAction ? ` (${alterAction})` : '';
      operations.push({
        type: 'ALTER',
        severity: 'high',
        reason: `Altering ${objectType}: ${objectName}${actionSummary}`,
        affectedObjects: [objectName],
        hasWhereClause: false,
        estimatedImpact: this.describeAlterImpact(alterAction),
      });
    }

    // Detect CREATE operations on production
    const createMatch = normalizedQuery.match(
      /\bCREATE\s+(TABLE|DATABASE|SCHEMA|VIEW|FUNCTION|PROCEDURE|INDEX|SEQUENCE)\s+(?:OR\s+REPLACE\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([^\s;(]+)/i
    );
    if (createMatch && connection?.environment === 'production') {
      operations.push({
        type: 'CREATE',
        severity: 'medium',
        reason: `Creating ${createMatch[1].toLowerCase()}: ${createMatch[2]}`,
        affectedObjects: [createMatch[2]],
        hasWhereClause: false,
        estimatedImpact: 'New database object will be created',
      });
    }

    // Detect GRANT/REVOKE operations
    const grantRevokeMatch = normalizedQuery.match(/\b(GRANT|REVOKE)\s+/i);
    if (grantRevokeMatch) {
      operations.push({
        type: grantRevokeMatch[1].toUpperCase() as 'GRANT' | 'REVOKE',
        severity: 'medium',
        reason: `${grantRevokeMatch[1]} operation detected`,
        affectedObjects: [],
        hasWhereClause: false,
        estimatedImpact: 'Permission changes',
      });
    }

    // Calculate risk score
    const riskScore = this.calculateRiskScore(operations, connection);
    const isDangerous = operations.length > 0;
    const requiresConfirmation = this.shouldRequireConfirmation(
      operations,
      connection
    );

    return {
      isDangerous,
      operations,
      riskScore,
      requiresConfirmation,
      warningMessage: requiresConfirmation
        ? this.buildWarningMessage(operations, connection)
        : undefined,
    };
  }

  /**
   * Whether successfully executing this statement should drop SQL completion caches
   * (objects/columns/FKs) for the current database.
   */
  public isCatalogInvalidatingSql(sql: string): boolean {
    const q = SqlParser.stripCommentsAndStrings(sql).trim();
    if (!q) {
      return false;
    }
    return /^\s*(CREATE|ALTER|DROP)\s+/i.test(q) || /^\s*TRUNCATE\s+/i.test(q);
  }

  /**
   * Normalize query by removing comments and extra whitespace
   */
  private normalizeQuery(query: string): string {
    // Remove line comments
    let normalized = query.replace(/--[^\n]*/g, '');
    // Remove block comments
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  /**
   * Calculate risk score based on operations and connection environment
   */
  private calculateRiskScore(
    operations: DangerousOperation[],
    connection?: ConnectionConfig
  ): number {
    if (operations.length === 0) {
      return 0;
    }

    // Base score from operations
    let score = 0;
    for (const op of operations) {
      switch (op.severity) {
        case 'critical':
          score += 40;
          break;
        case 'high':
          score += 25;
          break;
        case 'medium':
          score += 10;
          break;
      }
    }

    // Multiply by environment factor
    if (connection?.environment === 'production') {
      score *= 2;
    } else if (connection?.environment === 'staging') {
      score *= 1.5;
    }

    return Math.min(100, score);
  }

  /**
   * Determine if confirmation should be required
   */
  private shouldRequireConfirmation(
    operations: DangerousOperation[],
    connection?: ConnectionConfig
  ): boolean {
    // Always require confirmation for destructive operations.
    if (operations.some((op) => ['DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'ALTER'].includes(op.type))) {
      return true;
    }

    // Require confirmation for CREATE on production.
    if (
      connection?.environment === 'production' &&
      operations.some((op) => op.type === 'CREATE')
    ) {
      return true;
    }

    // Require confirmation for permission changes on production or when they are broad.
    if (
      operations.some((op) => op.type === 'GRANT' || op.type === 'REVOKE') &&
      (connection?.environment === 'production' || operations.some((op) => !op.hasWhereClause))
    ) {
      return true;
    }

    return false;
  }

  /**
   * Describe the impact of an ALTER TABLE action using the specific subcommand when possible.
   */
  private describeAlterImpact(alterAction: string): string {
    const action = alterAction.toUpperCase();
    if (action.startsWith('ADD COLUMN')) {
      return 'New column will be added to the table';
    }
    if (action.startsWith('DROP COLUMN')) {
      return 'Column and its data may be removed';
    }
    if (action.startsWith('ALTER COLUMN')) {
      return 'Existing column definition may change';
    }
    if (action.startsWith('RENAME TO') || action.startsWith('RENAME COLUMN')) {
      return 'Object names will change and dependent queries may break';
    }
    if (action.startsWith('SET DATA TYPE')) {
      return 'Column data type will change and may require a table rewrite';
    }
    if (action.startsWith('ADD CONSTRAINT')) {
      return 'A new constraint will be enforced on future writes';
    }
    if (action.startsWith('DROP CONSTRAINT')) {
      return 'An existing constraint will be removed';
    }
    return 'Schema changes may affect dependent objects';
  }

  /**
   * Build warning message for user confirmation
   */
  private buildWarningMessage(
    operations: DangerousOperation[],
    connection?: ConnectionConfig
  ): string {
    const envPrefix =
      connection?.environment === 'production'
        ? '⚠️ PRODUCTION DATABASE ⚠️\n\n'
        : connection?.environment === 'staging'
          ? '⚠️ STAGING DATABASE ⚠️\n\n'
          : '';

    const opMessages = operations.map((op) => {
      const objectList =
        op.affectedObjects.length > 0
          ? ` (${op.affectedObjects.join(', ')})`
          : '';
      return `• ${op.reason}${objectList}\n  Impact: ${op.estimatedImpact}`;
    });

    return (
      envPrefix +
      'This query contains potentially dangerous operations:\n\n' +
      opMessages.join('\n\n') +
      '\n\nAre you sure you want to execute this query?'
    );
  }

  /**
   * Check if a query is safe for read-only mode
   */
  public isReadOnlyQuery(query: string): boolean {
    const normalizedQuery = this.normalizeQuery(query);

    // Check for any write operations
    const writePatterns = [
      /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE)\b/i,
    ];

    const hasWriteOperation = writePatterns.some((pattern) =>
      pattern.test(normalizedQuery)
    );

    return !hasWriteOperation;
  }

  /**
   * Extract performance metrics from EXPLAIN JSON plan.
   * Analyzes the execution plan to identify bottlenecks and opportunities.
   */
  public extractPlanMetrics(explainPlan: any): PlanMetrics | null {
    if (!explainPlan || typeof explainPlan !== 'object') {
      return null;
    }

    // Handle both direct plan object and wrapped format
    const plan =
      explainPlan[0] || explainPlan;

    if (!plan || !plan['Plan']) {
      return null;
    }

    const planMetrics: PlanMetrics = {
      totalCost: plan['Plan']['Total Cost'] || 0,
      planningTime: plan['Planning Time'] || 0,
      executionTime: plan['Execution Time'] || 0,
      sequentialScans: 0,
      indexScans: 0,
      bottlenecks: [],
      recommendations: [],
    };

    // Count scan types and identify bottlenecks
    this.analyzePlanNode(plan['Plan'], planMetrics);

    // Extract buffer statistics if present
    if (plan['Planning'] !== undefined && plan['Buffers']) {
      const buffers = plan['Buffers'];
      const totalHits = (buffers['Shared Hit Blocks'] || 0) + (buffers['Shared Read Blocks'] || 0);
      const reads = buffers['Shared Read Blocks'] || 0;
      planMetrics.bufferStats = {
        bufferHits: buffers['Shared Hit Blocks'] || 0,
        bufferReads: reads,
        hitRatio: totalHits > 0 ? ((totalHits - reads) / totalHits * 100) : 0,
      };
    }

    // Generate recommendations based on metrics
    this.generateRecommendations(planMetrics);

    return planMetrics;
  }

  /**
   * Recursively analyze plan nodes to count operations and identify bottlenecks
   */
  private analyzePlanNode(node: any, metrics: PlanMetrics): void {
    if (!node) {
      return;
    }

    const nodeType = node['Node Type'] || '';
    const actualRows = node['Actual Rows'] || 0;
    const planRows = node['Plan Rows'] || 0;
    const actualTime = node['Actual Total Time'] || 0;

    // Count scan types
    if (nodeType.includes('Seq Scan')) {
      metrics.sequentialScans++;
    } else if (nodeType.includes('Index Scan')) {
      metrics.indexScans++;
    }

    // Identify planning vs. execution mismatches (bottleneck)
    if (planRows > 0 && actualRows > 0) {
      const variance = Math.abs(actualRows - planRows) / planRows;
      if (variance > 0.5) {
        metrics.bottlenecks.push(
          `Row estimation mismatch in ${nodeType}: planned ${planRows}, actual ${actualRows}`
        );
      }
    }

    // Flag slow operations
    if (actualTime > 1000) {
      metrics.bottlenecks.push(`${nodeType} took ${actualTime.toFixed(2)}ms`);
    }

    // Recursively process child nodes
    if (node['Plans'] && Array.isArray(node['Plans'])) {
      node['Plans'].forEach((child: any) => this.analyzePlanNode(child, metrics));
    }
  }

  /**
   * Generate optimization recommendations based on plan metrics
   */
  private generateRecommendations(metrics: PlanMetrics): void {
    // Sequential scan optimization
    if (metrics.sequentialScans > 0 && metrics.indexScans === 0) {
      metrics.recommendations.push('Consider adding indexes on frequently filtered columns');
    }

    // High planning cost
    if (metrics.totalCost > 10000) {
      metrics.recommendations.push('Query planning cost is high; consider simplifying the query or analyzing table statistics');
    }

    // Buffer efficiency
    if (metrics.bufferStats && metrics.bufferStats.hitRatio !== undefined) {
      if (metrics.bufferStats.hitRatio < 80) {
        metrics.recommendations.push('Low buffer hit ratio; consider increasing work_mem or improving indexes');
      }
    }

    // Bottleneck-based recommendations
    if (metrics.bottlenecks.length > 0) {
      metrics.recommendations.push('Review bottlenecks: ' + metrics.bottlenecks[0]);
    }
  }

  /**
   * Compute a hash of normalized query for baseline tracking
   */
  public getQueryHash(query: string): string {
    const normalized = this.normalizeQuery(query)
      .toLowerCase()
      .replace(/\?/g, ':param') // Normalize parameterized queries
      .replace(/\d+/g, 'N'); // Normalize numeric literals

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Analyze query performance against historical baseline
   */
  public analyzePerformanceAgainstBaseline(
    executionTime: number,
    baseline: QueryBaseline | null,
    explainPlan?: any
  ): PerformanceAnalysis {
    const metrics = this.extractPlanMetrics(explainPlan);

    if (!baseline) {
      return {
        metrics,
        baseline: null,
        isDegraded: false,
        analysis: 'No baseline available for comparison. First execution will be recorded as baseline.',
      };
    }

    const isDegraded = executionTime > baseline.avgExecutionTime * 1.2; // 20% slower
    const degradationPercent = isDegraded
      ? Math.round(((executionTime - baseline.avgExecutionTime) / baseline.avgExecutionTime) * 100)
      : 0;

    const analysis = isDegraded
      ? `Performance degradation detected: ${degradationPercent}% slower than baseline (${baseline.avgExecutionTime.toFixed(0)}ms avg vs ${executionTime.toFixed(0)}ms now).`
      : `Query performance is within baseline (${baseline.avgExecutionTime.toFixed(0)}ms avg, ${executionTime.toFixed(0)}ms now).`;

    return {
      metrics,
      baseline,
      isDegraded,
      degradationPercent,
      analysis,
    };
  }
}
