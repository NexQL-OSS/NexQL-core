# Platform Compatibility

NexQL works with **any database that speaks the PostgreSQL wire protocol**. This page covers what works out of the box on popular Postgres platforms, known caveats, and recommended connection settings.

> **Where to find this:** Linked from the [NexQL site](https://nexql.astrx.dev/) (workflow platform strip, FAQ, footer), [README](../README.md), and [Marketplace listing](../MARKETPLACE.md).

> Implementation tracker: [`docs/roadmap/4.1.platform-presets-pg12-audit.md`](roadmap/4.1.platform-presets-pg12-audit.md) · Parent roadmap: [`4.postgres-compatible-platforms-roadmap.md`](roadmap/4.postgres-compatible-platforms-roadmap.md)

## Adding a connection (Settings Hub)

1. Open **PgStudio Settings** → **Connections** → **Add Connection**
2. Choose a **Database platform** preset (PostgreSQL, Neon, Supabase, TimescaleDB, YugabyteDB, RDS, Aurora, Cloud SQL, AlloyDB, Azure) — icons pre-fill SSL mode and port
3. Paste a `postgresql://` URL in **Connection URL** (or use **Import from .env** / explorer **Add Connection from Clipboard URL**)
4. **Test Connection** — warns on PostgreSQL &lt; 12 or transaction-mode poolers
5. Explorer connection nodes show a **platform badge** after connect; status bar shows `PG {major}`

## Compatibility Matrix

| Platform | Status | Notes |
|---|---|---|
| **PostgreSQL 12–17** (self-hosted, Docker) | ✅ Fully supported | Primary target; integration-tested every release |
| **Neon** | ✅ Works | Use the **direct** endpoint for notebooks/transactions; see caveats |
| **Supabase** | ✅ Works | Use direct connection or **session** pooler (port 5432); see caveats |
| **TimescaleDB** (self-hosted & Timescale Cloud) | ✅ Fully compatible | It's a Postgres extension — everything works; hypertable-aware UI planned |
| **YugabyteDB** (YSQL) | ✅ Mostly works | PG 11/15-compatible query layer; some maintenance commands are no-ops; see caveats |
| **AWS RDS / Aurora PostgreSQL** | ✅ Works | Real Postgres; set SSL Mode `require` |
| **Google Cloud SQL / AlloyDB** | ✅ Works | Real Postgres; use Cloud SQL Auth Proxy or SSL certs |
| **Azure Database for PostgreSQL (Flexible)** | ✅ Works | Real Postgres; set SSL Mode `require` |
| **CockroachDB** | ⚠️ Not supported | Wire-compatible but `pg_catalog` parity is too thin for the explorer/dashboard; tracked in the multi-engine roadmap |

## Connection Guides

<a id="postgresql"></a>

### PostgreSQL 12–17

Self-hosted, Docker, and on-prem deployments are NexQL's primary target — **PostgreSQL 12 through 17** are integration-tested every release.

- Default port: `5432` · SSL optional on localhost; use `require` when the server is network-exposed
- Full superuser and extension support when your deployment allows it

<a id="aws-rds"></a>

### AWS RDS / Aurora PostgreSQL

Managed Postgres on AWS — real PostgreSQL with full NexQL feature support.

- SSL Mode: `require`
- Use the instance or cluster endpoint from the RDS console; SSH tunnel via a bastion if the instance is in a private VPC

<a id="neon"></a>

### Neon

Neon dashboards give you a URL like `postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require`.

- Host: `ep-xxx.region.aws.neon.tech` (direct) or `ep-xxx-pooler...` (pooled)
- Port: `5432` · SSL Mode: `require`
- **Prefer the direct endpoint** (without `-pooler`) for NexQL. The pooled endpoint runs in transaction mode, which breaks multi-statement transactions across notebook cells, `SET`, LISTEN/NOTIFY, and temp tables.
- **Autosuspend**: Neon suspends idle computes. The first query after a long pause may take a few seconds (cold start) or drop a stale pooled connection — just re-run the cell.
- No superuser: tablespace and event-trigger operations are unavailable (Neon restriction, not a NexQL one).

<a id="supabase"></a>

### Supabase

Supabase offers three connection paths (Project Settings → Database):

| Path | Port | NexQL recommendation |
|---|---|---|
| Direct connection | 5432 | ✅ Best — full feature support (note: IPv6-only on some plans) |
| Session pooler (Supavisor) | 5432 | ✅ Good — full session semantics, works on IPv4 |
| Transaction pooler | 6543 | ⚠️ Avoid for NexQL — breaks transactions across cells, LISTEN/NOTIFY, temp tables |

- SSL Mode: `require`.
- Supabase platform schemas (`auth`, `storage`, `realtime`, `vault`, …) appear in the explorer; use the tree search filter to focus on `public`.
- Supabase is RLS-first — NexQL's **RLS Policy Studio** pairs well for authoring and reviewing policies.

<a id="timescaledb"></a>

### TimescaleDB

TimescaleDB is a PostgreSQL extension, so compatibility is 100%: explorer, notebooks, dashboard, AI assistant, and all object operations work unchanged.

- Hypertables appear as regular tables; continuous aggregates appear as materialized views. Dedicated hypertable/chunk/compression views are on the roadmap.
- On Timescale Cloud: SSL Mode `require`; no superuser (same hosted-platform restrictions as Neon).
- Avoid `VACUUM FULL` on compressed hypertables (Timescale guidance, independent of NexQL).

<a id="yugabytedb"></a>

### YugabyteDB (YSQL)

YugabyteDB reuses the PostgreSQL query layer (PG 11.2-compatible in 2.x stable, PG 15 in newer releases), so the explorer, notebooks, saved queries, AI assistant, and most operations work.

- Port: `5433` (YSQL default) · user `yugabyte`.
- NexQL reads `server_version_num` and automatically falls back to the matching PostgreSQL feature level.
- Known differences (YugabyteDB behavior, not NexQL bugs):
  - `VACUUM` / `REINDEX` are no-ops or unsupported — DocDB storage doesn't need them.
  - Tablespaces exist but mean geo-placement, not disk layout.
  - LISTEN/NOTIFY is not supported.
  - `EXPLAIN` output includes YB-specific plan nodes; the visualizer renders unknown nodes generically.
  - Some `pg_stat_*` views are partial; dashboard panels degrade gracefully.

## General Notes for Hosted Platforms

- **SSL**: always set SSL Mode to `require` (or `verify-full` with the provider CA) for hosted databases. NexQL supports CA/client cert configuration per connection.
- **No superuser**: hosted platforms never grant superuser. Features that need it (event trigger creation, some extension installs, tablespace management) will fail server-side regardless of the client.
- **`pg_stat_statements`**: the dashboard probes for it and skips those panels if the platform doesn't expose it.
- **Connection strings**: until paste-to-autofill ships (roadmap Phase B), split the `postgresql://user:pass@host:port/db?sslmode=...` URL into the form fields manually.
