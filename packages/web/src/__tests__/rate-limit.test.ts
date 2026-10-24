import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  inMemoryRateLimiter,
  getClientIp,
  type RateLimitConfig,
} from "@/lib/rate-limit";

// The rqlite-backed limiter needs a controllable DB client; every other
// describe block in this file never touches @/lib/d1.
vi.mock("@/lib/d1", () => ({
  getD1Client: vi.fn(),
  resetD1Client: vi.fn(),
}));

// ---------------------------------------------------------------------------
// InMemoryRateLimiter
// ---------------------------------------------------------------------------

describe("inMemoryRateLimiter", () => {
  const config: RateLimitConfig = { maxRequests: 2, windowSeconds: 60 };

  beforeEach(() => {
    inMemoryRateLimiter.reset();
  });

  it("allows requests under limit", () => {
    const r1 = inMemoryRateLimiter.check("k1", config);
    expect(r1.allowed).toBe(true);
    expect(r1.current).toBe(1);
  });

  it("denies requests at limit and returns retryAfter > 0", () => {
    inMemoryRateLimiter.check("k1", config);
    inMemoryRateLimiter.check("k1", config);
    const r3 = inMemoryRateLimiter.check("k1", config);
    expect(r3.allowed).toBe(false);
    expect(r3.current).toBe(2);
    expect(r3.retryAfter).toBeGreaterThan(0);
  });

  it("prunes expired timestamps and allows again", () => {
    vi.useFakeTimers();
    inMemoryRateLimiter.check("k1", config);
    inMemoryRateLimiter.check("k1", config);

    vi.advanceTimersByTime(61_000);

    const r = inMemoryRateLimiter.check("k1", config);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(1);
    vi.useRealTimers();
  });

  it("tracks different keys independently", () => {
    inMemoryRateLimiter.check("k1", config);
    inMemoryRateLimiter.check("k1", config);
    const r = inMemoryRateLimiter.check("k2", config);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(1);
  });

  it("global sweep prunes stale keys without affecting active ones", () => {
    vi.useFakeTimers();
    try {
      // Seed many one-shot keys (simulate transient IPs)
      for (let i = 0; i < 50; i++) {
        inMemoryRateLimiter.check(`stale-${i}`, config);
      }
      expect(inMemoryRateLimiter.size()).toBe(50);

      // Advance past the window so all seeded entries are stale
      vi.advanceTimersByTime(61_000);

      // An active key gets a fresh hit
      inMemoryRateLimiter.check("active", config);

      // Sweep is throttled to once per minute; advance another minute and
      // touch any key to trigger it
      vi.advanceTimersByTime(61_000);
      const r = inMemoryRateLimiter.check("active", config);

      // Active key still tracked; stale keys gone (active may have 1 or 2
      // depending on whether its first hit fell out of the window)
      expect(r.allowed).toBe(true);
      expect(inMemoryRateLimiter.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryAfter remains correct after sweep activity", () => {
    vi.useFakeTimers();
    try {
      // Seed a stale key so a future sweep has work to do
      inMemoryRateLimiter.check("stale", config);
      vi.advanceTimersByTime(61_000);

      // Fill an active key to its limit
      inMemoryRateLimiter.check("k1", config);
      inMemoryRateLimiter.check("k1", config);
      const denied = inMemoryRateLimiter.check("k1", config);

      expect(denied.allowed).toBe(false);
      expect(denied.current).toBe(2);
      expect(denied.limit).toBe(2);
      expect(denied.retryAfter).toBeGreaterThan(0);
      expect(denied.retryAfter).toBeLessThanOrEqual(60);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a key entirely when its only timestamp expires and request is denied path is unaffected", () => {
    vi.useFakeTimers();
    try {
      inMemoryRateLimiter.check("solo", config);
      expect(inMemoryRateLimiter.size()).toBe(1);

      vi.advanceTimersByTime(61_000);

      // Re-check the same key after expiry — it should behave as fresh and
      // remain a single tracked entry, not accumulate dead arrays
      const r = inMemoryRateLimiter.check("solo", config);
      expect(r.allowed).toBe(true);
      expect(r.current).toBe(1);
      expect(inMemoryRateLimiter.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// getClientIp
// ---------------------------------------------------------------------------

describe("getClientIp", () => {
  it("returns LAST IP from x-forwarded-for (the entry our own proxy appended; earlier entries are client-controlled)", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(getClientIp(req)).toBe("5.6.7.8");
  });

  it("falls through when x-forwarded-for is present but has only empty entries", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": " ,  ", "x-real-ip": "9.9.9.9" },
    });
    expect(getClientIp(req)).toBe("9.9.9.9");
  });

  it("returns x-real-ip when no x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": " 10.0.0.1 " },
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("returns cf-connecting-ip as last resort", () => {
    const req = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "172.16.0.1" },
    });
    expect(getClientIp(req)).toBe("172.16.0.1");
  });

  it("returns 'unknown' when no proxy headers present", () => {
    const req = new Request("http://localhost");
    expect(getClientIp(req)).toBe("unknown");
  });
});

describe("rqliteRateLimiter", () => {
  // The real class against a mocked d1 client: the fallback behavior cannot
  // be seen through the auth.ts mocks, and it is where quota leaks hide.
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    inMemoryRateLimiter.reset();
    const d1 = await import("@/lib/d1");
    mockQuery = vi.fn();
    vi.mocked(d1.getD1Client).mockReturnValue({ query: mockQuery, execute: vi.fn(), batch: vi.fn() } as never);
  });

  const CFG = { maxRequests: 3, windowSeconds: 60 };

  it("mirrors accepted DB attempts into the in-memory fallback bucket", async () => {
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    // Two DB-healthy allows.
    mockQuery.mockResolvedValue({ meta: { changes: 1 } });
    expect((await rqliteRateLimiter.check("login:ip:1.2.3.4", CFG)).allowed).toBe(true);
    expect((await rqliteRateLimiter.check("login:ip:1.2.3.4", CFG)).allowed).toBe(true);

    // Now the DB dies. The memory fallback must already carry the two mirrored
    // attempts: only ONE more is allowed, then the bucket is at max.
    mockQuery.mockRejectedValue(new Error("leader election"));
    expect((await rqliteRateLimiter.check("login:ip:1.2.3.4", CFG)).allowed).toBe(true);
    expect((await rqliteRateLimiter.check("login:ip:1.2.3.4", CFG)).allowed).toBe(false);

    // The pre-fix behavior was a fresh bucket at degradation time, granting a
    // whole extra maxRequests allowance exactly when guessing is cheapest.
    mockQuery.mockResolvedValue({ meta: { changes: 1 } });
    expect((await rqliteRateLimiter.check("login:ip:9.9.9.9", CFG)).allowed).toBe(true);
    expect(inMemoryRateLimiter.size()).toBe(2);
  });

  it("an over-limit DB decision does not consume a memory slot", async () => {
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    mockQuery.mockResolvedValue({ meta: { changes: 0 } });
    const denied = await rqliteRateLimiter.check("login:email:a@b.c", CFG);
    expect(denied.allowed).toBe(false);
    expect(inMemoryRateLimiter.size()).toBe(0);
  });

  it("falls back to memory when the first attempt already finds the DB down", async () => {
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    mockQuery.mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < CFG.maxRequests; i++) {
        expect((await rqliteRateLimiter.check("login:ip:5.6.7.8", CFG)).allowed).toBe(true);
      }
      expect((await rqliteRateLimiter.check("login:ip:5.6.7.8", CFG)).allowed).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("degraded"));
    } finally {
      warn.mockRestore();
    }
  });
});
