/**
 * Applies every migration to a live rqlite instance and asserts the resulting
 * schema shape. Run against a throwaway node:
 *
 *   docker run -d --name rq-verify -p 14001:4001 rqlite/rqlite:10.5.3 -fk
 *   bun run deploy/selfhost/verify-migrations.ts --base-url http://127.0.0.1:14001
 *
 * Also idempotency-checks by running the migration set a second time: the
 * ledger must report everything as skipped and nothing may throw.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Adapter } from "./d1-adapter";
import { createRqliteDdlExecutor } from "./rqlite-client";
import { resolveEnvBasicAuth } from "./basic-auth";
import { applyMigrations } from "./migrate";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/migrations");

/** Migrations squashed into later files; wrangler skips them, so must we. */
const SQUASHED = new Set(["004-is-public.sql", "006-device-id.sql", "006c-team-logo-url.sql"]);

/**
 * Measured against rqlite 10.5.3 after applying every migration.
 *
 * `upstreamTables` counts tables the upstream migrations create; the plan
 * adds six more (_migrations, kv_cache, leaderboard_revision_seq from Plan 1;
 * instance_setup, password_resets from Plan 2 / migration 032; rate_limit_hits
 * from Plan 3 / migration 033).
 *
 * `indexes` counts every sqlite_master entry of type 'index', which includes
 * the auto-indexes SQLite creates for PRIMARY KEY and UNIQUE constraints.
 * The explicit count is lower because 023/024/025 retire features and drop
 * their tables (badges, budgets, projects, showcases, project_tags), taking
 * their indexes with them.
 */
const EXPECTED = {
  upstreamTables: 22,
  // _migrations, kv_cache, leaderboard_revision_seq (Plan 1) + instance_setup,
  // password_resets (Plan 2 / migration 032) + rate_limit_hits (Plan 3 / 033).
  planTables: 6,
  // 65 upstream/Plan-1 indexes + two from password_resets (Plan 2 / 032):
  // the explicit idx_password_resets_user and the sqlite_autoindex for its
  // TEXT PRIMARY KEY. instance_setup's INTEGER PRIMARY KEY adds no autoindex.
  // rate_limit_hits (Plan 3 / 033) adds two explicit indexes and no UNIQUE or
  // PRIMARY KEY constraints, so no autoindex.
  indexes: 69,
  triggers: 12,
  views: 2,
};

/** Tables this plan creates, on top of what upstream migrations define. */
const PLAN_TABLES = new Set([
  "_migrations",
  "kv_cache",
  "leaderboard_revision_seq",
  "instance_setup",
  "password_resets",
  // Plan 3 / migration 033.
  "rate_limit_hits",
]);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const baseUrl = arg("base-url") ?? "http://127.0.0.1:14001";
  const basicAuth = resolveEnvBasicAuth();
  const db = createD1Adapter({ baseUrl, token: "", ...(basicAuth ? { basicAuth } : {}) });
  const ddlExecutor = createRqliteDdlExecutor({ baseUrl, ...(basicAuth ? { basicAuth } : {}) });

  const readDir = async (dir: string) => {
    const { readdir } = await import("node:fs/promises");
    const all = await readdir(dir);
    return all.filter((f) => f.endsWith(".sql") && !SQUASHED.has(f));
  };

  const first = await applyMigrations({ db, dir: MIGRATIONS_DIR, ddlExecutor, readDir, log: console.log });
  console.log(`applied ${first.applied.length} migrations`);

  const second = await applyMigrations({
    db,
    dir: MIGRATIONS_DIR,
    ddlExecutor,
    readDir,
    log: () => {
      /* second pass is expected to be silent */
    },
  });
  if (second.applied.length !== 0) {
    throw new Error(`ledger not idempotent: reapplied ${second.applied.join(", ")}`);
  }
  console.log(`idempotency ok: skipped ${second.skipped.length}`);

  // Counts every entry of the given type, including SQLite's implicit
  // sqlite_autoindex_* rows, so the numbers match a plain
  // `SELECT name FROM sqlite_master WHERE type='index'`.
  const count = async (type: string): Promise<number> => {
    const { results } = await db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ?")
      .bind(type)
      .all<{ n: number }>();
    return results[0]?.n ?? 0;
  };

  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all<{ name: string }>();
  const names = tables.results.map((r) => r.name);
  const planTables = names.filter((n) => PLAN_TABLES.has(n));
  const upstreamTables = names.length - planTables.length;

  const actual = {
    upstreamTables,
    planTables: planTables.length,
    indexes: await count("index"),
    triggers: await count("trigger"),
    views: await count("view"),
  };
  console.log("schema:", actual, "expected:", EXPECTED);

  for (const [key, expected] of Object.entries(EXPECTED)) {
    const got = actual[key as keyof typeof actual];
    if (got !== expected) {
      throw new Error(`schema mismatch for ${key}: got ${got}, expected ${expected}`);
    }
  }

  // The KV adapter is useless without its backing table; a missing table only
  // shows up at runtime, never in the unit tests (they use an in-memory fake).
  if (!names.includes("kv_cache")) {
    throw new Error("kv_cache table missing — worker-read cache would fail at runtime");
  }

  // Non-determinism guard: DDL must not have been frozen by rqlite.
  const { results: revisionRows } = await db
    .prepare("SELECT revision FROM leaderboard_revision WHERE id = 1")
    .all<{ revision: string }>();
  const revision = revisionRows[0]?.revision ?? "";
  if (!/^[a-f0-9]{32}$/.test(revision)) {
    throw new Error(`leaderboard revision malformed: ${revision}`);
  }
  console.log(`leaderboard revision ok: ${revision}`);

  console.log("migration verification PASSED");
}

main().catch((error: unknown) => {
  console.error("migration verification FAILED:", error);
  process.exit(1);
});
