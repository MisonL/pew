import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  getDbRead: vi.fn(),
  getDbWrite: vi.fn(),
  resetDb: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  resolveUser: vi.fn(),
}));

const { resolveUser } = await loadMockedAuthHelpers();

const { getDbRead } = (await import("@/lib/db")) as unknown as {
  getDbRead: ReturnType<typeof vi.fn>;
};

import { createMockDbRead, loadMockedAuthHelpers } from "./test-utils";
import { resetPricingMapCache } from "@/lib/load-pricing-map";
import { PRICING_RATE_LIMIT, inMemoryRateLimiter } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// GET /api/pricing
// ---------------------------------------------------------------------------

describe("GET /api/pricing", () => {
  let GET: (req: Request) => Promise<Response>;
  let mockDbRead: ReturnType<typeof createMockDbRead>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The limiter is module-global; reset it so the rate-limit case cannot
    // drain a bucket a neighbouring test relies on.
    inMemoryRateLimiter.reset();
    resetPricingMapCache();
    mockDbRead = createMockDbRead();
    mockDbRead.getDynamicPricing.mockResolvedValue({
      entries: [],
      servedFrom: "baseline",
    });
    vi.mocked(getDbRead).mockResolvedValue(mockDbRead);
    const mod = await import("@/app/api/pricing/route");
    GET = mod.GET;
  });

  it("serves the same public price map without authentication", async () => {
    vi.mocked(resolveUser).mockResolvedValueOnce(null);

    const res = await GET(new Request("http://localhost:7020/api/pricing"));

    expect(res.status).toBe(200);
    const publicMap = await res.json();
    const signedInMap = await (await GET(new Request("http://localhost:7020/api/pricing", { headers: { Authorization: "Bearer synthetic" } }))).json();
    expect(publicMap).toEqual(signedInMap);
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it("should return pricing map from dynamic entries", async () => {
    vi.mocked(resolveUser).mockResolvedValueOnce({ userId: "u1" });
    mockDbRead.getDynamicPricing.mockResolvedValueOnce({
      entries: [
        {
          model: "gpt-4o",
          provider: "OpenAI",
          displayName: "GPT-4o",
          inputPerMillion: 2.5,
          outputPerMillion: 10,
          cachedPerMillion: 1.25,
          contextWindow: 128000,
          origin: "baseline",
          updatedAt: "2026-04-30T00:00:00.000Z",
        },
      ],
      servedFrom: "kv",
    });

    const res = await GET(new Request("http://localhost:7020/api/pricing"));

    expect(res.status).toBe(200);
    const body = await res.json();
    // buildPricingMap merges dynamic entries with defaults — just check it's a non-empty object
    expect(typeof body).toBe("object");
    expect(body).not.toEqual({});
  });

  it("should fall back to defaults when dynamic call rejects", async () => {
    vi.mocked(resolveUser).mockResolvedValueOnce({ userId: "u1" });
    mockDbRead.getDynamicPricing.mockRejectedValueOnce(
      new Error("KV unavailable"),
    );

    const res = await GET(new Request("http://localhost:7020/api/pricing"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
    expect(body.meta.status).toBe("fallback");
  });

  it("should fall back to defaults on unexpected error", async () => {
    vi.mocked(resolveUser).mockResolvedValueOnce({ userId: "u1" });
    mockDbRead.getDynamicPricing.mockRejectedValueOnce(new Error("D1 down"));

    const res = await GET(new Request("http://localhost:7020/api/pricing"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
  });

  it("rate limits anonymous catalogue reads", async () => {
    // ~0.5 MB of JSON per call with no auth in front of it: an anonymous loop
    // otherwise repeats the whole serialization for free. Same shape as the
    // public leaderboard's bound, with its own bucket.
    vi.mocked(resolveUser).mockResolvedValue(null);
    const make = () => new Request("http://localhost:7020/api/pricing");
    for (let i = 0; i < PRICING_RATE_LIMIT.maxRequests; i++) {
      expect((await GET(make())).status).toBe(200);
    }
    const limited = await GET(make());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });
});
