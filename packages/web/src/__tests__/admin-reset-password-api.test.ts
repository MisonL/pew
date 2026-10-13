import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockDbWrite } from "./test-utils";

vi.mock("@/lib/db", () => ({
  getDbRead: vi.fn(),
  getDbWrite: vi.fn(),
  resetDb: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  resolveUser: vi.fn(),
  E2E_TEST_USER_ID: "e2e-test-user-id",
  E2E_TEST_USER_EMAIL: "e2e@test.local",
}));

const mockAdminQuery = vi.fn();
vi.mock("@/lib/d1", () => ({
  getD1Client: () => ({ query: mockAdminQuery, execute: vi.fn(), batch: vi.fn() }),
  resetD1Client: vi.fn(),
}));

// lib/credentials.ts pulls in lib/invite.ts → @/auth → next-auth; stub it so
// vitest never resolves the next-auth "next/server" subpath.
vi.mock("@/auth", () => ({ shouldUseSecureCookies: () => false }));

import { POST } from "@/app/api/admin/users/[userId]/reset-password/route";
import { getDbWrite } from "@/lib/db";
import { resolveUser } from "@/lib/auth-helpers";

const mockGetDbWrite = getDbWrite as unknown as ReturnType<typeof vi.fn>;
const mockResolveUser = resolveUser as unknown as ReturnType<typeof vi.fn>;

function post(userId: string): Promise<Response> {
  return POST(new Request("http://localhost/api/admin/users/x/reset-password", { method: "POST" }), {
    params: Promise.resolve({ userId }),
  });
}

describe("POST /api/admin/users/[userId]/reset-password", () => {
  let dbWrite: ReturnType<typeof createMockDbWrite>;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    mockAdminQuery.mockReset();
    mockResolveUser.mockReset();
    dbWrite = createMockDbWrite();
    mockGetDbWrite.mockResolvedValue(dbWrite);
    // Real resolveAdmin runs: allowlist first, then is_admin in the database.
    process.env = { ...ORIGINAL_ENV, ADMIN_EMAILS: "admin@example.com" };
    delete process.env.RAILWAY_ENVIRONMENT;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("forbids a non-admin caller", async () => {
    mockResolveUser.mockResolvedValueOnce({ userId: "u9", email: "user@example.com" });
    mockAdminQuery.mockResolvedValueOnce({ results: [{ is_admin: 0 }] });

    const res = await post("target");
    expect(res.status).toBe(403);
    expect(dbWrite.batch).not.toHaveBeenCalled();
  });

  it("requires a userId param", async () => {
    mockResolveUser.mockResolvedValueOnce({ userId: "u1", email: "admin@example.com" });

    const res = await post("");
    expect(res.status).toBe(400);
  });

  it("issues a single-use token for an admin", async () => {
    mockResolveUser.mockResolvedValueOnce({ userId: "u1", email: "admin@example.com" });
    dbWrite.batch.mockResolvedValueOnce([{ success: true }, { success: true }]);

    const res = await post("target-user");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresInMinutes: number };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.expiresInMinutes).toBe(60);
    expect(mockAdminQuery).not.toHaveBeenCalled(); // allowlist short-circuit
  });

  it("recognizes an in-database admin without an allowlist entry", async () => {
    mockResolveUser.mockResolvedValueOnce({ userId: "u1", email: "first@example.com" });
    mockAdminQuery.mockResolvedValueOnce({ results: [{ is_admin: 1 }] });
    dbWrite.batch.mockResolvedValueOnce([{ success: true }, { success: true }]);

    const res = await post("target-user");
    expect(res.status).toBe(200);
    expect(mockAdminQuery).toHaveBeenCalled();
  });

  it("maps a storage failure to 500", async () => {
    mockResolveUser.mockResolvedValueOnce({ userId: "u1", email: "admin@example.com" });
    dbWrite.batch.mockRejectedValueOnce(new Error("disk full"));

    const res = await post("target-user");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed/i);
  });
});
