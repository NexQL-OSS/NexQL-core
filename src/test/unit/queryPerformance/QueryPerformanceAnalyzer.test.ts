import { expect } from 'chai';

import { QueryPerformanceAnalyzer } from '../../../services/queryPerformance/QueryPerformanceAnalyzer';

describe('QueryPerformanceAnalyzer', () => {
  const analyzer = QueryPerformanceAnalyzer.getInstance();

  it('returns the singleton instance', () => {
    expect(QueryPerformanceAnalyzer.getInstance()).to.equal(analyzer);
  });

  it('extracts execution-plan metrics and recommendations', () => {
    const explainPlan = [
      {
        Planning: {},
        Buffers: { 'Shared Hit Blocks': 10, 'Shared Read Blocks': 5 },
        'Planning Time': 12.5,
        'Execution Time': 45.25,
        Plan: {
          'Node Type': 'Seq Scan',
          'Total Cost': 20000,
          'Plan Rows': 100,
          'Actual Rows': 20,
          'Actual Total Time': 1500,
          'Temp Written Blocks': 12,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Plan Rows': 5,
              'Actual Rows': 5,
              'Actual Total Time': 10
            },
            {
              'Node Type': 'Bitmap Heap Scan',
              'Lossy Heap Blocks': 3,
              'Plan Rows': 5,
              'Actual Rows': 150,
              'Actual Total Time': 20
            }
          ]
        }
      }
    ];

    const metrics = analyzer.extractPlanMetrics(explainPlan);
    expect(metrics).to.not.equal(null);
    expect(metrics?.totalCost).to.equal(20000);
    expect(metrics?.planningTime).to.equal(12.5);
    expect(metrics?.executionTime).to.equal(45.25);
    expect(metrics?.sequentialScans).to.equal(1);
    expect(metrics?.indexScans).to.equal(1);
    expect(metrics?.bufferStats?.bufferHits).to.equal(10);
    expect(metrics?.bufferStats?.bufferReads).to.equal(5);
    expect(metrics?.bufferStats?.hitRatio).to.be.closeTo(66.6667, 0.001);
    expect(metrics?.bottlenecks.some(entry => entry.includes('Row estimation mismatch in Seq Scan'))).to.be.true;
    expect(metrics?.bottlenecks.some(entry => entry.includes('Seq Scan took 1500.00ms'))).to.be.true;
    expect(metrics?.recommendations).to.include('Query planning cost is high; consider simplifying the query or analyzing table statistics');
    expect(metrics?.recommendations).to.include('Low buffer hit ratio; consider increasing work_mem or improving indexes');
    expect(metrics?.recommendations.some(entry => entry.startsWith('Review bottlenecks: '))).to.be.true;
    expect(metrics?.lossyBitmapScans).to.equal(1);
    expect(metrics?.spilledToDisk).to.equal(1);
    expect(metrics?.estimateMismatchesOver10x).to.equal(1);
    expect(metrics?.recommendations).to.include('Severe row estimate mismatch (>10x) detected. Run ANALYZE and review join/filter selectivity.');
    expect(metrics?.recommendations).to.include('Lossy bitmap heap scan detected. Consider more selective indexes or reducing bitmap recheck cost.');
    expect(metrics?.recommendations).to.include('Disk spill detected in execution plan. Review work_mem and sort/hash strategy.');

    expect(analyzer.extractPlanMetrics(null)).to.equal(null);
    expect(analyzer.extractPlanMetrics({})).to.equal(null);
  });

  it('tracks function, cte, and subquery scan metrics', () => {
    const explainPlan = [{
      Plan: {
        'Node Type': 'Nested Loop',
        'Total Cost': 300,
        'Plan Rows': 20,
        'Actual Rows': 100,
        'Actual Total Time': 80,
        Plans: [
          {
            'Node Type': 'Function Scan',
            'Function Name': 'public.fn',
            'Plan Rows': 10,
            'Actual Rows': 80,
            'Actual Total Time': 70,
          },
          {
            'Node Type': 'CTE Scan',
            'CTE Name': 'c1',
            'Plan Rows': 5,
            'Actual Rows': 40,
            'Actual Total Time': 30,
            Plans: [
              {
                'Node Type': 'Subquery Scan',
                'Plan Rows': 2,
                'Actual Rows': 20,
                'Actual Total Time': 12,
              },
            ],
          },
        ],
      },
    }];

    const metrics = analyzer.extractPlanMetrics(explainPlan);
    expect(metrics?.functionScans).to.equal(1);
    expect(metrics?.cteScans).to.equal(1);
    expect(metrics?.subqueryScans).to.equal(1);
    expect(metrics?.recommendations).to.include('Function Scan detected. Validate function cost and push filters before invoking set-returning functions.');
    expect(metrics?.recommendations).to.include('CTE Scan detected. Review CTE materialization/reuse and reduce intermediate row width.');
    expect(metrics?.recommendations).to.include('Subquery or subplan nodes detected. Consider flattening nested subqueries when cardinality is high.');
  });

  it('compares performance against baselines', () => {
    const explainPlan = {
      Plan: {
        'Node Type': 'Seq Scan',
        'Total Cost': 100,
        'Plan Rows': 10,
        'Actual Rows': 10,
        'Actual Total Time': 5,
      }
    };

    const noBaseline = analyzer.analyzePerformanceAgainstBaseline(120, null, explainPlan);
    expect(noBaseline.isDegraded).to.be.false;
    expect(noBaseline.baseline).to.equal(null);
    expect(noBaseline.metrics?.sequentialScans).to.equal(1);
    expect(noBaseline.analysis).to.contain('No baseline available for comparison');

    const degraded = analyzer.analyzePerformanceAgainstBaseline(150, {
      queryHash: 'abc123',
      avgExecutionTime: 100,
      minExecutionTime: 80,
      maxExecutionTime: 120,
      stdDev: 5,
      sampleCount: 4,
      lastUpdated: Date.now(),
      m2: 0,
      schemaVersion: 0
    }, explainPlan);
    expect(degraded.isDegraded).to.be.true;
    expect(degraded.degradationPercent).to.equal(50);
    expect(degraded.analysis).to.contain('Performance degradation detected: 50% slower than baseline');

    const withinBaseline = analyzer.analyzePerformanceAgainstBaseline(110, {
      queryHash: 'abc123',
      avgExecutionTime: 100,
      minExecutionTime: 80,
      maxExecutionTime: 120,
      stdDev: 5,
      sampleCount: 4,
      lastUpdated: Date.now(),
      m2: 0,
      schemaVersion: 0
    }, explainPlan);
    expect(withinBaseline.isDegraded).to.be.false;
    expect(withinBaseline.degradationPercent).to.equal(0);
    expect(withinBaseline.analysis).to.contain('Query performance is within baseline');
  });
});
