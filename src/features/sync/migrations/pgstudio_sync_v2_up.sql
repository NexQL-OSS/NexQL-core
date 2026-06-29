-- NexQL self-hosted sync schema (v2 — git-like).
-- Run once against the Postgres database you point sync at. The extension also
-- creates these objects automatically on first sync; this script is for manual
-- / least-privilege setups.

CREATE SCHEMA IF NOT EXISTS nexql_sync;

CREATE SEQUENCE IF NOT EXISTS nexql_sync.cursor_seq;

-- Current items. Each write stamps a monotonic `version` from cursor_seq.
CREATE TABLE IF NOT EXISTS nexql_sync.items_v2 (
  space_id     TEXT        NOT NULL,
  item_id      TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN ('connection','query','notebook')),
  blob         BYTEA       NOT NULL,
  content_hash TEXT        NOT NULL,
  version      BIGINT      NOT NULL,
  device_id    TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, item_id)
);
CREATE INDEX IF NOT EXISTS items_v2_cursor_idx ON nexql_sync.items_v2 (space_id, version);

-- Permanent delete log — never pruned. Stops deleted items resurrecting.
CREATE TABLE IF NOT EXISTS nexql_sync.deletes_v2 (
  space_id   TEXT        NOT NULL,
  item_id    TEXT        NOT NULL,
  version    BIGINT      NOT NULL,
  deleted_by TEXT        NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, item_id)
);
CREATE INDEX IF NOT EXISTS deletes_v2_cursor_idx ON nexql_sync.deletes_v2 (space_id, version);
