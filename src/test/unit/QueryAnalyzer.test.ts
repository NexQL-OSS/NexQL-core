import { expect } from 'chai';

import { QueryAnalyzer } from '../../services/QueryAnalyzer';

describe('QueryAnalyzer', () => {
  const analyzer = QueryAnalyzer.getInstance();

  it('returns the singleton instance', () => {
    expect(QueryAnalyzer.getInstance()).to.equal(analyzer);
  });

  it('detects destructive operations and computes confirmation rules', () => {
    const production = { environment: 'production' } as any;

    const dropResult = analyzer.analyzeQuery('-- comment\nDROP TABLE IF EXISTS public.users;', production);
    expect(dropResult.isDangerous).to.be.true;
    expect(dropResult.operations).to.have.lengthOf(1);
    expect(dropResult.operations[0]).to.include({
      type: 'DROP',
      severity: 'critical',
      hasWhereClause: false,
      estimatedImpact: 'Permanent data loss'
    });
    expect(dropResult.operations[0].affectedObjects).to.deep.equal(['public.users']);
    expect(dropResult.riskScore).to.equal(80);
    expect(dropResult.requiresConfirmation).to.be.true;
    expect(dropResult.warningMessage).to.contain('PRODUCTION DATABASE');
    expect(dropResult.warningMessage).to.contain('Dropping table: public.users');

    const truncateResult = analyzer.analyzeQuery('TRUNCATE TABLE audit_log');
    expect(truncateResult.operations[0]).to.include({
      type: 'TRUNCATE',
      severity: 'critical',
      hasWhereClause: false,
      estimatedImpact: 'All rows will be deleted'
    });
    expect(truncateResult.operations[0].reason).to.contain('Truncating table: audit_log');
    expect(truncateResult.riskScore).to.equal(40);
    expect(truncateResult.requiresConfirmation).to.be.true;

    const insertResult = analyzer.analyzeQuery('INSERT INTO public.events (id) VALUES (1)');
    expect(insertResult.operations[0]).to.include({
      type: 'INSERT',
      severity: 'medium',
      hasWhereClause: false,
      estimatedImpact: 'New rows will be added'
    });
    expect(insertResult.riskScore).to.equal(10);
    expect(insertResult.requiresConfirmation).to.be.false;

    const alterResult = analyzer.analyzeQuery('ALTER TABLE public.users ADD COLUMN active boolean');
    expect(alterResult.operations[0]).to.include({
      type: 'ALTER',
      severity: 'high',
      hasWhereClause: false,
      estimatedImpact: 'New column will be added to the table'
    });
    expect(alterResult.operations[0].reason).to.contain('ADD COLUMN active boolean');
    expect(alterResult.riskScore).to.equal(25);
    expect(alterResult.requiresConfirmation).to.be.true;
    expect(alterResult.warningMessage).to.contain('ADD COLUMN active boolean');

    const createResult = analyzer.analyzeQuery('CREATE TABLE public.logs (id int)', production);
    expect(createResult.operations[0]).to.include({
      type: 'CREATE',
      severity: 'medium',
      hasWhereClause: false,
      estimatedImpact: 'New database object will be created'
    });
    expect(createResult.riskScore).to.equal(20);
    expect(createResult.requiresConfirmation).to.be.true;

    const grantResult = analyzer.analyzeQuery('GRANT SELECT ON public.users TO analyst', production);
    expect(grantResult.operations[0]).to.include({
      type: 'GRANT',
      severity: 'medium',
      hasWhereClause: false,
      estimatedImpact: 'Permission changes'
    });
    expect(grantResult.requiresConfirmation).to.be.true;

    const revokeResult = analyzer.analyzeQuery('REVOKE UPDATE ON public.users FROM analyst');
    expect(revokeResult.operations[0]).to.include({
      type: 'REVOKE',
      severity: 'medium',
      hasWhereClause: false,
      estimatedImpact: 'Permission changes'
    });
    expect(revokeResult.requiresConfirmation).to.be.true;
  });

  it('distinguishes write queries with and without WHERE clauses', () => {
    const production = { environment: 'production' } as any;

    const deleteWithoutWhere = analyzer.analyzeQuery('DELETE FROM public.users');
    expect(deleteWithoutWhere.operations[0]).to.include({
      type: 'DELETE',
      severity: 'critical',
      hasWhereClause: false
    });
    expect(deleteWithoutWhere.riskScore).to.equal(40);
    expect(deleteWithoutWhere.requiresConfirmation).to.be.true;

    const deleteWithWhere = analyzer.analyzeQuery('DELETE FROM public.users WHERE id = 1');
    expect(deleteWithWhere.operations[0]).to.include({
      type: 'DELETE',
      severity: 'medium',
      hasWhereClause: true
    });
    expect(deleteWithWhere.riskScore).to.equal(10);
    expect(deleteWithWhere.requiresConfirmation).to.be.true;

    const updateWithoutWhere = analyzer.analyzeQuery('UPDATE public.users SET active = false', production);
    expect(updateWithoutWhere.operations[0]).to.include({
      type: 'UPDATE',
      severity: 'high',
      hasWhereClause: false
    });
    expect(updateWithoutWhere.riskScore).to.equal(50);
    expect(updateWithoutWhere.requiresConfirmation).to.be.true;

    const updateWithWhere = analyzer.analyzeQuery('UPDATE public.users SET active = false WHERE id = 1', production);
    expect(updateWithWhere.operations[0]).to.include({
      type: 'UPDATE',
      severity: 'medium',
      hasWhereClause: true
    });
    expect(updateWithWhere.riskScore).to.equal(20);
    expect(updateWithWhere.requiresConfirmation).to.be.true;
  });

  it('recognizes read-only queries after stripping comments and whitespace', () => {
    expect(analyzer.isReadOnlyQuery('/* update */\nSELECT 1;')).to.be.true;
    expect(analyzer.isReadOnlyQuery('-- drop table users\nSELECT 1;')).to.be.true;
    expect(analyzer.isReadOnlyQuery('INSERT INTO users (id) VALUES (1);')).to.be.false;
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
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Plan Rows': 5,
              'Actual Rows': 5,
              'Actual Total Time': 10
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

    expect(analyzer.extractPlanMetrics(null)).to.equal(null);
    expect(analyzer.extractPlanMetrics({})).to.equal(null);
  });

  it('hashes normalized queries consistently and compares performance against baselines', () => {
    const hashA = analyzer.getQueryHash('SELECT * FROM users WHERE id = 1');
    const hashB = analyzer.getQueryHash(' select * from users where id = 999 ');
    const hashC = analyzer.getQueryHash('SELECT * FROM users WHERE id = 1 -- comment');

    expect(hashA).to.equal(hashB);
    expect(hashA).to.equal(hashC);

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
      queryHash: hashA,
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
      queryHash: hashA,
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

  it('caps aggregate risk score, applies staging warnings, and treats safe reads as non-dangerous', () => {
    const staging = { environment: 'staging' } as any;

    const heavy = analyzer.analyzeQuery('DROP TABLE users; TRUNCATE audit_logs;', staging);
    expect(heavy.isDangerous).to.be.true;
    expect(heavy.operations).to.have.length.greaterThan(0);
    expect(heavy.riskScore).to.equal(100);
    expect(heavy.warningMessage).to.contain('STAGING DATABASE');
    expect(heavy.warningMessage).to.contain('Truncating table: audit_logs');

    const readOnly = analyzer.analyzeQuery('SELECT * FROM users WHERE id = 1');
    expect(readOnly.isDangerous).to.be.false;
    expect(readOnly.operations).to.deep.equal([]);
    expect(readOnly.riskScore).to.equal(0);
    expect(readOnly.requiresConfirmation).to.be.false;
    expect(readOnly.warningMessage).to.equal(undefined);

    expect(analyzer.isReadOnlyQuery('/* cleanup */\nWITH x AS (SELECT 1) SELECT * FROM x;')).to.be.true;
    expect(analyzer.isReadOnlyQuery('WITH d AS (DELETE FROM users WHERE id=1) SELECT * FROM d;')).to.be.false;
  });

  it('detects SET search_path as session metadata invalidating completion ordering', () => {
    expect(analyzer.isSearchPathChangingSql('SET search_path TO foo, public')).to.be.true;
    expect(analyzer.isSearchPathChangingSql('SET search_path = bar')).to.be.true;
    expect(analyzer.isSearchPathChangingSql('SELECT set_search_path')).to.be.false;
    expect(analyzer.isSearchPathChangingSql('SELECT 1')).to.be.false;
  });
});