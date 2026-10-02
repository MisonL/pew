# Local E2E isolation

This replaces the remote-resource E2E setup described in historical document 31. API and browser suites run against a new `mkdtemp` D1/KV directory per invocation. There is no production or shared test database dependency, no global configuration change, and no `.env.local` or `.env.test` loading. Both the runner and pre-push reject local environment files; CI no longer injects cloud credentials.

`local-e2e-bindings.ts` generates a minimal Wrangler configuration with no routes, remote bindings or cron, runs Wrangler's native D1 migration command, and loads the real local D1/KV bindings. Both source Worker handlers execute against those bindings. The local HTTP bridge requires a fresh synthetic bearer token and returns the original Cloudflare REST envelope so the application retains one D1 request/error implementation. The override is rejected in production/Railway, with non-test resource IDs, or outside an explicit loopback test environment.

## Fresh schema

`001-init.sql` is explicitly a squashed schema. Its `users.is_public`, `usage_records.device_id` with the multi-device unique key, and `teams.logo_url` supersede `004-is-public.sql`, `006-device-id.sql`, and `006c-team-logo-url.sql`. The fresh-database runner excludes exactly those three historical ALTER migrations; it does not suppress duplicate errors. It applies every other migration in sorted order through Wrangler, with sequential temporary filenames preserving the original lexical order. New migration errors fail the run. Regression checks query the resulting columns, accounting tables, and actual Worker RPC.

## Ownership and cleanup

The database contains exactly `_test_marker('env','test')` and `_test_marker('run',<random run ID>)`. The runner verifies the SQL rows before starting tests and verifies them again before disposal. Read and ingest endpoints must share the owned bridge origin. A health response is never marker evidence. Missing, non-test and mismatched markers are rejected. A mismatched ownership marker retains the suspect directory for investigation, but still stops the owned listeners and runtime.

All credentials and users are synthetic. The child environment is an explicit allowlist, with HOME/config/temp scoped to the run; only executable and browser-cache locations are inherited. Normal exit, test failure, startup failure and handled signals terminate owned children and dispose the binding runtime. The binding runtime runs in a subprocess and closes through IPC, keeping Miniflare's immediate-exit signal hooks outside the parent cleanup handler. Migration failures remove the newly allocated state before it becomes a usable test target. Occupied ports are not killed.

Run `bun run --filter @pew/core build`, `bun run test:e2e`, and `bun run test:e2e:ui`. `scripts/__tests__/local-e2e-bindings.test.ts` covers guard failures and real D1 lifecycle; `scripts/test-local-e2e.ts` is the Bun runtime fixture invoked by Vitest. Existing API, browser, CLI, coverage and security gates remain required.

IPC readiness and disposal each have a 30-second deadline. Abort interrupts readiness immediately. If graceful disposal stops responding, the parent terminates only the subprocess group it created, reports failure and leaves unverified state in place. A no-IPC regression covers both startup timeout and abort; real-process regressions cover migration interruption, running-server interruption and failed Next startup.
