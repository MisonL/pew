import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("@/lib/d1", () => ({
  getD1Client: () => ({ query: mockQuery, execute: vi.fn(), batch: vi.fn() }),
  resetD1Client: vi.fn(),
}));

import { GET } from "@/app/api/auth/login-options/route";

describe("GET /api/auth/login-options", () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.clearAllMocks();
  });
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockQuery.mockReset();
  });

  it("reports setupNeeded=true on an empty instance", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 0 }] });
    const res = await GET();
    expect(await res.json()).toMatchObject({ setupNeeded: true });
  });

  it("reports setupNeeded=false once a user exists", async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 1 }] });
    const res = await GET();
    expect(await res.json()).toMatchObject({ setupNeeded: false });
  });

  it("treats an empty result set as instance-empty", async () => {
    // results:[] → results[0]?.n ?? 0 → 0 → setupNeeded: true
    mockQuery.mockResolvedValueOnce({ results: [] });
    const res = await GET();
    expect(await res.json()).toMatchObject({ setupNeeded: true });
  });

  it("reflects googleEnabled from the OAuth env vars", async () => {
    mockQuery.mockResolvedValue({ results: [{ n: 1 }] });
    process.env = { ...process.env, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" };
    expect(await (await GET()).json()).toMatchObject({ googleEnabled: true });

    process.env = { ...process.env, AUTH_GOOGLE_ID: "", AUTH_GOOGLE_SECRET: "" };
    expect(await (await GET()).json()).toMatchObject({ googleEnabled: false });
  });

  it("defaults to setupNeeded=false when the query fails (no bootstrap advert)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("no such table: users"));
    const res = await GET();
    expect(await res.json()).toMatchObject({ setupNeeded: false });
  });

  it("is never cached: the answer flips as soon as the instance is set up", async () => {
    // This response tells an anonymous visitor whether /setup is still open.
    // A cached copy would keep advertising (or hiding) the wizard after the
    // first admin exists.
    mockQuery.mockResolvedValueOnce({ results: [{ n: 0 }] });
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
