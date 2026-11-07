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
import { applyMigrations, unsquashedSqlFiles } from "./migrate";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/migrations");

/**
 * Measured against rqlite 10.5.3 after applying every migration.
 *
 * `upstreamTables` counts tables the upstream migrations create; the plan
 * adds six more (_migrations, kv_cache, leaderboard_revision_seq from Plan 1;
 * instance_setup, password_resets from Plan 2 / migration 032; rate_limit_hits
 * from Plan 3 / migration 033).
 *
 * Migration 034-device-revocations.sql adds device_records and
 * device_revocations — that is +2 upstream tables, +2 explicit indexes, and
 * +2 sqlite_autoindexes (each table's composite TEXT PRIMARY KEY), plus nine
 * triggers (one alias cascade, four device-registration, four revocation
 * ignore guards). It is numbered 034 here, not 030 as upstream ships it:
 * this fork already applied 030-deterministic-leaderboard-revision through
 * 033 on deployed instances, and the ledger keys on the full filename.
 *
 * `indexes` counts every sqlite_master entry of type 'index', which includes
 * the auto-indexes SQLite creates for PRIMARY KEY and UNIQUE constraints.
 * The explicit count is lower because 023/024/025 retire features and drop
 * their tables (badges, budgets, projects, showcases, project_tags), taking
 * their indexes with them.
 */
const EXPECTED = {
  upstreamTables: 24,
  // _migrations, kv_cache, leaderboard_revision_seq (Plan 1) + instance_setup,
  // password_resets (Plan 2 / migration 032) + rate_limit_hits (Plan 3 / 033).
  planTables: 6,
  // 65 upstream/Plan-1 indexes + two from password_resets (Plan 2 / 032):
  // the explicit idx_password_resets_user and the sqlite_autoindex for its
  // TEXT PRIMARY KEY. instance_setup's INTEGER PRIMARY KEY adds no autoindex.
  // rate_limit_hits (Plan 3 / 033) adds two explicit indexes and no UNIQUE or
  // PRIMARY KEY constraints, so no autoindex. 034 adds four (two explicit,
  // two autoindexes). The count also includes sqlite_autoindex__migrations_1:
  // the ledger table is created by the runner, not by a migration file, so an
  // in-memory replay of the .sql files alone reports one index fewer.
  indexes: 73,
  triggers: 21,
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

export type SchemaCounts = {
  upstreamTables: number;
  planTables: number;
  indexes: number;
  triggers: number;
  views: number;
};

/**
 * The leaderboard revision is 32 lowercase hex characters. Migration 029
 * seeded it from randomblob(16); migration 030 replaced that with a monotonic
 * counter (`printf('%032x', n)`) because randomblob in a trigger body diverges
 * across rqlite replicas. Only the shape is stable across both.
 */
export const REVISION_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Compare measured schema counts against the expected shape. Pure, so the
 * assertion logic is unit-tested without a live rqlite (the run itself needs
 * a throwaway node).
 */
export function schemaMismatches(actual: SchemaCounts, expected: SchemaCounts): string[] {
  return (Object.keys(expected) as (keyof SchemaCounts)[])
    .filter((key) => actual[key] !== expected[key])
    .map((key) => `${key}: got ${actual[key]}, expected ${expected[key]}`);
}

/** Split the raw table-name census into upstream vs plan tables. */
export function partitionTables(names: string[]): { upstreamTables: number; planTables: number } {
  const plan = names.filter((n) => PLAN_TABLES.has(n)).length;
  return { upstreamTables: names.length - plan, planTables: plan };
}

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
    return unsquashedSqlFiles(await readdir(dir));
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
  const { upstreamTables, planTables } = partitionTables(names);

  const actual: SchemaCounts = {
    upstreamTables,
    planTables,
    indexes: await count("index"),
    triggers: await count("trigger"),
    views: await count("view"),
  };
  console.log("schema:", actual, "expected:", EXPECTED);

  const mismatches = schemaMismatches(actual, EXPECTED);
  if (mismatches.length > 0) {
    throw new Error(`schema mismatch: ${mismatches.join("; ")}`);
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
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`leaderboard revision malformed: ${revision}`);
  }
  console.log(`leaderboard revision ok: ${revision}`);

  console.log("migration verification PASSED");
}

// Only run when invoked directly, so the module can be imported by tests.
if (import.meta.main ?? process.argv[1]?.endsWith("verify-migrations.ts")) {
  main().catch((error: unknown) => {
    console.error("migration verification FAILED:", error);
    process.exit(1);
  });
}
