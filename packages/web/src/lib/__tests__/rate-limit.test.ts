import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RateLimitConfig } from "../rate-limit";

/**
 * Task 8 brief uses LOGIN_RATE_LIMIT, which lives in `@/auth` (importing that
 * module executes NextAuth(), so it cannot be imported here). This local
 * constant mirrors `LOGIN_RATE_LIMIT` in packages/web/src/auth.ts exactly.
 */
const LOGIN_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowSeconds: 60,
};

describe("RqliteRateLimiter", () => {
  const mockQuery = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../d1", () => ({
      getD1Client: () => ({ query: mockQuery, execute: vi.fn(), batch: vi.fn() }),
      resetD1Client: vi.fn(),
    }));
    mockQuery.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // never cleanup
  });
  afterEach(() => vi.restoreAllMocks());

  it("allows when the atomic INSERT reports changes=1", async () => {
    mockQuery.mockResolvedValueOnce({ results: [], meta: { changes: 1 } });
    const { rqliteRateLimiter } = await import("../rate-limit");
    const r = await rqliteRateLimiter.check("login:ip:1.2.3.4", LOGIN_RATE_LIMIT);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(1);
    expect(mockQuery.mock.calls[0]?.[0]).toMatch(/INSERT INTO rate_limit_hits/);
    // window math is SQL-side: the negative offset is a bound parameter
    expect(mockQuery.mock.calls[0]?.[1]).toContain("-60 seconds");
  });

  it("rejects with current === limit when changes=0 (over-limit, NOT failure)", async () => {
    mockQuery.mockResolvedValueOnce({ results: [], meta: { changes: 0 } });
    const { rqliteRateLimiter } = await import("../rate-limit");
    const r = await rqliteRateLimiter.check("login:ip:1.2.3.4", LOGIN_RATE_LIMIT);
    expect(r.allowed).toBe(false);
    expect(r.current).toBe(r.limit);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("falls back to the in-memory limiter on execution error (degraded, not open)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error("timeout"));
    const { rqliteRateLimiter } = await import("../rate-limit");
    // Under the fallback the first attempt is allowed by the in-memory bucket,
    // but the bucket is real: exhausting it rejects. Fail-open would have
    // allowed every attempt regardless (the pre-2026-10-21 behaviour).
    const key = `login:ip:degraded-${Math.random()}`;
    const r = await rqliteRateLimiter.check(key, LOGIN_RATE_LIMIT);
    expect(r.allowed).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).not.toContain("secret"); // no creds in logs
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxRequests; i++) {
      await rqliteRateLimiter.check(key, LOGIN_RATE_LIMIT);
    }
    const denied = await rqliteRateLimiter.check(key, LOGIN_RATE_LIMIT);
    expect(denied.allowed).toBe(false);
  });

  it("merges IPv6 addresses to /64 prefixes", async () => {
    const { ipv6PrefixKey } = await import("../rate-limit");
    expect(ipv6PrefixKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    // Compressed forms must expand to their full group sequence first, or all
    // "::"-leading addresses collapse into one bucket.
    expect(ipv6PrefixKey("::1")).toBe("0:0:0:0::/64");
    expect(ipv6PrefixKey("2001:db8::1:2:3:4")).toBe("2001:db8:0:0::/64");
    expect(ipv6PrefixKey("192.168.1.5")).toBe("192.168.1.5");
  });

  it("runs the bounded cleanup DELETE at the 1/100 probability", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.001);
    mockQuery.mockResolvedValue({ results: [], meta: { changes: 1 } });
    const { rqliteRateLimiter } = await import("../rate-limit");
    await rqliteRateLimiter.check("login:ip:1.2.3.4", LOGIN_RATE_LIMIT);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1]?.[0]).toMatch(/DELETE FROM rate_limit_hits/);
    expect(mockQuery.mock.calls[1]?.[1]).toContain("-3600 seconds");
  });
});
