-- Up: pgstudio_sync schema for optional team Postgres sync backend (Phase 5)
CREATE SCHEMA IF NOT EXISTS pgstudio_sync;

CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_items (
  account_id   TEXT        NOT NULL,
  item_id      TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN ('connection','query','notebook','secrets')),
  blob         BYTEA       NOT NULL,
  content_hash TEXT        NOT NULL,
  revision     INT         NOT NULL DEFAULT 1,
  device_id    TEXT        NOT NULL,
  deleted      BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, item_id)
);

CREATE INDEX IF NOT EXISTS sync_items_pull_idx ON pgstudio_sync.sync_items (account_id, updated_at);

CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_meta (
  account_id      TEXT        PRIMARY KEY,
  bound_device_id TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
