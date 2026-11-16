import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createMockDbWrite } from "./test-utils";

vi.mock("@/lib/db", () => ({
  getDbRead: vi.fn(),
  getDbWrite: vi.fn(),
  resetDb: vi.fn(),
}));

const mockQuery = vi.fn();
vi.mock("@/lib/d1", () => ({
  getD1Client: () => ({ query: mockQuery, execute: vi.fn(), batch: vi.fn() }),
  resetD1Client: vi.fn(),
}));

vi.mock("@/auth", () => ({ shouldUseSecureCookies: () => false }));

import { bootstrapAdmin } from "@/lib/credentials";
import { getDbWrite } from "@/lib/db";

const mockGetDbWrite = getDbWrite as unknown as ReturnType<typeof vi.fn>;

describe("bootstrapAdmin", () => {
  let dbWrite: ReturnType<typeof createMockDbWrite>;

  beforeEach(() => {
    mockQuery.mockReset();
    dbWrite = createMockDbWrite();
    mockGetDbWrite.mockResolvedValue(dbWrite);
  });

  it("creates the first user as admin inside one atomic batch", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 0 }] });
    dbWrite.batch.mockResolvedValueOnce([
      { results: [], meta: { changes: 1, duration: 0 } },
      { results: [], meta: { changes: 1, duration: 0 } },
    ]);

    const { userId } = await bootstrapAdmin({
      email: "a@b.c",
      name: "A",
      password: "password123",
    });

    expect(userId).toBeTruthy();
    const stmts = dbWrite.batch.mock.calls[0]![0] as Array<{ sql: string; params?: unknown[] }>;
    const sqlText = stmts.map((s) => s.sql).join("\n");
    expect(sqlText).toMatch(/INSERT INTO users/i);
    expect(sqlText).toMatch(/is_admin/);
    expect(sqlText).toMatch(/instance_setup/i);
    // Deterministic timestamps for multi-node replay.
    expect(sqlText).toMatch(/datetime\('now'\)/);
    // Password is hashed, never stored in the clear.
    const userInsert = stmts.find((s) => /INSERT INTO users/i.test(s.sql))!;
    expect(userInsert.params![3]).toMatch(/^scrypt\$/);
  });

  // The batch is atomic on the self-hosted rqlite adapter, but the hosted D1
  // REST batch is not documented as atomic (lib/d1.ts). Two /setup requests
  // racing there both pass the "users is empty" read; if the loser's `users`
  // insert commits before its `instance_setup` insert collides, the instance
  // ends up with a second admin that no invite ever authorized. The guard has
  // to hold inside the statement, like the invite claim does, rather than
  // relying on the batch rolling back.
  it("cannot create a second admin when the batch is not atomic", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT,
        password_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0, is_public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT, updated_at TEXT);
      CREATE TABLE instance_setup (id INTEGER PRIMARY KEY CHECK (id = 1),
        admin_user_id TEXT NOT NULL, completed_at TEXT NOT NULL);
    `);
    // Both callers read the same (empty) snapshot before either writes.
    mockQuery.mockResolvedValue({ results: [{ n: 0 }] });
    mockQuery.mockImplementation(async () => {
      const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
      return { results: [{ n }] };
    });
    // Non-atomic execution: statements apply one by one and the batch stops at
    // the first failure, leaving earlier statements committed.
    dbWrite.batch.mockImplementation(async (stmts: Array<{ sql: string; params?: unknown[] }>) => {
      const out: unknown[] = [];
      for (const { sql, params } of stmts) {
        sqlite.prepare(sql).run(...(params ?? []) as Array<string | number | null>);
        out.push({ success: true });
      }
      return out;
    });

    let firstFailed = false;
    try {
      const results = await Promise.allSettled([
        bootstrapAdmin({ email: "attacker@evil.test", name: "A", password: "password123" }),
        bootstrapAdmin({ email: "owner@corp.test", name: "O", password: "password456" }),
      ]);
      firstFailed = results.some((r) => r.status === "rejected");

      const admins = sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get() as { n: number };
      const claimed = sqlite.prepare("SELECT admin_user_id FROM instance_setup").all() as Array<{ admin_user_id: string }>;
      expect(admins.n).toBe(1);
      expect(claimed).toHaveLength(1);
      // Whoever landed on instance_setup must be the one admin.
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ? AND is_admin = 1")
        .get(claimed[0]!.admin_user_id)).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
    expect(firstFailed).toBe(true);
  });

  it("refuses when users already exist", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 1 }] });
    await expect(
      bootstrapAdmin({ email: "a@b.c", name: "A", password: "password123" })
    ).rejects.toThrow(/already/i);
    expect(dbWrite.batch).not.toHaveBeenCalled();
  });
});
