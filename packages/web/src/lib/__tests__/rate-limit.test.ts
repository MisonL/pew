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

  it("does not throw on malformed IPv6-shaped input", async () => {
    // These reach the limiter through X-Forwarded-For, so they are attacker
    // bytes. Padding to 8 groups with a negative count used to throw a
    // RangeError out of the request handler — an unauthenticated 500 on every
    // login attempt.
    const { ipv6PrefixKey, boundedIpKey } = await import("../rate-limit");
    for (const bad of [
      "1:2:3:4:5:6:7:8:9:10",
      "::1:2:3:4:5:6:7:8:9",
      "a:b:c:d:e:f:g::h:i:j:k:l",
      ":::",
      "1:2:3:4:5:6:7:8:9::",
    ]) {
      expect(() => ipv6PrefixKey(bad)).not.toThrow();
      expect(() => boundedIpKey(bad)).not.toThrow();
      expect(boundedIpKey(bad).length).toBeLessThanOrEqual(64);
    }
    expect(ipv6PrefixKey("1:2:3:4:5:6:7:8:9:10")).toBe("1:2:3:4::/64");
    // Well-formed addresses keep folding into one /64 bucket.
    expect(ipv6PrefixKey("2001:db8:0:0:0:0:0:1")).toBe(ipv6PrefixKey("2001:db8:0:0:ffff:ffff:ffff:ffff"));
  });

  it("puts a malformed forwarded IPv6 header through the limiter as one bounded key", async () => {
    // End-to-end through the path a login attempt actually takes: the raw
    // header -> clientIpKey -> the SQL bound parameter. The fix must not only
    // avoid the throw; whatever it falls back to has to be a bounded, stable
    // key or the shared rate_limit_hits table takes an attacker-sized row.
    //
    // The input carries "::" on purpose: an address without it leaves through
    // the earlier `!atTail` branch and never reaches the negative pad count
    // this guards, so a no-":"-colon string would pass whether or not the fix
    // is present.
    mockQuery.mockResolvedValue({ results: [], meta: { changes: 1 } });
    const { clientIpKey, rqliteRateLimiter } = await import("../rate-limit");
    const header = "::1:2:3:4:5:6:7:8:9";
    const request = new Request("http://localhost:7020/api/auth/register", {
      headers: { "x-forwarded-for": header },
    });

    const key = `login:ip:${clientIpKey(request)}`;
    expect(key.length).toBeLessThanOrEqual("login:ip:".length + 64);
    const r = await rqliteRateLimiter.check(key, LOGIN_RATE_LIMIT);
    expect(r.allowed).toBe(true);
    // The key lands in the INSERT as a bound parameter, not interpolated SQL.
    expect(mockQuery.mock.calls[0]?.[1]).toContain(key);
    // The same header always lands on the same bucket, so the fallback is
    // stable rather than a per-request unique key that would defeat the limit.
    expect(clientIpKey(request)).toBe(clientIpKey(new Request("http://localhost:7020/", {
      headers: { "x-forwarded-for": header },
    })));
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
