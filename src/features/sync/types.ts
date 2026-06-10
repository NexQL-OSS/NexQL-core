/** Sync item kinds — connection metadata, saved queries, notebooks, optional credential bundle. */
export type SyncKind = 'connection' | 'query' | 'notebook' | 'secrets';

export type SyncProviderId = 'gist' | 'onedrive' | 'gdrive' | 'cloud' | 'postgres';

export interface SyncItemMeta {
  id: string;
  kind: SyncKind;
  contentHash: string;
  revision: number;
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
}

export interface SyncSnapshot {
  manifest: SyncItemMeta[];
  getBlob(id: string): Promise<Buffer | undefined>;
}

export interface SyncPushItem {
  meta: SyncItemMeta;
  blob: Buffer;
}

/** Optional push context — authoritative post-merge manifest for remote cleanup. */
export interface SyncPushOptions {
  manifest?: SyncItemMeta[];
}

export interface SyncProvider {
  readonly id: SyncProviderId;
  pull(sinceRevision?: number): Promise<SyncSnapshot>;
  push(items: SyncPushItem[], options?: SyncPushOptions): Promise<void>;
  testConnection(): Promise<{ ok: boolean; account?: string; error?: string }>;
  /** Device binding for free-tier single-device backup. Optional per backend. */
  getBoundDeviceId?(): Promise<string | undefined>;
  setBoundDeviceId?(deviceId: string): Promise<void>;
}

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

export type SyncStatus =
  | 'idle'
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'conflict'
  | 'error'
  | 'paused'
  | 'locked'
  | 'not_configured';

export interface SyncConfig {
  providerId?: SyncProviderId;
  /** GitHub Gist backend — remote vault id (also in SecretStorage per editor). */
  gistId?: string;
  syncConnections: boolean;
  syncQueries: boolean;
  syncNotebooks: boolean;
  syncPasswords: boolean;
  paused: boolean;
  accountEmail?: string;
  vaultGeneration?: string;
  /** Per-item opt-outs: ids that are neither pushed nor applied on this device. */
  excludedIds?: string[];
}

/** Row for the settings-hub synced items table. */
export interface SyncedItemView {
  id: string;
  kind: SyncKind;
  /** Local display name; remote-only items have none until first pull. */
  name?: string;
  updatedAt?: number;
  deviceId?: string;
  revision?: number;
  excluded: boolean;
  deleted: boolean;
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

export interface MergeConflict {
  id: string;
  kind: SyncKind;
  localName: string;
  remoteDeviceId: string;
  winner: 'local' | 'remote';
  loserCopyName: string;
}

export interface MergeResult {
  toPush: SyncPushItem[];
  toApply: Array<{ meta: SyncItemMeta; plaintext: Buffer }>;
  conflicts: MergeConflict[];
  skipped: Array<{ id: string; reason: string }>;
  newBaseManifest: SyncItemMeta[];
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
  ssh?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
  };
}

export interface SecretsSyncPayload {
  passwords: Record<string, string>;
}

export interface NotebookSyncPayload {
  syncId: string;
  name: string;
  connectionId: string;
  databaseName?: string;
  host?: string;
  port?: number;
  cells: Array<{ value: string; kind?: string; language?: string }>;
}

export interface VaultManifest {
  generation: string;
  wrappedVaultKey: string;
  salt: string;
  email: string;
}

/** Device authorization flow responses (nexql.astrx.dev). */
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
  error?: string;
  error_description?: string;
}

export interface CloudSyncManifestEntry {
  item_id: string;
  kind: SyncKind;
  content_hash: string;
  revision: number;
  device_id: string;
  deleted: boolean;
  updated_at: string;
}
