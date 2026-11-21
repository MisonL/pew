import { describe, it, expect, vi, beforeEach } from "vitest";

const listSeasons = vi.fn();
vi.mock("@/lib/db", () => ({
  getDbRead: vi.fn(async () => ({ listSeasons })),
}));

import { GET } from "@/app/api/seasons/route";
import { inMemoryRateLimiter, SEASONS_LIST_RATE_LIMIT } from "@/lib/rate-limit";

describe("GET /api/seasons", () => {
  beforeEach(() => {
    inMemoryRateLimiter.reset();
    listSeasons.mockReset();
    listSeasons.mockResolvedValue([]);
  });

  it("throttles a public caller past the per-IP cap", async () => {
    // Unauthenticated joined read: the cap bounds how fast one client can
    // repeat the scan.
    const request = () => new Request("http://localhost:7020/api/seasons");
    const limit = SEASONS_LIST_RATE_LIMIT.maxRequests;
    for (let i = 0; i < limit; i++) {
      expect((await GET(request())).status).toBe(200);
    }
    const res = await GET(request());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(listSeasons).toHaveBeenCalledTimes(limit);
  });
});
