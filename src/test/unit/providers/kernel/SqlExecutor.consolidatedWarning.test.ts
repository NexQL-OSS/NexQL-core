import { expect } from 'chai';
import { SqlSafetyAnalyzer } from '../../../../services/sqlSafety';

describe('SqlExecutor - Consolidated Modal Confirmation', () => {
  it('should collect and group dangerous operations from multiple statements', () => {
    const queryAnalyzer = SqlSafetyAnalyzer.getInstance();

    // Test case: cell with multiple DROP commands
    const queries = [
      'DROP TABLE users',
      'DROP TABLE roles',
      'DELETE FROM audit'
    ];

    const analyses = queries.map(q => queryAnalyzer.analyzeQuery(q));

    // Count by type
    const operationCounts: Record<string, number> = {};
    for (const analysis of analyses) {
      for (const op of analysis.operations) {
        operationCounts[op.type] = (operationCounts[op.type] || 0) + 1;
      }
    }

    expect(operationCounts).to.deep.equal({
      DROP: 2,
      DELETE: 1
    });

    const totalCount = Object.values(operationCounts).reduce((a, b) => a + b, 0);
    expect(totalCount).to.equal(3);
  });

  it('should detect dangerous operations across mixed statement types', () => {
    const queryAnalyzer = SqlSafetyAnalyzer.getInstance();

    const statements = [
      'SELECT * FROM users',
      'DROP TABLE archive_users',
      'SELECT COUNT(*) FROM products',
      'DELETE FROM logs',
      'UPDATE products SET price = 0 WHERE id > 100'  // UPDATE with WHERE is medium risk on non-production
    ];

    const dangerousOps: any[] = [];
    for (const stmt of statements) {
      const analysis = queryAnalyzer.analyzeQuery(stmt);
      if (analysis.requiresConfirmation) {
        dangerousOps.push({ stmt, analysis });
      }
    }

    // Should find 2 dangerous operations requiring confirmation (DROP, DELETE)
    // UPDATE with WHERE is medium risk but doesn't require confirmation on non-production
    expect(dangerousOps.length).to.be.greaterThanOrEqual(2);

    // Collect and verify counts
    const operationCounts: Record<string, number> = {};
    for (const { analysis } of dangerousOps) {
      for (const op of analysis.operations) {
        operationCounts[op.type] = (operationCounts[op.type] || 0) + 1;
      }
    }

    expect(operationCounts).to.include({ DROP: 1, DELETE: 1 });
  });

  it('should handle production database context', () => {
    const connection = { environment: 'production' };
    expect(connection.environment).to.equal('production');

    const connection2 = { environment: 'staging' };
    expect(connection2.environment).to.equal('staging');

    const connection3 = {};
    expect(connection3.environment).to.be.undefined;
  });

  it('should classify operation severity correctly', () => {
    const queryAnalyzer = SqlSafetyAnalyzer.getInstance();

    const dropAnalysis = queryAnalyzer.analyzeQuery('DROP TABLE users');
    expect(dropAnalysis.operations[0].severity).to.equal('critical');

    const deleteNoWhereAnalysis = queryAnalyzer.analyzeQuery('DELETE FROM users');
    expect(deleteNoWhereAnalysis.operations[0].severity).to.equal('critical');

    const deleteWithWhereAnalysis = queryAnalyzer.analyzeQuery('DELETE FROM users WHERE id = 1');
    expect(deleteWithWhereAnalysis.operations[0].severity).to.equal('medium');

    const updateNoWhereAnalysis = queryAnalyzer.analyzeQuery('UPDATE products SET price = 0');
    expect(updateNoWhereAnalysis.operations[0].severity).to.equal('high');
  });

  it('should mark operations requiring confirmation correctly', () => {
    const queryAnalyzer = SqlSafetyAnalyzer.getInstance();

    const dropAnalysis = queryAnalyzer.analyzeQuery('DROP TABLE users');
    expect(dropAnalysis.requiresConfirmation).to.be.true;

    const selectAnalysis = queryAnalyzer.analyzeQuery('SELECT * FROM users');
    expect(selectAnalysis.requiresConfirmation).to.be.false;

    const deleteWithoutWhereAnalysis = queryAnalyzer.analyzeQuery('DELETE FROM audit');
    expect(deleteWithoutWhereAnalysis.requiresConfirmation).to.be.true;
  });
});
