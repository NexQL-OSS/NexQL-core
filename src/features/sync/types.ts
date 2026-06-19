/** Sync item kinds — connection metadata, saved queries, notebooks. */
export type SyncKind = 'connection' | 'query' | 'notebook';

export type SyncProviderId = 'cloud' | 'postgres';

/**
 * Local view of an item produced by a *SyncService. `revision` is vestigial
 * (the git-like engine orders by server `version` + content hash) but kept so
 * the disk-mapping services stay untouched. `updatedAt` is the local edit time,
 * used for last-writer-wins resolution against remote.
 */
export interface SyncItemMeta {
  id: string;
  kind: SyncKind;
  contentHash: string;
  revision: number;
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
}

// ── v2 git-like sync protocol ─────────────────────────────────────────────────

/** Metadata for an item as it lives on the server. */
export interface RemoteItemMeta {
  id: string;
  kind: SyncKind;
  contentHash: string;
  /** Monotonic server version (sync cursor value at write time). */
  version: number;
  deviceId: string;
  /** Server write time, epoch ms. */
  updatedAt: number;
}

/** Delta returned by a pull: everything past the client cursor. */
export interface SyncDelta {
  cursor: number;
  upserts: Array<{ meta: RemoteItemMeta; blob: Buffer }>;
  deletes: string[];
}

/** A single push operation with optimistic-concurrency base version. */
export interface SyncOp {
  op: 'upsert' | 'delete';
  itemId: string;
  kind: SyncKind;
  /** Server version the client last saw (0 = never synced). */
  baseVersion: number;
  contentHash?: string;
  blob?: Buffer;
}

/** Server response to a push batch. */
export interface PushResult {
  cursor: number;
  accepted: Array<{ itemId: string; version: number }>;
  rejected: Array<{ itemId: string; remoteVersion: number | null; remoteHash: string | null }>;
}

/**
 * v2 provider — cursor-based delta sync with atomic batch push and a permanent
 * server-side delete log. Implemented by Cloud (HTTP) and self-hosted Postgres.
 */
export interface SyncProviderV2 {
  readonly id: SyncProviderId;
  pullDelta(since: number): Promise<SyncDelta>;
  pushBatch(ops: SyncOp[]): Promise<PushResult>;
  /** Wipe the remote space (powers "clear cloud & push"). */
  resetSpace(): Promise<void>;
  testConnection(): Promise<{ ok: boolean; account?: string; error?: string }>;
}

// ── Run results / options ─────────────────────────────────────────────────────

export interface SyncKindChangeCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface SyncDirectionSummary {
  connections: SyncKindChangeCounts;
  queries: SyncKindChangeCounts;
  notebooks: SyncKindChangeCounts;
}

export interface SyncChangeSummary {
  pushed: SyncDirectionSummary;
  pulled: SyncDirectionSummary;
}

export interface SyncRunResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  skipped: number;
  durationMs: number;
  provider: SyncProviderId;
  summary: SyncChangeSummary;
}

export type SyncDirection = 'both' | 'pull' | 'push';

export type SyncChangeType = 'create' | 'update' | 'delete' | 'conflict';

export interface SyncRunOptions {
  dryRun?: boolean;
  direction?: SyncDirection;
  /** Per-run opt-outs; does not persist to config.excludedIds. */
  transientExcludedIds?: string[];
  /** True when triggered explicitly by the user (Sync Now / pull / push). */
  userInitiated?: boolean;
  /** Apply all remote upserts regardless of local LWW (replace-local flow). */
  forceRemote?: boolean;
}

export interface SyncPreviewItem {
  id: string;
  kind: SyncKind;
  name?: string;
  changeType: SyncChangeType;
  deviceId?: string;
}

export interface SyncPreviewResult extends SyncRunResult {
  outgoing: SyncPreviewItem[];
  incoming: SyncPreviewItem[];
  conflictItems: SyncPreviewItem[];
}

export interface InboundEntry {
  itemId: string;
  kind: SyncKind;
  name?: string;
  deviceId: string;
  deviceName?: string;
  appliedAt: number;
}

export interface CloudQuotaView {
  bytesUsed: number;
  bytesLimit: number;
  itemCount: number;
  tier: string;
}

