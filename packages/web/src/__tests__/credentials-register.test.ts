import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDbRead, createMockDbWrite } from "./test-utils";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

// lib/credentials.ts imports lib/invite.ts (validateInviteCode), which imports
// next-auth transitively via @/auth; stub it so vitest never resolves the
// next-auth "next/server" subpath (unresolvable under the bundler here).
vi.mock("@/auth", () => ({
  shouldUseSecureCookies: () => false,
}));

import { findCredentialUser, registerWithInvite, setScryptSlotForced } from "@/lib/credentials";
import { getDbRead, getDbWrite } from "@/lib/db";

const mockGetDbWrite = getDbWrite as unknown as ReturnType<typeof vi.fn>;
const mockGetDbRead = getDbRead as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findCredentialUser", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns the row including password_hash", async () => {
    mockQuery.mockResolvedValueOnce({
      results: [
        {
          id: "u1",
          email: "a@b.c",
          password_hash: "scrypt$32768$8$1$AA$BB",
          name: "A",
          is_public: 1,
          is_admin: 0,
        },
      ],
    });
    const user = await findCredentialUser("a@b.c");
    expect(user).toMatchObject({ id: "u1", email: "a@b.c", is_admin: 0 });
    expect(user?.password_hash).toBe("scrypt$32768$8$1$AA$BB");
    // Query is parameterized, not string-interpolated.
    expect(mockQuery.mock.calls[0]![0]).toMatch(/FROM users WHERE email = \?/);
    expect(mockQuery.mock.calls[0]![1]).toEqual(["a@b.c"]);
  });

  it("returns null when no user matches", async () => {
    mockQuery.mockResolvedValueOnce({ results: [] });
    expect(await findCredentialUser("nobody@x.y")).toBeNull();
  });
});

describe("registerWithInvite", () => {
  let dbWrite: ReturnType<typeof createMockDbWrite>;
  let dbRead: ReturnType<typeof createMockDbRead>;

  beforeEach(() => {
    dbWrite = createMockDbWrite();
    dbRead = createMockDbRead();
    mockGetDbWrite.mockResolvedValue(dbWrite);
    mockGetDbRead.mockResolvedValue(dbRead);
    // Default: invitations required (the upstream default is "true").
    dbRead.getAppSetting.mockResolvedValue("true");
  });

  it("rejects a reserved admin email before touching the database", async () => {
    // registerWithInvite does not verify email ownership (OAuth does), so an
    // invite holder could register an ADMIN_EMAILS address ahead of the real
    // owner's first login and inherit admin. The guard is env-only and
    // synchronous; restore the real value afterwards.
    const before = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "admin@corp.example";
    try {
      await expect(
        registerWithInvite({
          email: "ADMIN@corp.example",
          name: "A",
          password: "password123",
          inviteCode: "ABCD2345",
        })
      ).rejects.toThrow(/reserved/i);
      expect(dbWrite.execute).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = before;
    }
  });

  it("rejects a malformed invite code before touching the database", async () => {
    await expect(
      registerWithInvite({ email: "n@x.y", name: "N", password: "password123", inviteCode: "bad!" })
    ).rejects.toThrow(/invite/i);
    expect(dbWrite.execute).not.toHaveBeenCalled();
  });

  it("registers without an invite code when the admin disabled invitations", async () => {
    // The admin toggle must govern this path too: the OAuth gate already
    // honours it, and the UI promises "anyone can register" once it is off.
    dbRead.getAppSetting.mockResolvedValue("false");
    dbWrite.execute.mockResolvedValueOnce({ changes: 1, duration: 0 });

    const { userId } = await registerWithInvite({
      email: "open@x.y",
      name: "Open",
      password: "password123",
      inviteCode: "",
    });

    expect(userId).toBeTruthy();
    expect(dbWrite.execute).toHaveBeenCalledTimes(1);
    const [sql] = dbWrite.execute.mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO users/);
    // No invite row was touched.
    expect(sql).not.toMatch(/invite_codes/);
  });

  it("still rejects a malformed code when invitations are required", async () => {
    await expect(
      registerWithInvite({ email: "n@x.y", name: "N", password: "password123", inviteCode: "" })
    ).rejects.toThrow(/invite/i);
    expect(dbWrite.execute).not.toHaveBeenCalled();
  });

  it("rejects when the invite is invalid or already used (changes === 0)", async () => {
    dbWrite.execute.mockResolvedValueOnce({ changes: 0, duration: 0 });
    await expect(
      registerWithInvite({ email: "n@x.y", name: "N", password: "password123", inviteCode: "ABCD2345" })
    ).rejects.toThrow(/invalid or already used/i);
    // Only the consume attempt ran; no user INSERT.
    expect(dbWrite.execute).toHaveBeenCalledTimes(1);
  });

  it("consumes the invite then inserts the user with a hashed password", async () => {
    dbWrite.execute
      .mockResolvedValueOnce({ changes: 1, duration: 0 }) // consume
      .mockResolvedValueOnce({ changes: 1, duration: 0 }); // insert

    const { userId } = await registerWithInvite({
      email: "new@x.y",
      name: "New",
      password: "password123",
      inviteCode: "ABCD2345",
    });

    expect(userId).toBeTruthy();
    const [consumeSql, consumeParams] = dbWrite.execute.mock.calls[0]!;
    expect(consumeSql).toMatch(/UPDATE invite_codes/);
    expect(consumeSql).toMatch(/WHERE code = \? AND used_by IS NULL/);
    expect(consumeParams![1]).toBe("ABCD2345");

    const [insertSql, insertParams] = dbWrite.execute.mock.calls[1]!;
    expect(insertSql).toMatch(/INSERT INTO users/);
    // Deterministic timestamp (multi-node replay), and a hashed — not plaintext — password.
    expect(insertSql).toMatch(/datetime\('now'\)/);
    expect(insertParams).toContain("new@x.y");
    const stored = insertParams![3] as string;
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain("password123");
  });

  it("releases the invite if the user INSERT fails", async () => {
    dbWrite.execute
      .mockResolvedValueOnce({ changes: 1, duration: 0 }) // consume
      .mockRejectedValueOnce(new Error("UNIQUE constraint failed: users.email")) // insert
      .mockResolvedValueOnce({ changes: 1, duration: 0 }); // release

    await expect(
      registerWithInvite({ email: "dup@x.y", name: "D", password: "password123", inviteCode: "ABCD2345" })
    ).rejects.toThrow(/UNIQUE/);

    const releaseSql = dbWrite.execute.mock.calls[2]![0] as string;
    expect(releaseSql).toMatch(/UPDATE invite_codes SET used_by = NULL/);
  });
  it("refuses without touching the database when the derivation slot is exhausted", async () => {
    dbRead.getAppSetting.mockResolvedValue("false");
    setScryptSlotForced(true);
    try {
      await expect(
        registerWithInvite({ email: "open@x.y", name: "O", password: "password123", inviteCode: "" })
      ).rejects.toThrow(/Too many concurrent requests/i);
      // The guard sits above the invite consume and the INSERT, so nothing is
      // touched — an exhausted slot must not burn a code.
      expect(dbWrite.execute).not.toHaveBeenCalled();
    } finally {
      setScryptSlotForced(false);
    }
  });

});
