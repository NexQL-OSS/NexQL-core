-- Down: pgstudio_sync schema
DROP INDEX IF EXISTS pgstudio_sync.sync_items_pull_idx;
DROP TABLE IF EXISTS pgstudio_sync.sync_meta;
DROP TABLE IF EXISTS pgstudio_sync.sync_items;
DROP SCHEMA IF EXISTS pgstudio_sync;
