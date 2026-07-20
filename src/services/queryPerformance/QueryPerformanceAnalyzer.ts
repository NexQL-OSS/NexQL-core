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
  lossyBitmapScans?: number;
  spilledToDisk?: number;
  estimateMismatchesOver10x?: number;
  functionScans?: number;
  cteScans?: number;
  subqueryScans?: number;
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

export interface PerformanceRecommendation {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'index' | 'estimate' | 'scan' | 'memory' | 'cost' | 'join' | 'function' | 'cte' | 'subquery';
  title: string;
  description: string;
  suggestion: string;
  estimatedImprovement: string;
}

/**
 * Service for analyzing query execution plans and performance baselines
 */
export class QueryPerformanceAnalyzer {
  private static instance: QueryPerformanceAnalyzer;

  private constructor() { }

  public static getInstance(): QueryPerformanceAnalyzer {
    if (!QueryPerformanceAnalyzer.instance) {
      QueryPerformanceAnalyzer.instance = new QueryPerformanceAnalyzer();
    }
    return QueryPerformanceAnalyzer.instance;
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
      lossyBitmapScans: 0,
      spilledToDisk: 0,
      estimateMismatchesOver10x: 0,
      functionScans: 0,
      cteScans: 0,
      subqueryScans: 0,
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
    if (nodeType.includes('Function Scan')) {
      metrics.functionScans = (metrics.functionScans || 0) + 1;
      const functionName = node['Function Name'] ? ` ${String(node['Function Name'])}` : '';
      metrics.bottlenecks.push(`Function scan${functionName} observed in plan`);
    }
    if (nodeType.includes('CTE Scan')) {
      metrics.cteScans = (metrics.cteScans || 0) + 1;
      const cteName = node['CTE Name'] ? ` ${String(node['CTE Name'])}` : '';
      metrics.bottlenecks.push(`CTE scan${cteName} observed in plan`);
    }
    if (nodeType.includes('Subquery Scan') || nodeType.includes('SubPlan') || nodeType.includes('InitPlan')) {
      metrics.subqueryScans = (metrics.subqueryScans || 0) + 1;
      metrics.bottlenecks.push(`${nodeType} observed in plan`);
    }

    // Identify planning vs. execution mismatches (bottleneck)
    if (planRows > 0 && actualRows > 0) {
      const variance = Math.abs(actualRows - planRows) / planRows;
      if (variance > 0.5) {
        metrics.bottlenecks.push(
          `Row estimation mismatch in ${nodeType}: planned ${planRows}, actual ${actualRows}`
        );
      }
      const ratio = Math.max(actualRows / Math.max(planRows, 1), planRows / Math.max(actualRows, 1));
      if (ratio > 10) {
        metrics.estimateMismatchesOver10x = (metrics.estimateMismatchesOver10x || 0) + 1;
      }
    }

    if (nodeType.includes('Bitmap Heap Scan') && typeof node['Lossy Heap Blocks'] === 'number' && node['Lossy Heap Blocks'] > 0) {
      metrics.lossyBitmapScans = (metrics.lossyBitmapScans || 0) + 1;
      metrics.bottlenecks.push(`Lossy bitmap heap scan detected (${node['Lossy Heap Blocks']} lossy blocks)`);
    }
    const tempWrittenBlocks = Number(node['Temp Written Blocks'] || 0);
    if (tempWrittenBlocks > 0) {
      metrics.spilledToDisk = (metrics.spilledToDisk || 0) + 1;
      metrics.bottlenecks.push(`${nodeType} spilled to disk (${tempWrittenBlocks} temp blocks written)`);
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
    if ((metrics.estimateMismatchesOver10x || 0) > 0) {
      metrics.recommendations.push('Severe row estimate mismatch (>10x) detected. Run ANALYZE and review join/filter selectivity.');
    }
    if ((metrics.lossyBitmapScans || 0) > 0) {
      metrics.recommendations.push('Lossy bitmap heap scan detected. Consider more selective indexes or reducing bitmap recheck cost.');
    }
    if ((metrics.spilledToDisk || 0) > 0) {
      metrics.recommendations.push('Disk spill detected in execution plan. Review work_mem and sort/hash strategy.');
    }
    if ((metrics.functionScans || 0) > 0) {
      metrics.recommendations.push('Function Scan detected. Validate function cost and push filters before invoking set-returning functions.');
    }
    if ((metrics.cteScans || 0) > 0) {
      metrics.recommendations.push('CTE Scan detected. Review CTE materialization/reuse and reduce intermediate row width.');
    }
    if ((metrics.subqueryScans || 0) > 0) {
      metrics.recommendations.push('Subquery or subplan nodes detected. Consider flattening nested subqueries when cardinality is high.');
    }
  }
}
