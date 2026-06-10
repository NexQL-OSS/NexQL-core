export const SYNC_BASE_MANIFEST_KEY = 'postgres-explorer.sync.baseManifest';
export const SYNC_DEVICE_ID_KEY = 'postgres-explorer.sync.deviceId';
export const SYNC_CONFIG_KEY = 'postgres-explorer.sync.config';
export const SYNC_PATH_OVERRIDES_KEY = 'postgres-explorer.sync.pathOverrides';
export const SYNC_ITEM_INDEX_KEY = 'postgres-explorer.sync.itemIndex';
export const SYNC_ACTIVITY_LOG_KEY = 'postgres-explorer.sync.activityLog';
export const SYNC_WORKSPACE_QUERIES_MIGRATED_KEY = 'postgres-explorer.sync.queriesMigratedToGlobal';

export const DEFAULT_NOTEBOOK_FOLDER = 'PgStudioNotebooks';
export const DEFAULT_SYNC_API_ENDPOINT = 'https://nexql.astrx.dev/api';

export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_COMPRESSION_BYTES = 256;
export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SECRETS_PAD_BUCKET_BYTES = 4096;
export const GIST_MAX_FILE_BYTES = 1024 * 1024;
export const GIST_DESCRIPTION = 'PgStudio E2E Sync Vault';
export const GIST_META_FILE = 'pgstudio-meta.json';

export const SYNC_DEBOUNCE_MS = 5000;
export const SYNC_PERIODIC_MS = 5 * 60 * 1000;
export const SYNC_BACKOFF_INITIAL_MS = 30_000;
export const SYNC_BACKOFF_MAX_MS = 5 * 60 * 1000;

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_FLAG_NONE = 0;
export const ENVELOPE_FLAG_BROTLI = 1;
