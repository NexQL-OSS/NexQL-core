-- Tear down NexQL self-hosted sync schema (v2). Destroys all synced data.
DROP TABLE IF EXISTS nexql_sync.items_v2;
DROP TABLE IF EXISTS nexql_sync.deletes_v2;
DROP SEQUENCE IF EXISTS nexql_sync.cursor_seq;
-- Schema kept (may hold workspace tables); drop manually if unused:
--   DROP SCHEMA IF EXISTS nexql_sync CASCADE;
