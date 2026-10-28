# pew

Bun-workspaces monorepo tracking token usage from local AI coding tools. Human overview: [README.md](README.md).

- `packages/core` — shared TypeScript types (`@pew/core`, private, zero runtime deps)
- `packages/cli` — CLI tool (`@nocoo/pew`, published to npm, citty + consola + picocolors)
- `packages/web` — SaaS dashboard (`@pew/web`, private, Next.js 16 + App Router)
- `packages/worker` — D1 ingest-write handler (`@pew/worker`, private): runs as a Cloudflare Worker in the hosted deployment, and as a Node service over rqlite via `deploy/selfhost/` (docs 57–61)
- `packages/worker-read` — D1 read-query handler (`@pew/worker-read`, private): same dual runtime

Supported tools (9): Antigravity CLI, Claude Code, Codex, GitHub Copilot CLI, Grok, Hermes, OpenCode, OpenClaw, Pi.

Retired sources stay readable and count toward historical rankings, but never accept new token, session, evidence or accounting writes. Core `SOURCES` lists active tools; `VALID_SOURCES` includes historical identities. Ingest acknowledges and ignores exact retired identities so old mixed-source batches do not block active uploads.

## Scope and instruction sources

- This file applies throughout the repository.
- `packages/web/AGENTS.md` and `packages/web/CLAUDE.md` are Next.js-generated adapters. Follow their framework guidance for web changes; do not recreate root legacy compatibility in them.
- Maintain this file as the only root handbook; do not recreate `CLAUDE.md`, a symlink, an import or a compatibility alias.
- Source of truth: root and `packages/*/package.json`, `vitest.config.ts` and `vitest.e2e-cli.config.ts`, `biome.json`, composite `tsconfig` references, `.husky/`, `scripts/`, `.github/workflows/ci.yml`, and the quality-system docs ([upgrade](docs/30-quality-system-upgrade.md), [D1 isolation](docs/31-d1-test-isolation.md)). Record drift rather than lowering the contract.

## Setup and commands

Run from the repository root with Bun as package manager and runtime.

```sh
bun install --frozen-lockfile
bun run build
bun run dev
bun run typecheck
bun run lint
bun run test
bun run test:coverage
bun run test:e2e
bun run test:e2e:cli
bun run test:e2e:ui
bun run test:security
bun run sync-prices
bun run release
```

`build` builds core types then web; the CLI must be built explicitly with `bun run --cwd packages/cli build` before publishing. `lint` chains typecheck, Biome `--error-on-warnings`, and the three AST gates (`scripts/check-dynamic-delete.ts`, `scripts/check-ts-expect-error.ts`, `scripts/check-conditional-test-skips.ts`, all on oxc-parser, decoupled from the tsc version). Ports: dev=7020, API E2E=17020, BDD E2E=27020.

E2E uses per-run temporary local D1/KV bindings and source Workers, never remote test resources. Run from a clean task clone without `.env*` files (except examples); the runners fail closed instead of reading daily-development secrets. Build `@pew/core` first. Each run verifies both `_test_marker` environment and random ownership ID, uses a test-only loopback Cloudflare-envelope bridge, and cleans owned processes/state in `finally`. Port conflicts fail without killing another process. CI must not materialize cloud credentials for these tests.

## Source scanning principles

Three inviolable rules govern how pew interacts with source data:

1. **Raw data is read-only**: never modify, delete or move original AI-tool log files. Write operations are limited to pew's own state files under `~/.config/pew/`.
2. **Source isolation**: each source is completely independent. Even a buggy parser must never corrupt or affect data from other sources.
3. **Idempotent uploads**: `pew reset && pew sync` is always safe. Duplicate uploads deduplicate via `ON CONFLICT` upserts, never summed; the same raw data always produces the same final state.

## Conventions

