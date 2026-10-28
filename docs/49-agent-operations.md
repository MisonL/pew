# 49 · Time, CLI State and Release Contracts

See the root [AGENTS.md](../AGENTS.md) for the engineering entrypoint and local 6DQ target. Document 31 and legacy test runners describe remote test resources; they do not authorize creating or deploying remote `-test` resources.

## Time semantics

All date/time valuesfollow a strict UTC-in, local-out pattern:

- **Storage (D1 SQLite)**: All `created_at`, `updated_at`, `hour_start` use `datetime('now')` which returns UTC. Season `start_date`/`end_date` are ISO 8601 UTC strings (`YYYY-MM-DDTHH:mm:ssZ`).
- **Computation (API routes, Worker, CLI)**: All date arithmetic uses UTC (`toISOString()`, `Date.UTC()`, `getUTC*()` methods). Never use `setDate()`/`getDate()` for server-side date math — always use `setUTCDate()`/`getUTCDate()`.
- **Display (Web UI)**: Convert to user's local timezone before rendering. Use the `tzOffset` pattern (`new Date().getTimezoneOffset()`) for data bucketing. For timestamps use `toLocaleString()`/`toLocaleDateString()` on the client.
- **Form input (`datetime-local`)**: The input shows local wallclock time. On load, convert UTC → local via `utcToLocalDatetimeValue()`. On submit, convert local → UTC via `localDatetimeValueToUtc()`. Both helpers live in `date-helpers.ts`. Never append `Z` to a `datetime-local` value directly — that treats local time as UTC.
- **Season dates**: Stored as ISO 8601 UTC datetime (e.g. `2026-03-15T00:00:00Z`), **precision to minute**. Status derived at read time via `deriveSeasonStatus()`, never stored.
- **Date comparison**: Always use epoch ms (`new Date(x).getTime()`) for ordering/equality checks. Never use string comparison — ISO formats with/without seconds or milliseconds have unstable lexicographic order.

## CLI state and source data

- Original AI logs/SQLite are read-only. Sources remain independent; `ON CONFLICT` uploads replace identical snapshots idempotently, never sum duplicates.
- CLI state lives under `~/.config/pew/`: `config.json` (production credentials), `config.dev.json` (development credentials), `config.<host>.json` (self-hosted instance credentials — one file per host, so logging into an intranet instance never overwrites the SaaS token), `device.json`, `cursors.json` / `session-cursors.json` (shared cursors), `queue.jsonl` / `queue.state.json`, `session-queue.jsonl` / `session-queue.state.json`, `evidence-queue.jsonl` / `evidence-queue.state.json`, `accounting-queue.jsonl` / `accounting-queue.state.json`, `sync-commit.json` and `state.lock`. Tests use temporary directories and synthetic data, never this real state. State and cursor snapshots are written tmp+rename; append-only queue records are appended after a torn-tail check. A `state.lock` left by a dead process is reclaimed automatically.
- The queue files are shared across hosts: every pending record goes to whichever host the next upload names, and `queue.state.json` / `session-queue.state.json` record `lastUploadTarget` so `sync` can warn when a run sends a pending backlog to a different origin than the last successful drain. An empty queue switches targets silently (nothing was re-routed) and keeps the recorded target; a failed upload never rewrites it.
- Reset reads retained queues and upload state tolerantly — a torn tail line or a half-written state file degrades to defaults instead of aborting, because reset is the documented recovery path — invalidates token/session cursors, then rebuilds active-source queues. `queue.state.json` / `session-queue.state.json` keep their recorded `lastUploadTarget` across the rebuild, and a file that is deliberately kept is reported as kept, not as missing. Retired token/session history and its pending intent remain locally; Antigravity baselines remain for correction/deletion tombstones, and accounting history remains readable. Retired sessions retain the existing acknowledged-prefix byte offset, not unused dirty keys. Exact retired uploads are acknowledged and ignored, never stored, while mixed batches still accept active records. Historical usage continues to count toward rankings.
- `sync --no-upload` still updates the local queue. `init`/`uninstall` modify selected tool configuration and must be within the requested scope.
- Root build covers core and Web only. Build the CLI explicitly before publication: `bun run --filter '@nocoo/pew' build`.
- `@pew/core` is private, a devDependency and never published. It carries shared types and dependency-free runtime helpers (source constants, record validation, count math, request-body limits); import values from it normally — only genuinely type-only modules need `import type`.
- Source identities, default paths and parser constraints live in `packages/cli/src/utils/paths.ts` and source documentation. Do not use real conversation bodies to construct fixtures.

## Release

- Root and Web share the project release version. CLI, core and Workers are independently versioned; a Web-only release leaves their versions unchanged. Prepare scoped releases manually: update the selected manifests and lockfile, maintain CHANGELOG, run normal hooks, push the exact tag and create its GitHub Release. Never move tags.
- `bun run release` (patch by default; accepts minor/major/version) remains a coordinated-release script: it synchronizes every package and Worker constant, commits, pushes and publishes without an interactive confirmation. Do not use it for independent Web or CLI releases.
- Publish only `packages/cli` as `@nocoo/pew`. Build, test, verify package/dist versions and run `npm publish --dry-run` in the CLI directory before authorized publication and OTP verification.
- Successful `main` pushes run the pinned Docker CD workflow, publishing `ghcr.io/nocoo/pew` and deploying one immutable-digest container to jp2. All hooks stay enabled; never use `railway up` or manual image rebuilds to bypass the proven-source chain. Preserve pinned Bun, standalone public/static assets and the complete `@swc/helpers` packaging fix.
- Deploy ingest/read Workers separately. Apply dependent migrations first, then deploy the corresponding Worker and verify its runtime version and behavior. A Web deployment does not update Workers.
- Check CI and the jp2 deployment for the exact pushed commit. Pre-push runs isolated local D1/KV API/browser tests and security checks; use a clean clone without local environment files. Never bypass the hook to publish.

## Specialized audit

Use `.agents/skills/ponytail-audit/SKILL.md` and `sh scripts/ponytail-audit.sh` for Pew's audit. Inspect parser → cursor → spool → upload → UPSERT → API/UI correctness, privacy, time and compatibility. Output only to stdout; do not write reports or touch real logs, state, queues or services. Full tests and independent reviews are separate checks.
