/**
 * One-shot migration runner used by the `migrate` compose service.
 *
 * Waits for rqlite to accept writes, applies every pending migration, then
 * exits 0 so dependent services can start.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Adapter } from "./d1-adapter";
import { createRqliteDdlExecutor } from "./rqlite-client";
import { applyMigrations } from "./migrate";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/migrations");
const SQUASHED = new Set(["004-is-public.sql", "006-device-id.sql", "006c-team-logo-url.sql"]);
const BASE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";

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
  const db = createD1Adapter({ baseUrl: BASE_URL, token: process.env.CF_D1_API_TOKEN ?? "" });
  const ddlExecutor = createRqliteDdlExecutor({ baseUrl: BASE_URL });
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
