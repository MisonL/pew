import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitStatements, applyMigrations, isDdlStatement } from "./migrate";
import type { D1Like, D1Result, D1StatementLike } from "./d1-adapter";

describe("splitStatements", () => {
  it("splits plain statements on semicolons", () => {
    const out = splitStatements("CREATE TABLE a(x);\nCREATE INDEX i ON a(x);");
    expect(out).toEqual(["CREATE TABLE a(x)", "CREATE INDEX i ON a(x)"]);
  });

  it("keeps a CREATE TRIGGER body intact across internal semicolons", () => {
    const sql = [
      "CREATE TABLE t(id INTEGER);",
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN",
      "  UPDATE t SET id = 1;",
      "  UPDATE t SET id = 2;",
      "END;",
      "CREATE INDEX i ON t(id);",
    ].join("\n");
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(out[1]).toContain("UPDATE t SET id = 1;");
    expect(out[1]).toContain("UPDATE t SET id = 2;");
    expect(out[1].trimEnd().endsWith("END")).toBe(true);
    expect(out[2]).toBe("CREATE INDEX i ON t(id)");
  });

  it("ignores semicolons inside string literals", () => {
    const out = splitStatements("INSERT INTO t VALUES ('a;b');");
    expect(out).toEqual(["INSERT INTO t VALUES ('a;b')"]);
  });

  it("keeps a CREATE TRIGGER body intact even when BEGIN is on the same line as the first statement", () => {
    // The splitter used to key off "BEGIN at end of line", so an inlined body
    // ("CREATE TRIGGER ... BEGIN UPDATE t SET id = 1; END;") was shredded into
    // separate statements. Track the body by the BEGIN keyword itself.
    const sql = "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET id = 1; END;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("BEGIN UPDATE t SET id = 1; END");
  });

  it("drops comment-only and blank fragments", () => {
    const out = splitStatements("-- a comment\n\nCREATE TABLE a(x);\n");
    expect(out).toEqual(["CREATE TABLE a(x)"]);
  });

  it("keeps a trigger body intact across a WHEN clause with its own newlines", () => {
    // 029 shapes AFTER UPDATE ... ON users WHEN OLD.x IS NOT NEW.x ... across
    // several lines before BEGIN. Those line boundaries must not split the body.
    const sql = [
      "CREATE TRIGGER w AFTER UPDATE OF id, name ON users",
      "WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name",
      "BEGIN",
      "  UPDATE x SET y = 1;",
      "END;",
    ].join("\n");
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("WHEN OLD.id IS NOT NEW.id");
    expect(out[0]).toContain("UPDATE x SET y = 1;");
    expect(out[0].trimEnd().endsWith("END")).toBe(true);
  });

  it("handles a trigger whose body ends on the same line as its last statement", () => {
    const out = splitStatements("CREATE TRIGGER t AFTER INSERT ON u BEGIN UPDATE r SET x = 1; END;\nCREATE INDEX i ON u(id);");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("UPDATE r SET x = 1; END");
    expect(out[1]).toBe("CREATE INDEX i ON u(id)");
  });

  it("does not treat a BEGIN inside a string literal as a trigger body", () => {
    // A naive keyword regex latched inTrigger on the literal and swallowed the
    // rest of the file into one "statement" (verified before the fix).
    const out = splitStatements("INSERT INTO t VALUES ('BEGIN');\nCREATE INDEX i ON t(x);");
    expect(out).toEqual(["INSERT INTO t VALUES ('BEGIN')", "CREATE INDEX i ON t(x)"]);
  });

  it("does not close a trigger body at the END of a CASE expression", () => {
    // The CASE's END used to close the trigger early, producing a truncated
    // CREATE TRIGGER plus a stray "END" statement.
    const sql = "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE r SET x = CASE WHEN 1 THEN 2 END; END;\nCREATE INDEX i ON t(x);";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CASE WHEN 1 THEN 2 END;");
    expect(out[0].trimEnd().endsWith("END")).toBe(true);
    expect(out[1]).toBe("CREATE INDEX i ON t(x)");
  });

  it("splits every shipped migration into statements a real SQLite accepts", () => {
    // The unit cases above cover the shapes we know about; this one is the
    // end-to-end guard: a splitter regression that only trips on a real file
    // (a string literal, a CASE inside a trigger, a comment) still surfaces
    // here. Executes in-process against node:sqlite, so no rqlite is needed.
    const dir = join(import.meta.dirname, "../../scripts/migrations");
    const squashed = new Set(["004-is-public.sql", "006-device-id.sql", "006c-team-logo-url.sql"]);
    const db = new DatabaseSync(":memory:");
    try {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql") && !squashed.has(n)).sort()) {
        for (const statement of splitStatements(readFileSync(join(dir, name), "utf8"))) {
          expect(() => db.exec(statement), `${name}: ${statement.slice(0, 80)}`).not.toThrow();
        }
      }
      const tables = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get() as { c: number };
      const triggers = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger'").get() as { c: number };
      expect(tables.c).toBe(28);
      expect(triggers.c).toBe(12);
    } finally {
      db.close();
    }
  });

  it("keeps a string literal that spans lines intact", () => {
    // Quote state must persist across lines: a multi-line literal holds a `;`
    // and can contain BEGIN/END words.
    const out = splitStatements("INSERT INTO t VALUES ('BEGIN\nEND;a');\nCREATE INDEX i ON t(x);");
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("INSERT INTO t VALUES ('BEGIN\nEND;a')");
    expect(out[1]).toBe("CREATE INDEX i ON t(x)");
  });

  it("handles a CASE nested inside a trigger body", () => {
    // depth must be counted, not just toggled: two CASEs need two ENDs.
    const out = splitStatements("CREATE TRIGGER t AFTER INSERT ON u BEGIN UPDATE r SET x = CASE WHEN 1 THEN CASE WHEN 2 THEN 3 END ELSE 4 END; END;\nCREATE INDEX i ON u(x);");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CASE WHEN 1 THEN CASE WHEN 2 THEN 3 END ELSE 4 END;");
    expect(out[0].trimEnd().endsWith("END")).toBe(true);
    expect(out[1]).toBe("CREATE INDEX i ON u(x)");
  });

  it("ignores semicolons inside block comments", () => {
    // The comment text may stay attached to the following statement (SQL
    // accepts leading comments); what must not happen is a split at the `;`
    // inside it.
    const out = splitStatements("CREATE TABLE a(x);\n/* split; me */\nCREATE INDEX i ON a(x);");
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("CREATE TABLE a(x)");
    expect(out[1]).toContain("CREATE INDEX i ON a(x)");
  });

  it("classifies a statement behind a leading block comment as DDL", () => {
    // The retained leading comment used to defeat the ^\s*(CREATE|...) anchor:
    // such a statement went to prepare().run() (!norw*), so rqlite rewrote its
    // DEFAULT (datetime('now')) into a frozen literal in sqlite_master — the
    // exact failure the norw* split exists to prevent.
    const out = splitStatements("/* header */\nCREATE TABLE x (a TEXT);\n");
    expect(out).toHaveLength(1);
    expect(isDdlStatement(out[0]!.trimEnd())).toBe(true);
    // Comment-only differences must not change the classification of DML.
    expect(isDdlStatement("/* c */ INSERT INTO t VALUES (1)")).toBe(false);
    expect(isDdlStatement("/* c1 */ /* c2 */\nALTER TABLE t ADD COLUMN c TEXT")).toBe(true);
  });
});

