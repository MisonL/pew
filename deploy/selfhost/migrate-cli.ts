/**
 * One-shot migration runner used by the `migrate` compose service.
 *
 * Waits for rqlite to accept writes, applies every pending migration, then
 * exits 0 so dependent services can start.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveEnvBasicAuth } from "./basic-auth";
import { createD1Adapter } from "./d1-adapter";
import { createRqliteDdlExecutor } from "./rqlite-client";
import { applyMigrations } from "./migrate";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/migrations");
const SQUASHED = new Set(["004-is-public.sql", "006-device-id.sql", "006c-team-logo-url.sql"]);
const BASE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";

/**
 * Partial credential configuration must fail closed.
 *
 * render-rqlite-auth.sh deletes auth.json and exits 1 when the three variables
 * are not all set — but the stack is usually started by a separate `compose up`
 * afterwards, so a half-filled .env reaches rqlite as "no -auth at all" and
 * every service connects anonymously. `assertAuthReconciled` cannot catch it:
 * `expectAuth` is derived from the full pair alone, so a JOIN-only fill makes it
 * skip the probe. Verified combination on 2026-10-21 review: JOIN set + full
 * pair empty -> auth.json removed -> rqlited without -auth -> migrate healthy,
 * whole stack unauthenticated with no warning.
 *
 * Empty strings count as unset: compose injects `${VAR:-}` defaults, so a
 * blank .env entry must behave like a missing one (same rule as
 * resolveBasicAuth in basic-auth.ts).
 */
export function assertCredentialConsistency(env: NodeJS.ProcessEnv = process.env): void {
  const vars = ["RQLITE_USERNAME", "RQLITE_PASSWORD", "RQLITE_JOIN_PASSWORD"] as const;
  const missing = vars.filter((name) => !env[name]);
  if (missing.length === 0 || missing.length === vars.length) return;
  throw new Error(
    `credentials are partially configured: ${missing.join(", ")} empty — set all of ` +
      `RQLITE_USERNAME/RQLITE_PASSWORD/RQLITE_JOIN_PASSWORD or none. With a partial set the ` +
      `render script deletes auth.json, rqlite starts WITHOUT -auth, and every service would ` +
      `connect anonymously.`
  );
}

/**
 * Reconciliation probe (spec §3.1.4): rqlite IGNORES every Authorization
 * header when started without -auth (verified), so a fully-configured client
 * would silently run unauthenticated. Guards against config mistakes only —
 * NOT a security boundary (in-network spoofing is out of scope).
 */
export async function assertAuthReconciled(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  baseUrl: string,
  expectAuth: boolean
): Promise<void> {
  if (!expectAuth) return;
  const status = await fetchImpl(`${baseUrl}/status`);
  const body = (await status.json()) as { http?: { auth?: string } };
  if (status.ok && body.http?.auth !== "enabled") {
    throw new Error(
      "auth reconciliation failed: credentials configured but auth is disabled on the server"
    );
  }
  // '*' grants status/ready to everyone; data endpoints must still 401.
  const probe = await fetchImpl(`${baseUrl}/db/query?q=${encodeURIComponent("SELECT 1")}`);
  if (probe.ok) {
    throw new Error("auth reconciliation failed: anonymous query succeeded (auth misconfigured)");
  }
}

async function waitForRqlite(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Probe /readyz, not /status. In the cluster profile rqlite-1 is started
      // with -bootstrap-expect 3 and a full -join list; /status returns HTTP
      // 200 while it is still waiting for quorum (verified on 10.5.3), so a
      // /status probe would let migrate run before a leader exists and fail.
      // /readyz only turns 200 once a leader is up. /readyz is also right for
      // the single profile (-bootstrap-expect 1 elects immediately).
      const res = await fetch(`${BASE_URL}/readyz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`rqlite at ${BASE_URL} did not become ready`);
}

async function main(): Promise<void> {
  await waitForRqlite();
  assertCredentialConsistency();
  const basicAuth = resolveEnvBasicAuth();
  await assertAuthReconciled(fetch, BASE_URL, basicAuth !== undefined);
  const db = createD1Adapter({ baseUrl: BASE_URL, token: "", ...(basicAuth ? { basicAuth } : {}) });
  const ddlExecutor = createRqliteDdlExecutor({ baseUrl: BASE_URL, ...(basicAuth ? { basicAuth } : {}) });
  const result = await applyMigrations({
    db,
    dir: MIGRATIONS_DIR,
    ddlExecutor,
    readDir: async (dir) => {
      const { readdir } = await import("node:fs/promises");
      return (await readdir(dir)).filter((f) => f.endsWith(".sql") && !SQUASHED.has(f));
    },
    log: console.log,
  });
  console.log(`migrations done: applied ${result.applied.length}, skipped ${result.skipped.length}`);
}

// Only run when invoked directly, so the module can be imported by tests
// (auth-reconcile.test.ts imports assertAuthReconciled). Without this guard
// an import starts the 60s waitForRqlite retry loop in the test process.
// Plain `import.meta.main`: `??` would never fall through on an explicit
// false, and the argv fallback would fire main() for any process whose
// argv[1] merely ends with this filename.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("migration failed:", error);
    process.exit(1);
  });
}
