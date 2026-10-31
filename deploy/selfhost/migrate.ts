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
 * Migrations squashed into later files. Upstream (wrangler) skips them, so a
 * runner that applied them would create tables/columns the hosted deployment
 * never has — and both the migrate service and verify-migrations.ts must
 * exclude the same set, so the list lives here rather than in each caller.
 */
export const SQUASHED_MIGRATIONS = ["004-is-public.sql", "006-device-id.sql", "006c-team-logo-url.sql"] as const;

/** `readDir` filter shared by the compose migrate service and verify-migrations. */
export function unsquashedSqlFiles(names: string[]): string[] {
  const squashed = new Set<string>(SQUASHED_MIGRATIONS);
  return names.filter((f) => f.endsWith(".sql") && !squashed.has(f));
}

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
  return /^\s*(CREATE|ALTER|DROP|REINDEX|VACUUM)\b/i.test(stripLeadingComments(sql));
}

/**
 * Statements whose leading block comment would otherwise defeat the anchor in
 * isDdlStatement — `/* header *\/ CREATE TABLE ...` classifies as DML and gets
 * rqlite's deterministic rewrite, freezing `DEFAULT (datetime('now'))` into
 * sqlite_master. (Line comments are already cut by the splitter.) The comment
 * is only stripped for classification; the statement itself is sent verbatim.
 */
function stripLeadingComments(sql: string): string {
  let out = sql;
  for (;;) {
    const next = out.replace(/^\s+/, "").replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === out) return out;
    out = next;
  }
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
  // Block comments span lines, so this state lives outside the line loop.
  // Without it a `;` inside `/* ... */` splits a statement in half.
  let inBlockComment = false;
  // BEGIN/END are recognized in the SAME scan that handles quotes and
  // comments: a separate regex pass over the raw text latched on the literal
  // in `VALUES ('BEGIN')` (swallowing the rest of the file) and closed a
  // trigger body early at the END of a CASE expression.
  let word = "";
  // A trigger body's END must not be confused with the END of a CASE
  // expression inside it; track the nesting depth.
  let caseDepth = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  // BEGIN opens a trigger body, END closes it; both matched at word boundaries
  // so identifiers like "endpoint" or "beginning" do not trip the state.
  const endWord = () => {
    if (!word) return;
    const upper = word.toUpperCase();
    if (upper === "CASE" && inTrigger) caseDepth += 1;
    else if (!inTrigger && upper === "BEGIN") inTrigger = true;
    else if (inTrigger && upper === "END") {
      if (caseDepth > 0) caseDepth -= 1;
      else inTrigger = false;
    }
    word = "";
  };

  const lines = sql.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    let i = 0;
    let start = 0;
    let end = line.length; // content stops here (line comment cut)
    while (i < line.length) {
      const ch = line[i];
      if (inBlockComment) {
        if (ch === "*" && line[i + 1] === "/") { inBlockComment = false; i += 2; continue; }
        i += 1;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      // Block comment: skip to its end (possibly on a later line).
      if (ch === "/" && line[i + 1] === "*") {
        endWord();
        inBlockComment = true;
        i += 2;
        continue;
      }
      // Line comment: discard the rest of the line.
      if (ch === "-" && line[i + 1] === "-") {
        endWord();
        end = i;
        break;
      }
      if (ch === "'" || ch === '"') {
        endWord();
        quote = ch;
        i += 1;
        continue;
      }
      if (/[A-Za-z0-9_]/.test(ch ?? "")) {
        word += ch;
        i += 1;
        continue;
      }
      endWord();
      if (ch === ";") {
        const body = line.slice(start, i);
        // A ";" inside a body is kept; one that closes the body (or is
        // outside one) is the statement terminator and is dropped.
        current += inTrigger ? body + ";" : body;
        start = i + 1;
        if (!inTrigger) flush();
      }
      i += 1;
    }
    endWord();
    const tail = line.slice(start, end) + (li < lines.length - 1 ? "\n" : "");
    current += tail;
  }

  endWord();
  flush();
  return statements;
}

