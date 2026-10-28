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
  // Both probes are bounded like waitForRqlite's: migrate gates five of the
  // six containers (compose depends_on service_completed_successfully, and
  // web waits on read/ingest health), so a rqlite that accepts TCP but never
  // answers must not park the whole starter for undici's default headers
  // timeout on each of two sequential fetches.
  const status = await fetchImpl(`${baseUrl}/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const body = (await status.json()) as { http?: { auth?: string } };
  if (status.ok && body.http?.auth !== "enabled") {
    throw new Error(
      "auth reconciliation failed: credentials configured but auth is disabled on the server"
    );
  }
  // '*' grants status/ready to everyone; data endpoints must still 401.
  const probe = await fetchImpl(`${baseUrl}/db/query?q=${encodeURIComponent("SELECT 1")}`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (probe.ok) {
    throw new Error("auth reconciliation failed: anonymous query succeeded (auth misconfigured)");
  }
}

/**
 * Per-attempt probe budget. Node's fetch has no default timeout (the
 * d1-adapter comment makes the same point), so a rqlite that accepts TCP but
 * never answers would let ONE attempt run past the 60s deadline and turn the
 * loop into a five-minute hang. Each attempt is capped well below the poll
 * interval so a stuck connection is retried rather than waited on.
 */
const PROBE_TIMEOUT_MS = 5_000;

export async function waitForRqlite(
  timeoutMs = 60_000,
  deps: {
    baseUrl?: string;
    fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    delay?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const baseUrl = deps.baseUrl ?? BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status: number | undefined;
    try {
      // Probe /readyz, not /status. In the cluster profile rqlite-1 is started
      // with -bootstrap-expect 3 and a full -join list; /status returns HTTP
      // 200 while it is still waiting for quorum (verified on 10.5.3), so a
      // /status probe would let migrate run before a leader exists and fail.
      // /readyz only turns 200 once a leader is up. /readyz is also right for
      // the single profile (-bootstrap-expect 1 elects immediately).
      const res = await fetchImpl(`${baseUrl}/readyz`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) return;
      status = res.status;
    } catch {
      // not up yet (connection refused, or this attempt's own timeout)
    }
    // A 401/403 is not "still starting": rqlite is up and answering, but auth
    // is enabled and this unauthenticated probe is refused. The rendered
    // auth.json must grant status/ready to '*'; without that entry every retry
    // burns the full timeout and the final message wrongly blames readiness.
    // Fail fast with the actual cause instead.
    if (status === 401 || status === 403) {
      throw new Error(
        `rqlite at ${baseUrl} answered ${status} on /readyz: auth is enabled but this probe ` +
          `is unauthenticated. The rendered auth.json must grant status/ready to '*' ` +
          `(and the data users must match RQLITE_USERNAME/RQLITE_PASSWORD).`
      );
    }
    await delay(1000);
  }
  throw new Error(`rqlite at ${baseUrl} did not become ready`);
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