- TypeScript strict mode with composite project references across all five packages.
- TDD: write tests first, then implement. Conventional Commits, atomic, one logical change per commit.
- `@pew/core` is not published: shared types plus a few dependency-free runtime helpers (source constants, record validation, count math, request-body limits), declared as a `devDependency` and never published.
- Preserve incremental rewind/cursor-loss recovery and source-specific token accounting; raw conversation bodies are not uploaded. Keep raw logs and real CLI state out of fixtures.
- Preserve Google login, invitation/device flows, bearer handling and authorized data/query access. Keep secrets server-side, routes thin and MVVM boundaries intact. All web reads use typed `DbRead` RPC methods; the read Worker owns SQL and accepts parameters only through `/api/rpc`. Do not restore a generic SQL endpoint.
- Preserve standalone assets/SWC helper packaging and pin Bun across local/CI/container versions.
- Tests must not use `.skip`/`.only`; Biome elevates `noSkippedTests`/`noFocusedTests` to errors in the test-file override. Conditional forms (`it.skipIf`, `it.runIf`) are not caught by Biome and are rejected by `scripts/check-conditional-test-skips.ts` instead: a test that runs only outside CI makes the local gate and CI measure different code, which is how an uncovered branch reached CI as a 95% threshold failure.

### DateTime strategy

All date/time values follow a strict UTC-in, local-out pattern:

- **Storage (D1 SQLite)**: `created_at`, `updated_at`, `hour_start` use `datetime('now')` (UTC). Season `start_date`/`end_date` are ISO 8601 UTC strings (`YYYY-MM-DDTHH:mm:ssZ`), precision to minute; status is derived at read time via `deriveSeasonStatus()`, never stored.
- **Computation (API routes, Worker, CLI)**: all date arithmetic in UTC (`toISOString()`, `Date.UTC()`, `getUTC*()`); never `setDate()`/`getDate()` server-side — use `setUTCDate()`/`getUTCDate()`.
- **Display (Web UI)**: convert to the user's local timezone before rendering; `tzOffset` pattern for bucketing; `toLocaleString()`/`toLocaleDateString()` on the client.
- **`datetime-local` inputs** show local wallclock time: UTC → local via `utcToLocalDatetimeValue()`, local → UTC via `localDatetimeValueToUtc()` (both in `date-helpers.ts`). Never append `Z` to a `datetime-local` value directly.
- **Ordering/equality**: always epoch ms (`new Date(x).getTime()`), never string comparison — ISO variants have unstable lexicographic order.

## CLI dev workflow and state files

Detailed state, time and release contracts: [agent operations](docs/49-agent-operations.md). CLI sync/init/reset are state-changing operations, not documentation checks. Use synthetic sources and temporary directories for CLI tests (`bun run test:e2e:cli`).

```sh
bun run build
bun run --cwd packages/cli build
bun run --filter '@pew/web' dev
NODE_TLS_REJECT_UNAUTHORIZED=0 bun packages/cli/dist/bin.js sync --dev
```

A full reset invalidates token/session cursors before rebuilding active-source queues. Retired token/session records and their pending upload intent remain in Pew's own queues because their collectors no longer replay them. Antigravity snapshot baselines also remain so corrected or removed keys can upload tombstones. State files: `config.json` (prod API key `pk_...`), `config.dev.json` (dev API key), `config.<host>.json` (self-hosted instance API key — one file per host, so an intranet login never overwrites the SaaS token), `cursors.json` and `session-cursors.json` (per-file byte offsets + directory mtimes, shared across dev/prod), `device.json` (stable device id), `queue.jsonl` / `queue.state.json` (token records), `session-queue.jsonl` / `session-queue.state.json` (sessions), `evidence-queue.jsonl` / `evidence-queue.state.json` (durable usage evidence, never removed by reset) and `accounting-queue.jsonl` / `accounting-queue.state.json` (accounting details), plus `sync-commit.json` (crash-recovery journal) and `state.lock` (mutation lock). State and cursor snapshots are written tmp+rename; append-only queue records are appended after a torn-tail check. A `state.lock` whose recorded PID is gone is reclaimed automatically.

## Testing and quality contract

Run the checks relevant to the change; hook and CI requirements still apply. Statuses: `enforced`, `planned`, `manual`, `N/A`.