/**
 * SQLite errors that mean "this DDL already took effect". A migration file is
 * applied statement-by-statement and only recorded in the ledger once every
 * statement succeeds; if the process dies partway (or a file mixes DDL and DML,
 * which cannot be one atomic request), a re-run replays the file from the top
 * and trips over objects that already exist. Upstream migrations use bare
 * CREATE TABLE / CREATE TRIGGER (e.g. 029), so this is the recovery path.
 *
 * Only these specific idempotency errors are tolerated — a genuine error
 * (missing table, syntax, constraint on unseeded data) still aborts.
 */
function isBenignReplayError(stmt: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (isDdlStatement(stmt)) {
    return /already exists/i.test(message) || /duplicate column name/i.test(message);
  }
  // DML: a crash between a seed INSERT and the ledger write replays the file;
  // single-row seed INSERTs tolerate the UNIQUE hit on the replayed row. A
  // UNIQUE failure in an INSERT ... SELECT backfill is NOT tolerated — that
  // is a genuine data error and must abort (so it can never be silently
  // recorded as applied).
  return /^\s*INSERT\s+INTO\b/i.test(stmt) && !/\bSELECT\b/i.test(stmt)
    && /UNIQUE constraint failed/i.test(message);
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
    .strong<{ id: string }>();
  const done = new Set(results.map((r) => r.id));

  const files = (await readDirImpl(options.dir))
    .filter((name) => name.endsWith(".sql"))
    // Byte order, matching scripts/local-e2e-bindings.ts and
    // scripts/test-local-e2e.ts. A locale-aware sort ("en") orders "_" and "-"
    // differently from those, so the hosted path and the test path could apply
    // the same migration set in a different order once a name like "030-A.sql"
    // appears — and both would still consider every file applied.
    .sort();

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
    // Consecutive DDL runs are coalesced into one ddlExecutor call, which is
    // itself atomic (see rqlite-client: transaction=true).
    let pendingDdl: string[] = [];
    const flushDdl = async () => {
      if (pendingDdl.length === 0) return;
      const batch = pendingDdl;
      pendingDdl = [];
      try {
        await options.ddlExecutor(batch);
      } catch {
        // A partially-applied earlier run may have created some of these
        // objects. Retry the batch statement-by-statement, skipping only the
        // ones that already exist, so the rest still apply.
        for (const stmt of batch) {
          try {
            await options.ddlExecutor([stmt]);
          } catch (statementError) {
            if (isBenignReplayError(stmt, statementError)) continue;
            throw statementError;
          }
        }
      }
    };
    for (const stmt of statements) {
      if (isDdlStatement(stmt)) {
        pendingDdl.push(stmt);
      } else {
        await flushDdl();
        try {
          await options.db.prepare(stmt).run();
        } catch (statementError) {
          // Crash-before-ledger replay: idempotent seeds re-apply cleanly.
          if (isBenignReplayError(stmt, statementError)) {
            log(`tolerated replay of seed statement in ${name}: ${statementError instanceof Error ? statementError.message : String(statementError)}`);
            continue;
          }
          throw statementError;
        }
      }
    }
    await flushDdl();
    try {
      await options.db
        .prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))")
        .bind(name)
        .run();
    } catch (ledgerError) {
      // Two migrate processes can run concurrently (`docker compose run --rm
      // migrate` alongside `up`, or an operator re-running recovery). The DDL
      // is idempotent, so the loser's statements are harmless; but its ledger
      // INSERT hits the PRIMARY KEY and a raw SQLite error would abort a run
      // whose migration is in fact applied, and block every dependent service.
      // "Already recorded" is the same end state this process wanted.
      const message = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
      if (!/UNIQUE constraint failed/i.test(message)) throw ledgerError;
      log(`recorded concurrently by another migrate process: ${name}`);
    }
    applied.push(name);
    log(`applied ${name} (${statements.length} statements)`);
  }

  return { applied, skipped };
}
