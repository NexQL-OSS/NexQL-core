import { Client, PoolClient } from 'pg';
import * as vscode from 'vscode';

export type IsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
export type TransactionState = 'idle' | 'active' | 'failed';

export interface TransactionInfo {
  isActive: boolean;
  state: TransactionState;
  isolationLevel: IsolationLevel;
  startTime: number | null;
  savepointStack: string[];
  autoRollback: boolean;
  readOnly: boolean;
  deferrable: boolean;
}

export interface SavepointInfo {
  name: string;
  timestamp: number;
}

/**
 * Manages PostgreSQL transactions for notebook sessions
 * Tracks transaction state, savepoints, and auto-rollback behavior
 */
export class TransactionManager {
  private transactions: Map<string, TransactionInfo> = new Map();
  private connectionClients: Map<string, Client | PoolClient> = new Map();
  private savepointCounters: Map<string, number> = new Map();

  public static readonly DEFAULT_SAVEPOINT_PREFIX = 'sp_nexql_';

  /**
   * Initialize transaction tracking for a session
   */
  public initializeSession(sessionId: string, autoRollback: boolean = false): void {
    this.transactions.set(sessionId, {
      isActive: false,
      state: 'idle',
      isolationLevel: 'READ COMMITTED',
      startTime: null,
      savepointStack: [],
      autoRollback,
      readOnly: false,
      deferrable: false
    });
    this.savepointCounters.set(sessionId, 0);
  }

  /**
   * Get current transaction info for a session
   */
  public getTransactionInfo(sessionId: string): TransactionInfo | null {
    return this.transactions.get(sessionId) || null;
  }

  /**
   * Start a new transaction with optional configuration
   */
  public async beginTransaction(
    client: Client | PoolClient,
    sessionId: string,
    isolationLevel: IsolationLevel = 'READ COMMITTED',
    readOnly: boolean = false,
    deferrable: boolean = false
  ): Promise<void> {
    if (!this.transactions.has(sessionId)) {
      this.initializeSession(sessionId);
    }

    const txInfo = this.transactions.get(sessionId)!;
    if (txInfo.isActive) {
      throw new Error('Transaction already active. Commit or rollback before starting a new one.');
    }

    const beginSql = this.buildBeginStatement(isolationLevel, readOnly, deferrable);

    try {
      await client.query(beginSql);

      txInfo.isActive = true;
      txInfo.state = 'active';
      txInfo.isolationLevel = isolationLevel;
      txInfo.startTime = Date.now();
      txInfo.savepointStack = [];
      txInfo.readOnly = readOnly;
      txInfo.deferrable = deferrable;

      this.connectionClients.set(sessionId, client);
    } catch (err) {
      txInfo.state = 'failed';
      throw err;
    }
  }

  /**
   * Commit the current transaction
   */
  public async commitTransaction(client: Client | PoolClient, sessionId: string): Promise<void> {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo || !txInfo.isActive) {
      throw new Error('No active transaction to commit');
    }