| Dimension | Required contract | Current status and evidence |
| --- | --- | --- |
| L1 — pre-commit quality | UT with all four coverage metrics ≥95%; strict types and check-only lint with zero errors/warnings; installed hooks on the index snapshot; proven rejection; under 30s; no skipped/focused tests. Pure Views may be covered by L3; business logic stays in scope. | planned, with the core subchecks implemented. `.husky/pre-commit` materializes the staged tree with `checkout-index` into a temp snapshot, verifies staged manifests match the installed worktree, dry-run-checks the frozen lockfile, regenerates staged prerequisites (`@pew/core` build, `next typegen`), reuses worktree `node_modules` read-only, and runs `vitest run --coverage`, `scripts/parallel-typecheck.sh` (five packages, strict tsc), Biome `--error-on-warnings` and all three AST gates there; every commit runs the full gate with no caches and exit-code rejection. `vitest.config.ts` enforces 95/95/95/95 (v8) with documented by-design exclusions (presentation `.tsx`, `use-*` hooks, CLI command entry points covered by CLI E2E, framework adapters, pure type modules). The <30s budget is unmet: measured 2026-10-16 on the maintainer machine (303 files, 4,674 tests), the coverage step alone ran 184s with a cold Vite transform cache right after `bun install`, and the full sequential gate ran 79s warm; commit gates under concurrent machine load ran 160–215s. Re-measured 2026-10-27 (318 files, 5,027 tests): the coverage step inside the index-snapshot gate ran 131–141s. The budget was written when the suite held ~2,170 tests. Recorded as drift, not lowered: full unified L1 (including the static lanes, former G1) remains planned rather than certified. |
| L2 — integration | Real HTTP against the actual application; complete endpoint/method coverage | enforced for the existing 102 API cases (plus 5 `e2e-mode` unit cases the runner's directory target also collects — 107 as reported; verified 2026-10-22: `107 pass / 0 fail`), including all-time device totals/details/timeline and exact status assertions. `scripts/run-e2e.ts` runs the actual local Next server on `127.0.0.1:17020` backed by per-run real D1/KV and source Workers. The lane boots `next dev`, so before spawning tests the runner warms every `src/app/api` route plus the not-found boundary (four requests in flight, the not-found boundary first because it is the slowest compile; measured 58 routes in 68–78s standalone): a cold first-hit compile takes 25–35s under machine load and used to blow past the per-test timeout (recurring single-test timeout flakes on `/api/auth/cli`, `/api/users` and the retired 404s); warmup moves compile time out of the test clock. Gate timeouts across the harness are hang detectors, not performance budgets: L2 per-test 120s, bindings startup and server readiness 900s, route warmup 600s, `leaderboard` RPC via `LEADERBOARD_RPC_TIMEOUT_MS` (harness injects 300s; production default 15s), Playwright test 180s / navigation 120s. Exhaustive endpoint/method inventory is not certified. |
| L3 — system | Critical user journeys on isolated resources | enforced for the existing 98 Playwright cases (`playwright test --list` at 2026-10-26; the last full run recorded 2026-10-16 as `94 passed` in 7.9–9.9min, before the suite grew; a later full run on 2026-10-27 recorded `98 passed` in 5.2min from the pre-push gate). Page readiness maps all 30 page routes (29 populated checks plus the `/settings` redirect) to populated real-API/module checks or explicit redirects; L1 rejects missing page inventory entries and typechecks browser tests. Responsive trend layout and agent visualizations use real data; intentional visual/failure mocks remain separate. `scripts/run-e2e-ui.ts` uses `:27020` and its own temporary seeded D1/KV/Worker target, separate from the API lane. |
| G2 — security | Dependency and secret scans; missing required scanner fails | enforced. `scripts/run-security.ts` is the single entry point (osv-scanner + gitleaks) and runs in pre-push; CI quality uses the tracked `osv-scanner.toml`. |
| D1 — test isolation | Test state physically separate from production and daily development; guards before destructive fixture operations | enforced by the local runner: no environment files, synthetic credentials, test-only loopback endpoint, actual SQL environment/run markers, native migrations and per-run cleanup. Guard/schema/failure/signal regressions run in the normal test gate and strict harness typecheck. See [local E2E isolation](docs/32-local-e2e-isolation.md). |

Current hooks: pre-commit runs the full local index-snapshot L1 gate; pre-push runs isolated L2 E2E, L3 BDD and G2 in parallel and rejects local environment files. CI mirrors quality, L2 and L3 without cloud-secret injection. Tag pushes also invoke Git pre-push hooks; never bypass them. Targets remain unified L1 under 30s and pre-push L2/G2 under three minutes on stdin pushed refs; timing is not certified and ref-reading is not implemented. Measured 2026-10-16: the L1 target is unmet (see the L1 row) and the 30s figure predates the suite's growth past 4,600 tests; the pre-push L2/G2 target is met for the gate work itself (L2 89s standalone) with L3's Playwright run (94 cases, ~8–10min under load) in the same parallel pre-push invocation.

The owner merged former G1 into L1 on 2026-09-21; the framework keeps the 6DQ name. Use `system0-6dq-l1` for the L1 contract and its S/A/B/F rubric.

## Operations and release

Root `package.json` is the project/Web release version; keep `packages/web/package.json` aligned with it. CLI, core and Worker versions are independent and do not change for a Web-only release. Prepare scoped releases manually with the matching manifest, lockfile, changelog, normal Git hooks, exact tag and GitHub Release. The existing `bun run release` script synchronizes every package and Worker constant and pushes without a confirmation prompt; use it only when an explicitly coordinated version bump is intended, not for a scoped release.

npm publication of `@nocoo/pew` follows the full procedure; it is an authorized operation, not a per-edit step:

1. Prepare the explicitly authorized CLI version, sync the lockfile, update the changelog and commit. The CLI version is independent of the Web release; a Web-only release does not authorize an npm publication. Pre-push runs the isolated L2/L3/G2 gates without cloud credentials.
2. Build both: `bun install && bun run build && bun run --cwd packages/cli build` — root `build` builds core + web only.
3. `bun run test`.
4. Verify the dist version (`packages/cli/package.json` is authoritative; the CLI reads its version at runtime via `readVersion()`).
5. `cd packages/cli && npm publish --dry-run`.
6. `npm publish` (OTP via `--otp=<code>` or browser auth when prompted).
7. Verify with `npx @nocoo/pew@latest --help`.
8. Watch CI: after push, check `gh run list --limit 5` within a few minutes; local pre-push does not catch every failure mode (workspace links, deploy pipeline).

Successful main push CI now triggers the pinned Docker CD workflow, publishing
`ghcr.io/nocoo/pew` and deploying one immutable-digest container to `/opt/pew` on
jp2. All hooks remain enabled; never use `railway up` or manual image rebuilding
to bypass the proven-source deployment chain. Any Worker code or schema change
still requires `wrangler deploy` plus a real verification request.

The [jp2 migration](docs/52-jp2-migration.md) completed public cutover on 2026-10-22.
`pew.md` uses jp2 with Full (strict), shared AOP and `DEPLOY_PHASE=production`;
the temporary internal listener is removed. Railway's runtime is stopped under
the owner's 2026-10-22 approval; its project, service, variables and old deployment
record remain for recovery, with the main trigger removed. Do not delete those
resources. An authorized Railway recovery must reuse the recorded old image and
verify its running instance, digest and health before routing back. Shared Caddy
uses validated `SIGUSR1` hot reload, never a proxy
restart. Runtime values remain unchanged from Railway. A routing rollback to
Railway must restore `DEPLOY_PHASE=precutover` before later releases; an image-only
rollback on jp2 retains production. See [Retrospective.md](Retrospective.md) for
the operational lessons.

The self-hosted path is a separate deployment, not a second hosted target: `deploy/selfhost/` (docs 57–61) applies schema changes through `deploy/selfhost/migrate.ts` against rqlite and runs the same worker handlers on Node under compose. There, `wrangler deploy` is not part of the loop, and worker `src/` must stay runtime-agnostic.

## Ponytail audit

For `ponytail-audit`, read `.agents/skills/ponytail-audit/SKILL.md`. Its pew-specific scope extends the global complexity audit to parser → cursor → spool → upload → Worker UPSERT → API/UI correctness, privacy, timestamps and compatibility. Run `sh scripts/ponytail-audit.sh` for deterministic JSON on stdout; the audit must not write reports or touch real logs, state, queues or services. Full tests and independent reviews stay separate from this read-only audit.

## Retrospective

Accident narratives live in [Retrospective.md](Retrospective.md). Keep only concise recurring project rules here; cross-project lessons go to global rules/nmem, deterministic checks to hooks/tests.
