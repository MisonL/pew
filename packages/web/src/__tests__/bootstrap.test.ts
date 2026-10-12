import { describe, it, expect, vi, beforeEach } from "vitest";
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
    dbWrite.batch.mockResolvedValueOnce([{ success: true }, { success: true }]);

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

  it("refuses when users already exist", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 1 }] });
    await expect(
      bootstrapAdmin({ email: "a@b.c", name: "A", password: "password123" })
    ).rejects.toThrow(/already/i);
    expect(dbWrite.batch).not.toHaveBeenCalled();
  });
});