export interface SyncDeviceView {
  deviceId: string;
  deviceName?: string;
  lastSeen?: string;
  isThisDevice: boolean;
}

export type SyncStatus =
  | 'idle'
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'conflict'
  | 'error'
  | 'paused'
  | 'not_configured';

export interface SyncConfig {
  providerId?: SyncProviderId;
  syncConnections: boolean;
  syncQueries: boolean;
  syncNotebooks: boolean;
  paused: boolean;
  accountEmail?: string;
  /** Active workspace (shared space id). Undefined = personal space. */
  spaceId?: string;
  spaceName?: string;
  /** Per-item opt-outs: ids that are neither pushed nor applied on this device. */
  excludedIds?: string[];
}

/** Row for the settings-hub synced items table. */
export interface SyncedItemView {
  id: string;
  kind: SyncKind;
  name?: string;
  updatedAt?: number;
  deviceId?: string;
  excluded: boolean;
  /** Per-item inclusion state for the settings table. */
  itemStatus: 'excluded' | 'pending' | 'synced' | 'local';
  /** local = on this device; cloud-only = in cloud but not present locally. */
  presence?: 'local' | 'cloud-only';
  detail?: string;
  spaceId?: string;
  workspaceName?: string;
  role?: WorkspaceRole;
}

/** Row for the cloud inventory tab (remote snapshot vs local). */
export interface CloudItemView {
  id: string;
  kind: SyncKind;
  name: string;
  detail?: string;
  updatedAt: number;
  /** How this cloud item compares to the copy on this device. */
  localStatus: 'absent' | 'synced' | 'different' | 'excluded';
  spaceId?: string;
  workspaceName?: string;
}

/** One cloud space participating in a sync run. */
export interface SyncSpaceContext {
  /** Undefined = personal (account) space. */
  spaceId?: string;
  name: string;
  role: WorkspaceRole;
}

export type SyncActivityAction = 'create' | 'update' | 'rename' | 'delete';

export interface SyncActivityInput {
  itemId: string;
  kind: SyncKind;
  action: SyncActivityAction;
  name?: string;
  previousName?: string;
}

export interface SyncActivity extends SyncActivityInput {
  id: string;
  queuedAt: number;
}

/** Pending outbound change shown on the sync settings page. */
export interface SyncActivityView {
  id: string;
  itemId: string;
  kind: SyncKind;
  action: SyncActivityAction;
  name?: string;
  previousName?: string;
  queuedAt: number;
}

export interface PathOverrides {
  [connectionId: string]: {
    sslCertPath?: string;
    sslKeyPath?: string;
    sslRootCertPath?: string;
    sshPrivateKeyPath?: string;
  };
}

export interface ConnectionSyncPayload {
  id: string;
  name?: string;
  host: string;
  port: number;
  username?: string;
  database?: string;
  sslmode?: string;
  environment?: string;
  readOnlyMode?: boolean;
  /** Connection tree group label (e.g. "Local"). */
  group?: string;
  ssh?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
  };
}

export interface NotebookSyncPayload {
  syncId: string;
  name: string;
  connectionId: string;
  /** Display name of the linked connection at collect time (for cross-device folder labels). */
  connectionName?: string;
  databaseName?: string;
  host?: string;
  port?: number;
  /** Parent directory segments relative to extension globalStorage (authoritative when present). */
  folderPath?: string[];
  cells: Array<{ value: string; kind?: string; language?: string }>;
}

/** Apply order for incoming upserts: connections before notebooks that depend on them. */
export const SYNC_KIND_APPLY_ORDER: Record<SyncKind, number> = {
  connection: 0,
  query: 1,
  notebook: 2,
};

// ── Team workspaces (server-ACL sharing) ──────────────────────────────────────

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface WorkspaceView {
  spaceId: string;
  name: string;
  ownerEmail: string;
  role: WorkspaceRole;
}

export interface WorkspaceMemberView {
  email: string;
  role: WorkspaceRole;
  addedAt?: string;
}

// ── Device authorization flow (nexql.astrx.dev) ───────────────────────────────

export interface DeviceAuthStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  email?: string | null;
  error?: string;
  error_description?: string;
}
