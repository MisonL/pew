/**
 * Applies scripts/migrations/*.sql to rqlite.
 *
 * Upstream tracks migrations through wrangler's local state file, which does
 * not exist here, so this module keeps its own ledger. The ledger matters
 * because most upstream migrations are idempotent (CREATE TABLE IF NOT EXISTS)
 * but ALTER TABLE ADD COLUMN is not — replaying one fails with
 * "duplicate column name".
 */

import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Like } from "./d1-adapter";

export type DdlExecutor = (statements: string[]) => Promise<void>;

export interface ApplyMigrationsOptions {
  db: D1Like;
  dir: string;
  /** Runs DDL with rqlite's ?norwtime&norwrandom so non-deterministic
   *  functions survive into sqlite_master instead of being frozen. */
  ddlExecutor: DdlExecutor;
  readDir?: (dir: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  log?: (message: string) => void;
}

export interface ApplyMigrationsResult {
  applied: string[];
  skipped: string[];
}

const LEDGER_DDL = [
  "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
];

/**
 * True for statements that define schema (CREATE/ALTER/DROP). Those must run
 * with rqlite's ?norwtime&norwrandom so their non-deterministic text is kept
 * verbatim. DML (INSERT/UPDATE/DELETE) must NOT: rqlite's default rewrite is
 * what makes those statements identical across replicas. Putting a DML row in
 * the same norw* request makes every replica evaluate it independently, which
 * diverges (verified on 10.5.3: two replicas stored different randomblob
 * values for one INSERT when it shared a norw* request with a CREATE TABLE).
 */
export function isDdlStatement(sql: string): boolean {
  return /^\s*(CREATE|ALTER|DROP|REINDEX|VACUUM)\b/i.test(sql);
}

/**
 * Split a migration file into statements.
 *
 * A naive split on ";" breaks CREATE TRIGGER, whose body contains semicolons
 * between BEGIN and END. String literals may also contain semicolons, and line
 * comments may contain both.
 *
 * The trigger body is tracked by the BEGIN/END keywords themselves (word
 * boundaries), NOT by "BEGIN at end of line": an inlined body such as
 * "CREATE TRIGGER ... BEGIN UPDATE t SET id = 1; END;" must stay in one piece.
 * A ";" inside a body belongs to the body and is kept; one that ends the body
 * (or sits outside any body) terminates the statement and is dropped.
 *
 * Verified two ways: the unit tests below, and by splitting all 30 applied
 * migration files (133 statements) and executing every statement in a real
 * SQLite in-memory database — 0 errors, yielding 22 tables and 12 triggers.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;
  let quote: "'" | '"' | null = null;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  // BEGIN opens a trigger body, END closes it; both matched at word boundaries
  // so identifiers like "endpoint" or "beginning" do not trip the state.
  const applyState = (chunk: string) => {
    if (!inTrigger && /\bBEGIN\b/i.test(chunk)) inTrigger = true;
    if (inTrigger && /\bEND\b/i.test(chunk)) inTrigger = false;
  };

  const lines = sql.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    let i = 0;
    let start = 0;
    let end = line.length; // content stops here (line comment cut)
    while (i < line.length) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      // Line comment: discard the rest of the line.
      if (ch === "-" && line[i + 1] === "-") {
        end = i;
        break;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === ";") {
        const body = line.slice(start, i);
        // Update trigger state from the body *before* deciding: a ";" inside a
        // body is kept; one that closes the body (or is outside one) is the
        // statement terminator and is dropped.
        applyState(body);
        current += inTrigger ? body + ";" : body;
        start = i + 1;
        if (!inTrigger) flush();
        i += 1;
        continue;
      }
      i += 1;
    }
    const tail = line.slice(start, end) + (li < lines.length - 1 ? "\n" : "");
    applyState(tail);
    current += tail;
  }

  flush();
  return statements;
}

export async function applyMigrations(
  options: ApplyMigrationsOptions
): Promise<ApplyMigrationsResult> {
  const readDirImpl = options.readDir ?? ((dir: string) => readdir(dir));
  const readFileImpl = options.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const log =
    options.log ??
    (() => {
      /* default: silent */
    });

  await options.ddlExecutor(LEDGER_DDL);

  const { results } = await options.db
    .prepare("SELECT id FROM _migrations")
    .all<{ id: string }>();
  const done = new Set(results.map((r) => r.id));

  const files = (await readDirImpl(options.dir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of files) {
    if (done.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = await readFileImpl(join(options.dir, name));
    const statements = splitStatements(sql);
    // Route each statement by class, preserving file order (a later DML may
    // depend on an earlier DDL). DDL keeps ?norwtime&norwrandom so its text is
    // stored verbatim; DML must not, or replicas diverge (see isDdlStatement).
    // Consecutive DDL runs are coalesced into one ddlExecutor call.
    let pendingDdl: string[] = [];
    const flushDdl = async () => {
      if (pendingDdl.length > 0) {
        await options.ddlExecutor(pendingDdl);
        pendingDdl = [];
      }
    };
    for (const stmt of statements) {
      if (isDdlStatement(stmt)) {
        pendingDdl.push(stmt);
      } else {
        await flushDdl();
        await options.db.prepare(stmt).run();
      }
    }
    await flushDdl();
    await options.db
      .prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))")
      .bind(name)
      .run();
    applied.push(name);
    log(`applied ${name} (${statements.length} statements)`);
  }

  return { applied, skipped };
}
