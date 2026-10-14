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

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});
