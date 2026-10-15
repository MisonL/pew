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

import {
  hashPassword,
  verifyPassword,
  verifyPasswordDummy,
  createPasswordReset,
  consumePasswordReset,
  passwordVersion,
  RESET_TOKEN_TTL_MINUTES,
} from "../lib/credentials";
import { getDbWrite } from "@/lib/db";

const mockGetDbWrite = getDbWrite as unknown as ReturnType<typeof vi.fn>;

describe("password hashing (scrypt)", () => {
  it("round-trips a password", async () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = hashPassword("right");
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("uses a fresh salt each time", () => {
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
  });

  it("returns false for a malformed stored value without throwing", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$bad", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });

  it("returns false when a hash component is empty", async () => {
    // Six segments but a blank salt — the destructure guard must catch it.
    expect(await verifyPassword("x", "scrypt$32768$8$1$$AAAA")).toBe(false);
    expect(await verifyPassword("x", "scrypt$32768$8$1$AAAA$")).toBe(false);
  });

  it("works with the production scrypt params (maxmem set, no throw)", async () => {
    // A missing maxmem makes scryptSync throw "Invalid scrypt params" here.
    const stored = hashPassword("p@ssw0rd");
    expect(await verifyPassword("p@ssw0rd", stored)).toBe(true);
  });

  it("verifyPasswordDummy resolves without throwing", async () => {
    await expect(verifyPasswordDummy("anything")).resolves.toBeUndefined();
  });
});

describe("password reset", () => {
  let dbWrite: ReturnType<typeof createMockDbWrite>;

  beforeEach(() => {
    mockQuery.mockReset();
    dbWrite = createMockDbWrite();
    mockGetDbWrite.mockResolvedValue(dbWrite);
  });

  it("createPasswordReset returns an opaque token and stores it with an expiry", async () => {
    dbWrite.batch.mockResolvedValueOnce([{ success: true, meta: { changes: 1, duration: 1 } }, { success: true, meta: { changes: 1, duration: 1 } }]);
    const token = await createPasswordReset("u1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const stmts = dbWrite.batch.mock.calls[0]![0] as Array<{ sql: string; params?: unknown[] }>;
    // Old unused tokens are dropped first, then the new one is inserted.
    expect(stmts[0]!.sql).toMatch(/DELETE FROM password_resets/);
    expect(stmts[1]!.sql).toMatch(/INSERT INTO password_resets/);
    expect(stmts[1]!.params![1]).toBe("u1");
    expect(stmts[1]!.params![2]).toBe(`+${RESET_TOKEN_TTL_MINUTES} minutes`);
    // The stored token is the returned one.
    expect(stmts[1]!.params![0]).toBe(token);
  });

  it("consumePasswordReset rejects an unknown or used token", async () => {
    mockQuery.mockResolvedValueOnce({ results: [] });
    expect(await consumePasswordReset("nope", "newpassword")).toBeNull();
  });

  it("consumePasswordReset rejects an expired token", async () => {
    // Expiry is compared SQL-side (expires_at > datetime('now')); a token
    // past its window is filtered out of the WHERE and returns no row.
    mockQuery.mockResolvedValueOnce({ results: [] });
    expect(await consumePasswordReset("t", "newpassword")).toBeNull();
    expect(dbWrite.batch).not.toHaveBeenCalled();
    const call = mockQuery.mock.calls[0];
    expect(String(call?.[0])).toContain("expires_at > datetime('now')");
  });

  it("consumePasswordReset sets the new hash and marks the token used", async () => {
    mockQuery.mockResolvedValueOnce({
      results: [{ user_id: "u1", expires_at: new Date(Date.now() + 60_000).toISOString() }],
    });
    dbWrite.batch.mockResolvedValueOnce([{ success: true, meta: { changes: 1, duration: 1 } }, { success: true, meta: { changes: 1, duration: 1 } }]);

    const result = await consumePasswordReset("tok", "newpassword");
    expect(result).toEqual({ userId: "u1" });

    const stmts = dbWrite.batch.mock.calls[0]![0] as Array<{ sql: string; params?: unknown[] }>;
    // The token is claimed first (atomic guard), then the password is set.
    expect(stmts[0]!.sql).toMatch(/UPDATE password_resets SET used_at = \? WHERE token = \? AND used_at IS NULL/);
    // The password write is gated on used_at = THE TIMESTAMP THIS TRANSACTION
    // WROTE (params[3] === params of the claim): an EXISTS on "IS NOT NULL"
    // would also pass for a concurrent loser that saw the winner's claim.
    expect(stmts[1]!.sql).toMatch(/used_at = \?\s*\)/);
    expect(stmts[1]!.params![3]).toBe(stmts[0]!.params![0]);
    expect(stmts[1]!.sql).toMatch(/UPDATE users SET password_hash/);
    expect(stmts[1]!.params![0]).toMatch(/^scrypt\$/);
  });

  it("consumePasswordReset returns null when a concurrent request won the claim", async () => {
    mockQuery.mockResolvedValueOnce({
      results: [{ user_id: "u1", expires_at: new Date(Date.now() + 60_000).toISOString() }],
    });
    // Lost the race: the claim UPDATE matched 0 rows, so the gated password
    // write must not be treated as success.
    dbWrite.batch.mockResolvedValueOnce([
      { success: true, meta: { changes: 0, duration: 1 } },
      { success: true, meta: { changes: 0, duration: 1 } },
    ]);
    expect(await consumePasswordReset("tok", "newpassword")).toBeNull();
  });
});

describe("passwordVersion", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns the last 8 chars of the hash", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ password_hash: "scrypt$32768$8$1$AAAA$BBBBCCCC" }] });
    expect(await passwordVersion("u1")).toBe("BBBBCCCC");
  });

  it("returns empty string for a password-less (OAuth) user", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ password_hash: null }] });
    expect(await passwordVersion("u1")).toBe("");
  });
});
