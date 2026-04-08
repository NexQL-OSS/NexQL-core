export interface ConnectionConfig {
  id: string;
  name?: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  // Advanced connection options
  sslmode?: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  sslCertPath?: string;       // Client certificate path
  sslKeyPath?: string;        // Client key path
  sslRootCertPath?: string;   // CA certificate path
  statementTimeout?: number;  // milliseconds
  connectTimeout?: number;    // seconds (default: 15)
  applicationName?: string;   // Shows in pg_stat_activity
  options?: string;           // Raw options string (e.g., "-c search_path=myschema")
  // Safety & confidence features
  environment?: 'production' | 'staging' | 'development';  // Environment tag for safety warnings
  readOnlyMode?: boolean;     // Force read-only transactions
  ssh?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
  };
}

export interface PostgresMetadata {
  connectionId: string;
  databaseName: string | undefined;
  host: string;
  port: number;
  username?: string;
  password?: string;
  // Profile settings
  activeProfileId?: string;
  readOnlyMode?: boolean;
  autoLimitSelectResults?: number;
  autoApplySafetyCheck?: boolean;
  // Transaction settings
  transactionSettings?: {
    autoRollback: boolean;
    isolationLevel?: 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
    readOnly?: boolean;
    deferrable?: boolean;
  };
  custom?: {
    cells: any[];
    metadata: {
      connectionId: string;
      databaseName: string | undefined;
      host: string;
      port: number;
      username?: string;
      password?: string;
      enableScripts: boolean;
    };
  };
}

export interface TableInfo {
  schema?: string;
  table?: string;
  primaryKeys?: string[];
  uniqueKeys?: string[];
}

export interface BreadcrumbContext {
  connectionId: string;
  connectionName: string;
  database?: string;
  schema?: string;
  object?: {
    name: string;
    type: 'table' | 'view' | 'function';
  };
}

export interface QueryResults {
  rows: any[];
  columns: string[];
  rowCount?: number | null;
  command?: string;
  query?: string;
  notices?: string[];
  executionTime?: number;
  tableInfo?: TableInfo;
  columnTypes?: Record<string, string>;
  success?: boolean;
  backendPid?: number | null;
  explainPlan?: any;
  performanceAnalysis?: any;
  slowQuery?: boolean;
  breadcrumb?: BreadcrumbContext;
  errorCode?: string;           // PostgreSQL error code (e.g., "42P01")
  errorExplanation?: string;    // Plain-English explanation from ErrorService
  transactionState?: {
    isActive: boolean;
    statementCount: number;     // Statements executed in current transaction
  };
  pendingCommit?: boolean;      // True when result was produced inside a transaction
}

export interface TableRenderOptions {
  columns: string[];
  rows: any[];
  originalRows: any[];
  columnTypes?: Record<string, string>;
  tableInfo?: TableInfo;
  initialSelectedIndices?: Set<number>;
  modifiedCells?: Map<string, { originalValue: any, newValue: any }>;
  rowsMarkedForDeletion?: Set<number>;
}

export interface ChartRenderOptions {
  type: string;
  xAxisCol: string;
  yAxisCols: string[];
  numericCols: string[];
  sortBy?: string;
  limitRows?: number;
  dateFormat?: string;
  useLogScale?: boolean;
  showGridX?: boolean;
  showGridY?: boolean;
  showDataLabels?: boolean;
  showLabels?: boolean;
  chartTitle?: string;
  legendPosition?: string;
  horizontalBars?: boolean;
  curveTension?: number;
  lineStyle?: string;
  pointStyle?: string;
  blurEffect?: boolean;
  hiddenSlices?: Set<string>;
  selectedPieValueCol?: string;
  seriesColors?: Map<string, string>;
  sliceColors?: Map<string, string>;
  textColor?: string;
}

export interface DashboardStats {
  dbName: string;
  owner: string;
  size: string;
  objectCounts: {
    tables: number;
    views: number;
    functions: number;
  };
  metrics: {
    xact_commit: number;
    xact_rollback: number;
    blks_read: number;
    blks_hit: number;
    deadlocks: number;
    conflicts: number;
  };
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
  maxConnections: number;
  longRunningQueries: number;
  waitEvents: Array<{ type: string, count: number }>;
  blockingLocks: Array<{
    blocking_pid: number;
    blocked_pid: number;
    locked_object: string;
    lock_mode: string;
  }>;
  activeQueries: Array<{
    pid: number;
    usename: string;
    duration: string;
    query: string;
  }>;
}
