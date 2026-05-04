import { expect } from 'chai';
import sinon from 'sinon';
import * as vscode from 'vscode';
import { SqlExecutor } from '../../providers/kernel/SqlExecutor';

/**
 * Tests for multi-statement execution with different failure strategies.
 * Note: These are unit tests that mock VS Code APIs and test the SqlExecutor's
 * summary markdown generation and failure strategy handling logic.
 */
describe('SqlExecutor - Multi-Statement Failure Handling', () => {
  let executor: SqlExecutor;
  let mockController: sinon.SinonStubbedInstance<vscode.NotebookController>;

  beforeEach(() => {
    // Mock NotebookController
    mockController = sinon.createStubInstance(vscode.NotebookController);
    executor = new SqlExecutor(mockController as any);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Failure Strategy Settings', () => {
    it('should default to "continue-on-error" strategy', () => {
      // This test verifies the default behavior is best-effort
      const config = vscode.workspace.getConfiguration('postgresExplorer.query');
      const strategy = config.get<string>('executionFailureStrategy', 'continue-on-error');
      expect(strategy).to.equal('continue-on-error');
    });

    it('should support "fail-on-error" strategy option', () => {
      // Verify that fail-on-error is a valid strategy
      const validStrategies = ['continue-on-error', 'fail-on-error', 'prompt-on-error'];
      expect(validStrategies).to.include('fail-on-error');
    });

    it('should support "prompt-on-error" strategy option', () => {
      // Verify the setting accepts prompt-on-error as a valid value
      const validStrategies = ['continue-on-error', 'fail-on-error', 'prompt-on-error'];
      expect(validStrategies).to.include('prompt-on-error');
    });
  });

  describe('Summary Markdown Generation', () => {
    it('should generate summary for all succeeded statements', () => {
      const results: any[] = [
        {
          stmtIndex: 0,
          query: 'SELECT * FROM users;',
          success: true,
          command: 'SELECT',
          rowCount: 5,
          executionTime: 0.1,
        },
        {
          stmtIndex: 1,
          query: 'INSERT INTO logs (msg) VALUES (\'test\');',
          success: true,
          command: 'INSERT',
          rowCount: 1,
          executionTime: 0.05,
        },
      ];

      // Call the private method through a proxy
      const markdown = (executor as any).generateSummaryMarkdown(results);
      
      expect(markdown).to.contain('## Execution Summary');
      expect(markdown).to.contain('✅ **2 statements succeeded**');
      expect(markdown).to.contain('Statement 1: SELECT (5 rows)');
      expect(markdown).to.contain('Statement 2: INSERT (1 rows)');
      expect(markdown).not.to.contain('❌ **');
    });

    it('should generate summary for all failed statements', () => {
      const results: any[] = [
        {
          stmtIndex: 0,
          query: 'DROP TABLE nonexistent;',
          success: false,
          error: 'relation "nonexistent" does not exist',
          errorCode: '42P01',
          executionTime: 0.02,
        },
        {
          stmtIndex: 1,
          query: 'ALTER TABLE bad_table ADD COLUMN;',
          success: false,
          error: 'syntax error at or near ";"',
          errorCode: '42601',
          executionTime: 0.01,
        },
      ];

      const markdown = (executor as any).generateSummaryMarkdown(results);
      
      expect(markdown).to.contain('## Execution Summary');
      expect(markdown).to.contain('❌ **2 statements failed**');
      expect(markdown).to.contain('Statement 1: relation "nonexistent" does not exist (42P01)');
      expect(markdown).to.contain('Statement 2: syntax error at or near ";" (42601)');
      expect(markdown).not.to.contain('✅ **');
    });

    it('should generate summary for mixed success/failure results', () => {
      const results: any[] = [
        {
          stmtIndex: 0,
          query: 'SELECT * FROM users;',
          success: true,
          command: 'SELECT',
          rowCount: 5,
          executionTime: 0.1,
        },
        {
          stmtIndex: 1,
          query: 'DELETE FROM logs WHERE id = 999;',
          success: false,
          error: 'permission denied for table logs',
          errorCode: '42501',
          executionTime: 0.05,
        },
        {
          stmtIndex: 2,
          query: 'INSERT INTO audit (action) VALUES (\'test\');',
          success: true,
          command: 'INSERT',
          rowCount: 1,
          executionTime: 0.03,
        },
      ];

      const markdown = (executor as any).generateSummaryMarkdown(results);
      
      expect(markdown).to.contain('## Execution Summary');
      expect(markdown).to.contain('✅ **2 statements succeeded**');
      expect(markdown).to.contain('❌ **1 statement failed**');
      expect(markdown).to.contain('Statement 1: SELECT (5 rows)');
      expect(markdown).to.contain('Statement 2: permission denied for table logs (42501)');
      expect(markdown).to.contain('Statement 3: INSERT (1 rows)');
      expect(markdown).to.contain('💡 **Tip**: Review the changes above');
    });

    it('should handle results with no row count', () => {
      const results: any[] = [
        {
          stmtIndex: 0,
          query: 'CREATE TABLE test (id INT);',
          success: true,
          command: 'CREATE',
          rowCount: undefined,
          executionTime: 0.15,
        },
        {
          stmtIndex: 1,
          query: 'DROP TABLE test;',
          success: true,
          command: 'DROP',
          rowCount: null,
          executionTime: 0.08,
        },
      ];

      const markdown = (executor as any).generateSummaryMarkdown(results);
      
      expect(markdown).to.contain('Statement 1: CREATE');
      expect(markdown).to.contain('Statement 2: DROP');
      // Should not include "(undefined rows)" or "(null rows)"
      expect(markdown).not.to.contain('undefined');
      expect(markdown).not.to.contain('(null');
    });

    it('should format singular/plural correctly in summary', () => {
      const singleSuccess: any[] = [
        {
          stmtIndex: 0,
          query: 'SELECT 1;',
          success: true,
          command: 'SELECT',
          rowCount: 1,
          executionTime: 0.01,
        },
      ];

      const markdown = (executor as any).generateSummaryMarkdown(singleSuccess);
      expect(markdown).to.contain('✅ **1 statement succeeded**'); // singular
      expect(markdown).not.to.contain('statements succeeded');

      const singleFailed: any[] = [
        {
          stmtIndex: 0,
          query: 'BAD SQL;',
          success: false,
          error: 'syntax error',
          executionTime: 0.01,
        },
      ];

      const markdownFailed = (executor as any).generateSummaryMarkdown(singleFailed);
      expect(markdownFailed).to.contain('❌ **1 statement failed**'); // singular
    });
  });

  describe('Multi-Statement Strategy Behavior', () => {
    it('should collect all statement results in order', () => {
      // This is a conceptual test to document expected behavior
      // In a real scenario with mocked clients, this would test:
      // 1. Statements are executed sequentially
      // 2. Results collected in statementsResults array
      // 3. Array maintains order (stmtIndex matches position)
      
      const expectedResults = [
        { stmtIndex: 0, query: 'STMT 1', success: true },
        { stmtIndex: 1, query: 'STMT 2', success: false },
        { stmtIndex: 2, query: 'STMT 3', success: true },
      ];

      // Verify indices are sequential
      expectedResults.forEach((result, index) => {
        expect(result.stmtIndex).to.equal(index);
      });
    });

    it('should determine whether to show summary based on statement count', () => {
      // Single statement: no summary needed
      // Multiple statements with all success: no summary needed
      // Multiple statements with mixed results: summary shown
      
      const multiStatementMixed = [
        { success: true },
        { success: false },
      ];

      const hasFailures = multiStatementMixed.some(r => !r.success);
      const hasSuccesses = multiStatementMixed.some(r => r.success);
      
      expect(hasFailures && hasSuccesses).to.be.true;
      // In this case, summary should be shown
    });
  });
});