    try {
      await client.query('COMMIT');
      this.resetTransactionState(sessionId);
    } catch (err) {
      txInfo.state = 'failed';
      throw err;
    }
  }

  /**
   * Rollback the current transaction
   */
  public async rollbackTransaction(client: Client | PoolClient, sessionId: string): Promise<void> {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo || !txInfo.isActive) {
      throw new Error('No active transaction to rollback');
    }

    try {
      await client.query('ROLLBACK');
      this.resetTransactionState(sessionId);
    } catch (err) {
      txInfo.state = 'failed';
      throw err;
    }
  }

  /**
   * Create a savepoint within the current transaction
   */
  public async createSavepoint(client: Client | PoolClient, sessionId: string, customName?: string): Promise<string> {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo || !txInfo.isActive) {
      throw new Error('No active transaction for savepoint creation');
    }

    const counter = (this.savepointCounters.get(sessionId) || 0) + 1;
    this.savepointCounters.set(sessionId, counter);

    const savepointName = customName || `${TransactionManager.DEFAULT_SAVEPOINT_PREFIX}${counter}`;

    try {
      await client.query(`SAVEPOINT "${savepointName}"`);
      txInfo.savepointStack.push(savepointName);
      return savepointName;
    } catch (err) {
      txInfo.state = 'failed';
      throw err;
    }
  }

  /**
   * Rollback to a savepoint
   */
  public async rollbackToSavepoint(client: Client | PoolClient, sessionId: string, savepointName?: string): Promise<void> {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo || !txInfo.isActive) {
      throw new Error('No active transaction for savepoint rollback');
    }

    const targetSavepoint = savepointName || txInfo.savepointStack[txInfo.savepointStack.length - 1];
    if (!targetSavepoint) {
      throw new Error('No savepoint available for rollback');
    }

    try {
      await client.query(`ROLLBACK TO SAVEPOINT "${targetSavepoint}"`);

      // Remove all savepoints up to and including the target
      const index = txInfo.savepointStack.indexOf(targetSavepoint);
      if (index >= 0) {
        txInfo.savepointStack = txInfo.savepointStack.slice(0, index);
      }
    } catch (err) {
      txInfo.state = 'failed';
      throw err;
    }
  }

  /**
   * Release a savepoint (making it permanent within the transaction)
   */
  public async releaseSavepoint(client: Client | PoolClient, sessionId: string, savepointName?: string): Promise<void> {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo || !txInfo.isActive) {
      throw new Error('No active transaction for savepoint release');
    }

    const targetSavepoint = savepointName || txInfo.savepointStack[txInfo.savepointStack.length - 1];
    if (!targetSavepoint) {
      throw new Error('No savepoint available for release');
    }

    try {
      await client.query(`RELEASE SAVEPOINT "${targetSavepoint}"`);

      // Remove from stack
      const index = txInfo.savepointStack.indexOf(targetSavepoint);
      if (index >= 0) {
        txInfo.savepointStack.splice(index, 1);
      }
    } catch (err) {
      txInfo.state = 'failed';
      throw err;
    }
  }

  /**
   * Auto-rollback on cell error (if enabled)
   */
  public async handleCellError(client: Client | PoolClient, sessionId: string, error: Error): Promise<void> {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo || !txInfo.isActive) {
      return;
    }

    if (txInfo.autoRollback) {
      try {
        // Try to rollback to last savepoint if available
        if (txInfo.savepointStack.length > 0) {
          await this.rollbackToSavepoint(client, sessionId);
          txInfo.state = 'active';
        } else {
          // Otherwise abort entire transaction
          await this.rollbackTransaction(client, sessionId);
        }
      } catch (rollbackErr) {
        console.error('Auto-rollback failed:', rollbackErr);
        txInfo.state = 'failed';
      }
    } else {
      // Mark transaction as failed but don't rollback
      txInfo.state = 'failed';
    }
  }

  /**
   * Get all active savepoints for the session
   */
  public getSavepoints(sessionId: string): SavepointInfo[] {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo) return [];

    return txInfo.savepointStack.map((name, index) => ({
      name,
      timestamp: index
    }));
  }

  /**
   * Change isolation level (must be outside transaction)
   */
  public async setIsolationLevel(client: Client | PoolClient, level: IsolationLevel): Promise<void> {
    const query = `SET TRANSACTION ISOLATION LEVEL ${level}`;
    try {
      await client.query(query);
    } catch (err) {
      throw new Error(`Failed to set isolation level: ${err}`);
    }
  }

  /**
   * Check if transaction is in failed state (requires ROLLBACK)
   */
  public isTransactionFailed(sessionId: string): boolean {
    const txInfo = this.transactions.get(sessionId);
    return txInfo?.state === 'failed' || false;
  }

  /**
   * Cleanup session on disconnect
   */
  public cleanupSession(sessionId: string): void {
    this.transactions.delete(sessionId);
    this.connectionClients.delete(sessionId);
    this.savepointCounters.delete(sessionId);
  }

  /**
   * Get transaction summary for UI display
   */
  public getTransactionSummary(sessionId: string): string {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo) return 'No connection';

    if (!txInfo.isActive) {
      return 'No transaction';
    }

    const duration = txInfo.startTime ? `${Math.round((Date.now() - txInfo.startTime) / 1000)}s` : '—';
    const savepoints = txInfo.savepointStack.length > 0 ? ` + ${txInfo.savepointStack.length} savepoint(s)` : '';
    const mode = txInfo.readOnly ? ' [READ-ONLY]' : '';

    return `🔄 Transaction Active (${txInfo.isolationLevel})${mode} — ${duration}${savepoints}`;
  }

  /**
   * Get transaction state for toolbar UI
   */
  public getTransactionState(sessionId: string): { isActive: boolean; isFailed: boolean; savepointCount: number } {
    const txInfo = this.transactions.get(sessionId);
    if (!txInfo) {
      return { isActive: false, isFailed: false, savepointCount: 0 };
    }

    return {
      isActive: txInfo.isActive,
      isFailed: txInfo.state === 'failed',
      savepointCount: txInfo.savepointStack.length
    };
  }

  /**
   * Build BEGIN statement with options
   */
  private buildBeginStatement(
    isolationLevel: IsolationLevel,
    readOnly: boolean,
    deferrable: boolean
  ): string {
    const parts = ['BEGIN'];

    if (isolationLevel !== 'READ COMMITTED') {
      parts.push(`ISOLATION LEVEL ${isolationLevel}`);
    }

    if (readOnly) {
      parts.push('READ ONLY');
    } else {
      parts.push('READ WRITE');
    }

    if (deferrable && readOnly) {
      parts.push('DEFERRABLE');
    }

    return parts.join(' ');
  }

  /**
   * Reset transaction state to idle
   */
  private resetTransactionState(sessionId: string): void {
    const txInfo = this.transactions.get(sessionId);
    if (txInfo) {
      txInfo.isActive = false;
      txInfo.state = 'idle';
      txInfo.startTime = null;
      txInfo.savepointStack = [];
      txInfo.readOnly = false;
      txInfo.deferrable = false;
    }
    this.savepointCounters.set(sessionId, 0);
  }
}

// Singleton instance
let transactionManagerInstance: TransactionManager;

export function getTransactionManager(): TransactionManager {
  if (!transactionManagerInstance) {
    transactionManagerInstance = new TransactionManager();
  }
  return transactionManagerInstance;
}
