# Leaderboard read cache

Status: implemented locally; production cutover and v3.1.0 publication pending.

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
  Identities hash the revision, filters and content, so identical concurrent
  fills or unchanged refreshes do not unnecessarily restart pagination.
- Next.js memory is process-local, limited to 128 snapshots and 8 MiB estimated
  serialized payload, with a 256 KiB per-entry admission ceiling. Coalesce
  identical in-flight loads there. Oversize results are not silently truncated.
- KV is a restart/cross-instance read layer, not an authoritative permission
  store. Cache corruption and unavailability cannot admit unsafe counts or
  stale permissions. Admin clear changes the database revision before deleting
  old keys; physical deletion is not required for correctness.
- Snapshot/revision transport has a fifteen-second deadline, including body
  consumption. At most 64 distinct Node fills may be in flight. Cache counters
  are available through the existing admin cache GET, per process only.

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

## Cutover constraint

The final source removes the old three leaderboard RPC methods. Worker and
Railway deploy separately; either final component deployed first would break
the other component's old protocol. Do not claim a zero-interruption rollout
by ordering those two incompatible deployments alone.

Publication waits for explicit owner approval of a one-time protocol overlap,
or a separately approved blue/green deployment. With overlap approval, deploy
a tested committed Worker supporting both RPC sets, push the final Web through
normal gates, verify the exact Railway deployment and drain the old instance,
then deploy the final Worker removing old RPCs. Do not retain a fallback client
or compatibility layer in the final release. Rollback to old Web requires the
overlap Worker first; retain additive schema changes during application rollback.

## Verification receipts

- `881666b7`: indexed first-seen and leaderboard scans, 4,478 tests in the
  staged-snapshot gate; coverage 97.97/95.09/97.74/98.92.
- `877932d8`: versioned full snapshots and memory/pagination, 4,532 tests;
  coverage 98.00/95.19/97.75/98.94. Real local D1/KV proves cold construction,
  native batch handling and a warm read retaining its original snapshot.
- `2a2002bc`: RPC deadlines, 4,538 tests; same four coverage percentages.
- `0a05f234`: independent-review boundary fixes, 4,545 tests; coverage
  98.01/95.20/97.76/98.94. Concurrent byte admission and cold reader creation,
  disabled scope UI, full ingest model names and cache envelope projection are
  covered by regressions.
- Root production build and nine synthetic CLI E2E cases passed in the clean
  task clone at `2a2002bc`. Dependency links must resolve inside that clone:
  reusing absolute `.bin` launchers with a copied Bun store creates duplicate
  Next.js runtimes and a misleading workStore prerender failure.
- At `2a2002bc`, isolated real-HTTP acceptance passed 99 cases, browser acceptance
  passed 77 cases, and the dependency scan passed. That clone's initial secret
  scan had an empty local-upstream range; publication must set the actual GitHub
  upstream and scan all outgoing commits again rather than reuse that receipt.
- Full-gate wall time is not certified below thirty seconds. Machine-wide
  concurrent browser/build work can exhaust the existing lifecycle startup
  deadline; serialize heavy acceptance lanes rather than weakening assertions.

These are local receipts, not production savings or release completion.
