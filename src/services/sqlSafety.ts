import { ConnectionConfig } from '../common/types';
import { SqlParser } from '../providers/kernel/SqlParser';

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
export class SqlSafetyAnalyzer {
  private static instance: SqlSafetyAnalyzer;

  private constructor() { }

  public static getInstance(): SqlSafetyAnalyzer {
    if (!SqlSafetyAnalyzer.instance) {
      SqlSafetyAnalyzer.instance = new SqlSafetyAnalyzer();
    }
    return SqlSafetyAnalyzer.instance;
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
      connection,
      query
    );

    return {
      isDangerous,
      operations,
      riskScore,
      requiresConfirmation,
      warningMessage: requiresConfirmation
        ? this.buildWarningMessage(operations, connection, query)
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

  /** Session changes that affect completion search_path ordering (refresh catalog cache). */
  public isSearchPathChangingSql(sql: string): boolean {
    const q = SqlParser.stripCommentsAndStrings(sql).trim();
    if (!q) {
      return false;
    }
    return /^\s*set\s+search_path\b/i.test(q);
  }

  public isReadOnlyQuery(query: string): boolean {
    const clean = SqlParser.stripCommentsAndStrings(query).trim();
    if (!clean) {
      return true;
    }
    // Whitelist approach: only allow SELECT, WITH, EXPLAIN, SHOW, VALUES
    if (!/^\s*(SELECT|WITH|EXPLAIN|SHOW|VALUES)\b/i.test(clean)) {
      return false;
    }
    // And must NOT contain write operations (e.g. nested in CTEs)
    return !/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i.test(clean);
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
    connection?: ConnectionConfig,
    query?: string
  ): boolean {
    // Require confirmation for all non-read-only queries (writes) on production connections.
    if (connection?.environment === 'production' && query && !this.isReadOnlyQuery(query)) {
      return true;
    }

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
    connection?: ConnectionConfig,
    query?: string
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

    if (opMessages.length === 0 && connection?.environment === 'production' && query && !this.isReadOnlyQuery(query)) {
      opMessages.push('• Write/execution operation on a production database\n  Impact: Potential modification to production data');
    }

    return (
      envPrefix +
      'This query contains potentially dangerous operations:\n\n' +
      opMessages.join('\n\n') +
      '\n\nAre you sure you want to execute this query?'
    );
  }
}