/** Fake D1Like recording executed SQL, plus an in-memory _migrations table. */
function makeFakeDb() {
  const applied: string[] = [];
  const executed: string[] = [];
  const db: D1Like = {
    prepare(sql: string): D1StatementLike {
      let params: unknown[] = [];
      const stmt: D1StatementLike = {
        sql,
        get params() {
          return params;
        },
        bind: (...next: unknown[]) => {
          params = next;
          return stmt;
        },
        all: async <T,>(): Promise<D1Result<T>> =>
          ({ success: true, results: applied.map((id) => ({ id })) as unknown as T[], meta: { changes: 0, duration: 0 } }),
        strong: async <T,>(): Promise<D1Result<T>> =>
          ({ success: true, results: applied.map((id) => ({ id })) as unknown as T[], meta: { changes: 0, duration: 0 } }),
        first: async <T,>(): Promise<T | null> => null,
        run: async (): Promise<D1Result> => {
          executed.push(sql);
          if (sql.startsWith("INSERT INTO _migrations")) applied.push(params[0] as string);
          return { success: true, results: [], meta: { changes: 1, duration: 0 } };
        },
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { db, applied, executed };
}

describe("applyMigrations", () => {
  const files = ["001-init.sql", "002-add-col.sql"];

  it("applies pending migrations in filename order", async () => {
    const { db, applied } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => [...files].reverse(),
      readFile: async (p) => `CREATE TABLE ${p.replace(/\W/g, "_")}(x);`,
    });
    expect(result.applied).toEqual(files);
    expect(result.skipped).toEqual([]);
    expect(applied).toEqual(files);
    // One DDL call per migration, plus the initial ledger DDL.
    expect(ddl).toHaveBeenCalledTimes(3);
  });

  it("skips migrations already recorded in the ledger", async () => {
    const { db, applied } = makeFakeDb();
    applied.push("001-init.sql"); // simulate a previous run
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => files,
      readFile: async () => "CREATE TABLE x(y);",
    });
    expect(result.applied).toEqual(["002-add-col.sql"]);
    expect(result.skipped).toEqual(["001-init.sql"]);
    // Ledger DDL + only the one pending migration.
    expect(ddl).toHaveBeenCalledTimes(2);
  });

  it("creates the ledger table before consulting it", async () => {
    const { db } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => [],
      readFile: async () => "",
    });
    const firstCall = ddl.mock.calls[0][0] as string[];
    expect(firstCall.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS _migrations"))).toBe(true);
  });

  it("ignores non-sql files", async () => {
    const { db } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["001-init.sql", "README.md"],
      readFile: async () => "CREATE TABLE x(y);",
    });
    expect(result.applied).toEqual(["001-init.sql"]);
  });

  it("sends DDL to the ddlExecutor and DML to prepare().run() — never both", async () => {
    // A migration file can mix DDL and DML (029 has CREATE TABLE + INSERT + 12
    // CREATE TRIGGER). DDL must keep ?norwtime&norwrandom; DML must not, or
    // replicas evaluate it independently and diverge (verified on 10.5.3).
    // ddl is called 3 times: ledger, then the CREATE TABLE (flushed by the
    // INSERT), then the trailing CREATE TRIGGER (flushed at end of file).
    const { db, executed } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["029.sql"],
      readFile: async () =>
        [
          "CREATE TABLE leaderboard_revision (id INTEGER PRIMARY KEY, revision TEXT NOT NULL);",
          "INSERT INTO leaderboard_revision VALUES (1, lower(hex(randomblob(16))));",
          "CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET z = 1; END;",
        ].join("\n"),
    });
    expect(result.applied).toEqual(["029.sql"]);
    expect(ddl).toHaveBeenCalledTimes(3);
    const fileDdlSql = ddl.mock.calls
      .slice(1)
      .map((call) => (call[0] as string[]).join("\n"))
      .join("\n");
    expect(fileDdlSql).toContain("CREATE TABLE leaderboard_revision");
    expect(fileDdlSql).toContain("CREATE TRIGGER t");
    expect(fileDdlSql).not.toContain("INSERT INTO leaderboard_revision");
    expect(executed.some((s) => s.startsWith("INSERT INTO leaderboard_revision"))).toBe(true);
    expect(executed.every((s) => !s.startsWith("CREATE"))).toBe(true);
  });

  it("preserves file order across mixed DDL/DML statements", async () => {
    // A later DML may depend on an earlier DDL; routing must not reorder them.
    // One shared log proves the interleaving (DDL batches and DML run() calls
    // recorded as they happen, ledger bookkeeping excluded).
    const order: string[] = [];
    const applied: string[] = [];
    const db: D1Like = {
      prepare(sql: string): D1StatementLike {
        let params: unknown[] = [];
        const stmt: D1StatementLike = {
          sql,
          get params() {
            return params;
          },
          bind: (...next: unknown[]) => {
            params = next;
            return stmt;
          },
          all: async <T,>(): Promise<D1Result<T>> => ({
            success: true,
            results: applied.map((id) => ({ id })) as unknown as T[],
            meta: { changes: 0, duration: 0 },
          }),
          strong: async <T,>(): Promise<D1Result<T>> => ({
            success: true,
            results: applied.map((id) => ({ id })) as unknown as T[],
            meta: { changes: 0, duration: 0 },
          }),
          first: async <T,>(): Promise<T | null> => null,
          run: async (): Promise<D1Result> => {
            if (sql.startsWith("INSERT INTO _migrations")) applied.push(params[0] as string);
            else order.push("DML:" + sql);
            return { success: true, results: [], meta: { changes: 1, duration: 0 } };
          },
        };
        return stmt;
      },
      batch: async () => [],
    };
    const ddl = vi.fn().mockImplementation(async (statements: string[]) => {
      // The ledger DDL runs before any file statement; keep it out of the log.
      if (statements.some((s) => s.includes("_migrations"))) return;
      for (const s of statements) order.push("DDL:" + s);
    });
    await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["m.sql"],
      readFile: async () =>
        "CREATE TABLE a(x);\nINSERT INTO a VALUES (1);\nCREATE INDEX i ON a(x);\nINSERT INTO a VALUES (2);",
    });
    expect(order).toEqual([
      "DDL:CREATE TABLE a(x)",
      "DML:INSERT INTO a VALUES (1)",
      "DDL:CREATE INDEX i ON a(x)",
      "DML:INSERT INTO a VALUES (2)",
    ]);
  });

  it("recovers from a partially-applied file by skipping already-existing DDL", async () => {
    // Simulates a process that died after creating some objects but before
    // recording the file: the DDL batch fails as a whole, then the per-statement
    // retry skips the "already exists" ones and applies the rest.
    const { db, applied } = makeFakeDb();
    const ddl = vi.fn().mockImplementation(async (statements: string[]) => {
      if (statements.some((s) => s.includes("_migrations"))) return;
      if (statements.length > 1) {
        // The atomic batch trips on an object a previous run already created.
        throw new Error("table leaderboard_revision already exists");
      }
      // Per-statement retry: the first object exists, the second is new.
      if (statements[0]?.includes("leaderboard_revision (")) {
        throw new Error("table leaderboard_revision already exists");
      }
    });
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["029.sql"],
      readFile: async () =>
        [
          "CREATE TABLE leaderboard_revision (id INTEGER PRIMARY KEY, revision TEXT NOT NULL);",
          "CREATE TRIGGER trg AFTER INSERT ON x BEGIN UPDATE y SET z = 1; END;",
        ].join("\n"),
    });
    expect(result.applied).toEqual(["029.sql"]);
    expect(applied).toEqual(["029.sql"]);
    // After the batch failure, each statement is retried individually.
    const singleCalls = ddl.mock.calls.filter((c) => (c[0] as string[]).length === 1);
    expect(singleCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("still aborts on a genuine (non-idempotency) DDL error during retry", async () => {
    const { db } = makeFakeDb();
    const ddl = vi.fn().mockImplementation(async (statements: string[]) => {
      if (statements.some((s) => s.includes("_migrations"))) return;
      throw new Error("near \"CREAT\": syntax error");
    });
    await expect(
      applyMigrations({
        db,
        dir: "/migrations",
        ddlExecutor: ddl,
        readDir: async () => ["bad.sql"],
        readFile: async () => "CREATE TABLE a(x);",
      })
    ).rejects.toThrow(/syntax error/);
  });

  it("tolerates a UNIQUE hit on a replayed single-row seed INSERT (crash before ledger)", async () => {
    const { db, applied, executed } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    // Seed INSERT collides on the replayed run (the row exists from the
    // crashed attempt); the ledger write must still happen.
    const seedRun = vi.fn().mockRejectedValueOnce(
      new Error("UNIQUE constraint failed: leaderboard_revision.id"),
    );
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.startsWith("INSERT INTO leaderboard_revision ")) {
        return { ...stmt, run: seedRun };
      }
      return stmt;
    };
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["029.sql"],
      readFile: async () => "INSERT INTO leaderboard_revision VALUES (1, 'r');",
    });
    expect(result.applied).toContain("029.sql");
    expect(applied).toContain("029.sql");
    expect(executed.some((s) => s.startsWith("INSERT INTO _migrations"))).toBe(true);
  });

  it("aborts on a genuine DML failure (UNIQUE hit in an INSERT...SELECT backfill is not tolerated)", async () => {
    const { db, applied } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    const backfillRun = vi.fn().mockRejectedValue(
      new Error("UNIQUE constraint failed: t.id"),
    );
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.startsWith("INSERT INTO t ")) {
        return { ...stmt, run: backfillRun };
      }
      return stmt;
    };
    await expect(
      applyMigrations({
        db,
        dir: "/migrations",
        ddlExecutor: ddl,
        readDir: async () => ["010-backfill.sql"],
        readFile: async () => "INSERT INTO t SELECT * FROM old_t;",
      })
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(applied).not.toContain("010-backfill.sql");
  });
});
