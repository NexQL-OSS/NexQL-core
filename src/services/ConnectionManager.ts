import { Client, Pool, PoolClient, ClientConfig, PoolConfig } from 'pg';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { ConnectionConfig } from '../common/types';
import { SecretStorageService } from './SecretStorageService';
import { SSHService } from './SSHService';
import { ErrorService } from './ErrorService';
import { resolvePgPassPassword, pgPassFileDescription } from '../utils/pgPassUtils';
import { TelemetryService } from './TelemetryService';
import { debugLog, debugWarn } from '../common/logger';

export interface PoolMetrics {
  connectionId: string;
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
  createdAt: number;
  lastActivity: number;
}

export class ConnectionManager {
  private static instance: ConnectionManager;
  private pools: Map<string, Pool> = new Map();
  private sessions: Map<string, Client> = new Map();
  private poolMetrics: Map<string, PoolMetrics> = new Map();

  // Configuration for pool management
  private readonly IDLE_TIMEOUT = 300000; // 5 minutes
  private readonly CLEANUP_INTERVAL = 60000; // Check every 1 minute
  private cleanupTimer?: NodeJS.Timeout;

  private constructor() {
    // Start background cleanup of idle pools
    this.startCleanupRoutine();
  }

  public static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  /**
   * Start background cleanup routine for idle connections
   */
  private startCleanupRoutine(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdlePools();
    }, this.CLEANUP_INTERVAL);
    this.cleanupTimer?.unref();
  }

  /**
   * Close idle pools that haven't been used recently
   */
  private async cleanupIdlePools(): Promise<void> {
    const now = Date.now();
    const poolsToClose: string[] = [];

    for (const [key, metrics] of this.poolMetrics.entries()) {
      if (now - metrics.lastActivity > this.IDLE_TIMEOUT && metrics.totalConnections === 0) {
        poolsToClose.push(key);
      }
    }

    for (const key of poolsToClose) {
      const pool = this.pools.get(key);
      if (pool) {
        try {
          await pool.end();
          this.pools.delete(key);
          this.poolMetrics.delete(key);
        } catch (err) {
          console.error(`Error closing idle pool ${key}:`, err);
        }
      }
    }
  }

  /**
   * Get metrics for a connection pool
   */
  public getPoolMetrics(connectionId: string): PoolMetrics | undefined {
    return this.poolMetrics.get(connectionId);
  }

  /**
   * Get all pool metrics
   */
  public getAllPoolMetrics(): PoolMetrics[] {
    return Array.from(this.poolMetrics.values());
  }

  private isSSLFailure(err: any): boolean {
    if (!err) return false;
    const msg = (err.message || '').toString().toLowerCase();
    // Common errors when server doesn't support SSL or handshake fails gracefully
    return (
      msg.includes('server does not support ssl') ||
      err.code === 'ECONNRESET' ||
      err.code === 'EPROTO'
    );
  }

  private shouldFallback(config: ConnectionConfig, err: any): boolean {
    // Never downgrade SSL in production-tagged environments.
    if (config.environment === 'production') {
      return false;
    }
    const sslMode = config.sslmode || 'prefer';
    // Only fallback if mode is prefer (or 'allow' - rare)
    // require, verify-ca, verify-full should NOT fallback
    if (sslMode !== 'prefer' && sslMode !== 'allow') {
      return false;
    }
    return this.isSSLFailure(err);
  }

  /** Get a pooled client for ephemeral operations. Caller MUST release when done. */
  public async getPooledClient(config: ConnectionConfig): Promise<PoolClient> {
    const telemetry = TelemetryService.getInstance();
    const key = this.getConnectionKey(config);
    let pool = this.pools.get(key);
    let trackNewPooledConnection = false;

    if (!pool) {
      const clientConfig = await this.createClientConfig(config);
      pool = this.createPool(clientConfig, key);
      this.pools.set(key, pool);
      trackNewPooledConnection = true;
    }

    try {
      const client = await pool.connect();
      if (trackNewPooledConnection) {
        telemetry.trackEvent('connection_opened', { connectionKind: 'pooled' });
      }

      // Apply read-only mode if configured
      if (config.readOnlyMode) {
        try {
          await client.query('SET default_transaction_read_only = ON');
        } catch (err) {
          debugWarn('Failed to set read-only mode:', err);
        }
      }

      return client;
    } catch (err: any) {
      telemetry.trackEvent('connection_error', { errorCategory: this.categorizeConnectionError(err) });
      // Handle SSL Fallback
      if (this.shouldFallback(config, err)) {
        debugWarn(`SSL connection failed for ${key}, falling back to non-SSL`, err);

        // Remove the failed pool
        this.pools.delete(key);
        try {
          await pool.end();
        } catch (e) {
          console.error(`Error closing failed SSL pool for ${key}:`, e);
        }

        // Create non-SSL pool
        const clientConfig = await this.createClientConfig(config, true);
        pool = this.createPool(clientConfig, key);
        this.pools.set(key, pool);

        const client = await pool.connect();
        telemetry.trackEvent('connection_opened', { connectionKind: 'pooled' });

        // Apply read-only mode if configured
        if (config.readOnlyMode) {
          try {
            await client.query('SET default_transaction_read_only = ON');
          } catch (err) {
            debugWarn('Failed to set read-only mode:', err);
          }
        }

        return client;
      }

      if (config.environment === 'production' && this.isSSLFailure(err)) {
        const enrichedError = new Error(
          `Production connection failed: ${err.message || 'SSL connection failed'}.\n\n` +
          `Security Alert: NexQL blocked automatic SSL downgrade on a Production environment to protect your credentials. ` +
          `If your database does not support SSL or you are using a secure SSH tunnel, please open Connection Settings, expand Advanced Options, and explicitly set SSL Mode to "Disable — No SSL".`
        );
        (enrichedError as any).code = (err as any).code;
        throw enrichedError;
      }

      throw err;
    }
  }

  private createPool(clientConfig: ClientConfig, key: string): Pool {
    const poolConfig: PoolConfig = {
      ...clientConfig,
      max: 10,
      idleTimeoutMillis: 30000,
    };
    const pool = new Pool(poolConfig);
    pool.on('error', (err) => {
      console.error(`Pool error for ${key}`, err);
      // Don't show modal for background pool errors, but could log to output channel in future
    });
    return pool;
  }

  /** Get a persistent client for a session (notebooks, transactions). */
  public async getSessionClient(config: ConnectionConfig, sessionId: string): Promise<Client> {
    const telemetry = TelemetryService.getInstance();
    const key = `${this.getConnectionKey(config)}:session:${sessionId}`;
    if (this.sessions.has(key)) return this.sessions.get(key)!;

    // Try default/primary config first (usually SSL)
    const clientConfig = await this.createClientConfig(config);
    let client = new Client(clientConfig);

    try {
      await client.connect();
      telemetry.trackEvent('connection_opened', { connectionKind: 'session' });

      // Apply read-only mode if configured
      if (config.readOnlyMode) {
        try {
          await client.query('SET default_transaction_read_only = ON');
        } catch (err) {
          debugWarn('Failed to set read-only mode:', err);
        }
      }
    } catch (err: any) {
      if (this.shouldFallback(config, err)) {
        debugWarn(`Session SSL connection failed for ${key}, falling back to non-SSL`, err);

        // Retry with SSL disabled
        const nonSSLConfig = await this.createClientConfig(config, true);
        client = new Client(nonSSLConfig);
        await client.connect();
        telemetry.trackEvent('connection_opened', { connectionKind: 'session' });

        // Apply read-only mode if configured
        if (config.readOnlyMode) {
          try {
            await client.query('SET default_transaction_read_only = ON');
          } catch (err) {
            debugWarn('Failed to set read-only mode:', err);
          }
        }
      } else {
        telemetry.trackEvent('connection_error', { errorCategory: this.categorizeConnectionError(err) });
        if (config.environment === 'production' && this.isSSLFailure(err)) {
          const enrichedError = new Error(
            `Production connection failed: ${err.message || 'SSL connection failed'}.\n\n` +
            `Security Alert: NexQL blocked automatic SSL downgrade on a Production environment to protect your credentials. ` +
            `If your database does not support SSL or you are using a secure SSH tunnel, please open Connection Settings, expand Advanced Options, and explicitly set SSL Mode to "Disable — No SSL".`
          );
          (enrichedError as any).code = (err as any).code;
          throw enrichedError;
        }
        throw err;
      }
    }

    client.on('end', () => this.sessions.delete(key));
    client.on('error', (err) => {
      telemetry.trackEvent('connection_error', { errorCategory: this.categorizeConnectionError(err) });
      console.error(`Session client error for ${key}`, err);
      ErrorService.getInstance().showError(
        `Session connection error (${config.name}): ${err.message}`,
      );
      this.sessions.delete(key);
    });
    this.sessions.set(key, client);
    return client;
  }

  public async closeSession(config: ConnectionConfig, sessionId: string): Promise<void> {
    const key = `${this.getConnectionKey(config)}:session:${sessionId}`;
    const client = this.sessions.get(key);
    if (client) {
      try {
        await client.end();
      } catch (e) {
        console.error(`Error closing session ${key}:`, e);
      }
      this.sessions.delete(key);
      TelemetryService.getInstance().trackEvent('connection_closed', { reason: 'session_end' });
    }
  }

  /** Close all pools and sessions for a connection */
  public async closeConnection(config: ConnectionConfig): Promise<void> {
    const baseKey = this.getConnectionKey(config);
    const pool = this.pools.get(baseKey);
    if (pool) {
      try {
        await pool.end();
      } catch (e) {
        console.error(`Error closing pool ${baseKey}`, e);
      }
      this.pools.delete(baseKey);
    }

    for (const [key, client] of this.sessions.entries()) {
      if (key.startsWith(baseKey)) {
        try {
          await client.end();
        } catch (e) {
          console.error(`Error closing session ${key}`, e);
        }
        this.sessions.delete(key);
      }
    }
  }
  /** Remove all connections for a connection ID regardless of DB */
  public async closeAllConnectionsById(connectionId: string): Promise<void> {
    const poolKeysToRemove: string[] = [];
    for (const key of this.pools.keys()) {
      if (key.startsWith(`${connectionId}:`)) {
        poolKeysToRemove.push(key);
      }
    }

    for (const key of poolKeysToRemove) {
      const pool = this.pools.get(key);
      if (pool) {
        await pool.end().catch((e) => console.error(`Error ending pool ${key}`, e));
        this.pools.delete(key);
      }
    }
    const sessionKeysToRemove: string[] = [];
    for (const key of this.sessions.keys()) {
      if (key.startsWith(`${connectionId}:`)) sessionKeysToRemove.push(key);
    }

    for (const key of sessionKeysToRemove) {
      const client = this.sessions.get(key);
      if (client) {
        await client.end().catch((e) => console.error(`Error ending session ${key}`, e));
        this.sessions.delete(key);
      }
    }

    debugLog(`Closed resources for ID: ${connectionId}`);
  }

  public async closeAll(): Promise<void> {
    for (const pool of this.pools.values()) {
      await pool.end().catch((e) => console.error('Error closing pool', e));
    }
    this.pools.clear();

    for (const client of this.sessions.values()) {
      await client.end().catch((e) => console.error('Error closing session', e));
    }
    this.sessions.clear();
    TelemetryService.getInstance().trackEvent('connection_closed', { reason: 'close_all' });
  }

  private categorizeConnectionError(err: unknown): string {
    const message = String((err as any)?.message ?? err ?? '').toLowerCase();
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('auth') || message.includes('password')) return 'auth';
    if (message.includes('ssl') || message.includes('certificate')) return 'ssl';
    if (message.includes('network') || message.includes('econn') || message.includes('enotfound')) return 'network';
    return 'unknown';
  }

  private getConnectionKey(config: ConnectionConfig): string {
    return `${config.id}:${config.database || 'postgres'}`;
  }

  private async createClientConfig(
    config: ConnectionConfig,
    forceDisableSSL: boolean = false,
  ): Promise<ClientConfig> {
    let password: string | undefined;

    // 1) Primary: password stored in VSCode SecretStorage (set during connection setup)
    if (config.username && config.id) {
      password = await SecretStorageService.getInstance().getPassword(config.id);
    }

    // 2) Secondary fallback: resolve from .pgpass file
    //    Only attempt this when the user has explicitly configured a username.
    //    We do NOT use the OS default username here, because that would silently
    //    resolve a wrong .pgpass entry for connections that rely on trust auth.
    if (!password && config.username) {
      const targetDb = config.database || 'postgres';
      const pgpassPwd = resolvePgPassPassword(config.host, config.port, targetDb, config.username);
      if (pgpassPwd !== undefined) {
        password = pgpassPwd;
        debugLog(
          `[ConnectionManager] Password resolved from .pgpass for ${config.username}@${config.host}:${config.port}/${targetDb}`,
        );
      } else if (targetDb !== 'postgres') {
        const fallback = resolvePgPassPassword(
          config.host,
          config.port,
          'postgres',
          config.username,
        );
        if (fallback !== undefined) {
          password = fallback;
          debugLog(
            `[ConnectionManager] Password resolved from .pgpass (postgres fallback) for ${config.username}@${config.host}:${config.port}`,
          );
        }
      }
      if (!password) {
        debugLog(
          `[ConnectionManager] No password found in SecretStorage or .pgpass for ${config.username}@${config.host}. Expected: ${pgPassFileDescription()}`,
        );
      }
    }

    let sslConfig: boolean | any = false;
    // Default to 'prefer' if empty/undefined.
    // If forceDisableSSL is true, we ignore sslmode and leave sslConfig as false.
    const sslMode = config.sslmode || 'prefer';

    if (!forceDisableSSL && sslMode !== 'disable') {
      sslConfig = {
        rejectUnauthorized: sslMode === 'verify-ca' || sslMode === 'verify-full',
      };

      if (config.sslRootCertPath) {
        try {
          sslConfig.ca = fs.readFileSync(config.sslRootCertPath).toString();
        } catch (e) {
          debugWarn('Failed to read SSL CA:', e);
        }
      }
      if (config.sslCertPath) {
        try {
          sslConfig.cert = fs.readFileSync(config.sslCertPath).toString();
        } catch (e) {
          debugWarn('Failed to read SSL Cert:', e);
        }
      }
      if (config.sslKeyPath) {
        try {
          sslConfig.key = fs.readFileSync(config.sslKeyPath).toString();
        } catch (e) {
          debugWarn('Failed to read SSL Key:', e);
        }
      }
    }

    const clientConfig: ClientConfig = {
      user: config.username || undefined,
      password: password || undefined,
      database: config.database || 'postgres',
      connectionTimeoutMillis: (config.connectTimeout || 15) * 1000,
      statement_timeout:
        config.statementTimeout ||
        vscode.workspace.getConfiguration('postgresExplorer').get<number>('queryTimeout') ||
        undefined,
      application_name: config.applicationName || 'NexQL',
      ssl: sslConfig || undefined,
      ...(config.options ? { options: config.options } : {}),
    };

    if (config.ssh && config.ssh.enabled) {
      try {
        const stream = await SSHService.getInstance().createStream(
          config.ssh,
          config.host,
          config.port,
        );
        clientConfig.stream = stream as any;
      } catch (err: any) {
        // SSH errors are critical for connection creation
        ErrorService.getInstance().showError(`SSH Connection failed: ${err.message}`);
        throw new Error(`SSH Connection failed: ${err.message}`);
      }
    } else {
      clientConfig.host = config.host;
      clientConfig.port = config.port;
    }

    return clientConfig;
  }
}
