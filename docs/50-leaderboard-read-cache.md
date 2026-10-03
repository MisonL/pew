# Leaderboard read cache

Status: implementation in progress for the explicitly requested v3.1.0 release.

## Baseline

Cloudflare adaptive analytics, 2026-09-26T04:00:00Z inclusive through
2026-10-03T04:00:00Z exclusive: Pew read 3,015,732,223 D1 rows (88.05% of
the account). Three token leaderboard queries read 2,568,684,072 rows in
3,601 executions. All-time session aggregation adds 334,065,510 rows in
416 executions. These four queries account for 96.25% of Pew reads, not
96.25% of its invoice. Production has 239 users, 226 public.

## Contract

- Keep exact accounting and all-time semantics. Never update raw logs or
  turn absolute ingest snapshots into additive counters.
- Cache complete ranked result sets, including team display and session
  statistics, independently of page size and offset. Stable ties use user ID.
- Week/month snapshots live for ten minutes; all-time snapshots for thirty.
  Restore their original expiry from KV; hits never renew freshness.
- A database-owned revision changes atomically with privacy, identity display,
  account deletion, and team/organization membership/display mutations. A
  primary D1 revision read gates every memory hit. Ingest does not invalidate
  the global revision on every upload.
- Revision-scoped KV keys make old fills harmless. Snapshot construction
  observes its revision and data in a transaction. Recheck authority after
  asynchronous cache work, retry once on a race, and fail closed thereafter.
- Preserve live team/organization authorization before reading shared scoped
  data. Public HTTP responses remain private/no-store.
- Pagination carries a snapshot identity. A changed snapshot causes a 409 and
  client restart, rather than appending rows from different rankings.
- Next.js memory is process-local, limited to 128 snapshots and 8 MiB estimated
  serialized payload, with a 256 KiB per-entry admission ceiling. Coalesce
  identical in-flight loads there. Oversize results are not silently truncated.
- KV is a restart/cross-instance read layer, not an authoritative permission
  store. Cache corruption and unavailability cannot admit unsafe counts or
  stale permissions. Admin clear changes the database revision before deleting
  old keys; physical deletion is not required for correctness.

## SQL changes

Use existing user/time indexes to find earliest activity in each base table,
excluding zero-token evidence checkpoints but retaining zero legacy buckets.
Add time and source/time indexes to both usage bases. All-time aggregates still
need caching; do not add wide covering or speculative model indexes.

## Sequence and verification

1. Commit focused SQL/index changes with native SQLite semantic/query-plan tests.
2. Commit versioned full snapshots and their privacy, deletion, membership,
   corruption, concurrency and pagination regressions.
3. Commit bounded Next.js memory and client snapshot pagination, with exact
   expiry, capacity, failure and restart checks.
4. Run full staged L1 and isolated L2/L3/G2, build web and CLI, bump the requested
   minor version, apply migrations before Worker deployment, verify production,
   then publish Git/GitHub and npm artifacts through normal gates.

No materialized token totals, Redis, Durable Objects, cron prewarming, or
all-RPC caching is introduced. Active/frozen season and private dashboard cache
expansion is deferred until the four dominant workloads are measured again.
Compare complete post-deployment windows, including cold starts, using D1 rows,
expensive query executions, KV reads/writes, request latency and error rates.
