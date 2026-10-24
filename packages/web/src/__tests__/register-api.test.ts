import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDbRead, createMockDbWrite } from "./test-utils";

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

import { POST } from "@/app/api/auth/register/route";
import { getDbRead, getDbWrite } from "@/lib/db";
import { inMemoryRateLimiter } from "@/lib/rate-limit";

const mockGetDbWrite = getDbWrite as unknown as ReturnType<typeof vi.fn>;
const mockGetDbRead = getDbRead as unknown as ReturnType<typeof vi.fn>;

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

describe("POST /api/auth/register", () => {
  let dbWrite: ReturnType<typeof createMockDbWrite>;
  let dbRead: ReturnType<typeof createMockDbRead>;

  beforeEach(() => {
    inMemoryRateLimiter.reset();
    mockQuery.mockReset();
    dbWrite = createMockDbWrite();
    dbRead = createMockDbRead();
    mockGetDbWrite.mockResolvedValue(dbWrite);
    mockGetDbRead.mockResolvedValue(dbRead);
    dbRead.getAppSetting.mockResolvedValue("true");
  });

  it("rejects invalid JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/json/i);
  });

  it("rejects a malformed email", async () => {
    const res = await post({ email: "not-an-email", password: "password123" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);
  });

  it("coerces non-string fields instead of crashing", async () => {
    const res = await post({ email: 123, name: null, password: 456, inviteCode: 789 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);
  });

  it("rejects a short password", async () => {
    const res = await post({ email: "a@b.c", password: "short" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/8 characters/);
  });

  it("bootstraps the first admin when the instance is empty", async () => {
    // Both the route's mode check and bootstrapAdmin's own guard count users.
    mockQuery.mockResolvedValue({ results: [{ n: 0 }] });
    dbWrite.batch.mockResolvedValueOnce([{ success: true }, { success: true }]);

    const res = await post({ email: "a@b.c", name: "A", password: "password123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, admin: true });
    expect(dbWrite.batch).toHaveBeenCalled();
  });

  it("registers via invite when users already exist", async () => {
    mockQuery.mockResolvedValue({ results: [{ n: 1 }] }); // instance has users
    dbWrite.execute
      .mockResolvedValueOnce({ changes: 1, duration: 0 }) // consume invite
      .mockResolvedValueOnce({ changes: 1, duration: 0 }); // insert user

    const res = await post({ email: "n@x.y", name: "N", password: "password123", inviteCode: "ABCD2345" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, admin: false });
  });

  it("maps an invite rejection to 400", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 1 }] });
    dbWrite.execute.mockResolvedValueOnce({ changes: 0, duration: 0 }); // code invalid

    const res = await post({ email: "n@x.y", password: "password123", inviteCode: "ABCD2345" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invite/i);
  });

  it("maps an unexpected failure to 500 without echoing internals", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 0 }] });
    dbWrite.batch.mockRejectedValueOnce(new Error("disk I/O error"));

    const res = await post({ email: "a@b.c", password: "password123" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Registration failed");
  });

  it("maps a concurrent-setup UNIQUE collision to 400 already set up", async () => {
    // Both requests passed the "users is empty" pre-check; this one lost the
    // race and hit the users.email UNIQUE index (or instance_setup's PK)
    // inside the batch. It must read as "already set up" (400), not a 500.
    mockQuery.mockResolvedValue({ results: [{ n: 0 }] });
    dbWrite.batch.mockRejectedValueOnce(new Error("UNIQUE constraint failed: users.email"));

    const res = await post({ email: "a@b.c", password: "password123" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already set up/i);
  });

  it("does not relabel an invite-path UNIQUE failure as already set up", async () => {
    // On the invite path a UNIQUE failure is a duplicate email, not a setup
    // race; the bootstrap-only mapping must not leak into it.
    mockQuery.mockResolvedValueOnce({ results: [{ n: 1 }] });
    dbWrite.execute
      .mockResolvedValueOnce({ changes: 1, duration: 0 }) // consume invite
      .mockRejectedValueOnce(new Error("UNIQUE constraint failed: users.email")) // insert user
      .mockResolvedValueOnce({ changes: 1, duration: 0 }); // release invite (best-effort)

    const res = await post({ email: "n@x.y", password: "password123", inviteCode: "ABCD2345" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Registration failed");
  });
});
