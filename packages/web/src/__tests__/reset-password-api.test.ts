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

import { POST } from "@/app/api/auth/reset-password/route";
import { getDbWrite } from "@/lib/db";

const mockGetDbWrite = getDbWrite as unknown as ReturnType<typeof vi.fn>;

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

describe("POST /api/auth/reset-password", () => {
  let dbWrite: ReturnType<typeof createMockDbWrite>;

  beforeEach(() => {
    mockQuery.mockReset();
    dbWrite = createMockDbWrite();
    mockGetDbWrite.mockResolvedValue(dbWrite);
  });

  it("rejects invalid JSON", async () => {
    const res = await post("{oops");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/json/i);
  });

  it("rejects a missing token", async () => {
    const res = await post({ password: "newpassword" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/token/i);
  });

  it("coerces non-string fields instead of crashing", async () => {
    const res = await post({ token: 123, password: 456 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/token/i);
  });

  it("rejects a short password", async () => {
    const res = await post({ token: "t", password: "short" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/8 characters/);
  });

  it("rejects an unknown/expired token with 400", async () => {
    mockQuery.mockResolvedValueOnce({ results: [] });
    const res = await post({ token: "stale-token", password: "newpassword" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid or expired/i);
  });

  it("consumes a valid token and returns ok", async () => {
    mockQuery.mockResolvedValueOnce({
      results: [{ user_id: "u1", expires_at: new Date(Date.now() + 60_000).toISOString() }],
    });
    dbWrite.batch.mockResolvedValueOnce([{ success: true }, { success: true }]);

    const res = await post({ token: "good-token", password: "newpassword" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stmts = dbWrite.batch.mock.calls[0]![0] as Array<{ sql: string }>;
    expect(stmts[0]!.sql).toMatch(/UPDATE password_resets SET used_at/);
    expect(stmts[1]!.sql).toMatch(/password_hash/);
  });

  it("maps a storage failure to 500", async () => {
    mockQuery.mockResolvedValueOnce({
      results: [{ user_id: "u1", expires_at: new Date(Date.now() + 60_000).toISOString() }],
    });
    dbWrite.batch.mockRejectedValueOnce(new Error("disk full"));

    const res = await post({ token: "good-token", password: "newpassword" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed/i);
  });
});
