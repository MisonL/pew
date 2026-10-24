/**
 * Simple rate limiting utilities.
 *
 * Tracks request counts in memory within sliding time windows.
 * No external dependencies (Redis, etc.) required.
 */

import { getD1Client } from "@/lib/d1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum requests allowed within the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Requests made in current window */
  current: number;
  /** Maximum allowed requests */
  limit: number;
  /** Seconds until window resets (approximate) */
  retryAfter: number;
}

// ---------------------------------------------------------------------------
// In-Memory Sliding-Window Rate Limiter
// ---------------------------------------------------------------------------

/**
 * Simple in-memory rate limiter using a sliding window of timestamps.
 * Suitable for single-instance deployments (e.g. Cloudflare Workers, single Node process).
 * State is lost on restart — this is acceptable for brute-force mitigation.
 *
 * Memory hygiene: an opportunistic sweep runs at most once per
 * {@link SWEEP_INTERVAL_MS} during `check()` calls. The sweep walks every
 * tracked key, prunes timestamps older than the longest window currently in
 * use, and removes keys whose timestamp arrays end up empty. This bounds
 * long-running memory growth without introducing timers (Workers-friendly).
 */
const SWEEP_INTERVAL_MS = 60_000;

class InMemoryRateLimiter {
  private windows = new Map<string, number[]>();
  private lastSweepAt = 0;
  /** Track the largest window we've ever seen so the sweep cutoff is safe. */
  private maxWindowMs = 0;

  /** Clear all tracked windows (useful for testing). */
  reset(): void {
    this.windows.clear();
    this.lastSweepAt = 0;
    this.maxWindowMs = 0;
  }

  /** Number of tracked keys. Exposed for tests / observability. */
  size(): number {
    return this.windows.size;
  }

  /**
   * Check (and record) a request.
   * @param key   - Unique key (e.g. "team-join:<userId>")
   * @param config - max requests + window size
   */
  check(key: string, config: RateLimitConfig): RateLimitResult {
    const now = Date.now();
    const windowMs = config.windowSeconds * 1000;
    const cutoff = now - windowMs;

    if (windowMs > this.maxWindowMs) {
      this.maxWindowMs = windowMs;
    }

    // Get existing timestamps and prune expired ones
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > cutoff);

    const allowed = timestamps.length < config.maxRequests;
    if (allowed) {
      timestamps.push(now);
    }

    if (timestamps.length === 0) {
      // Abandoned key after pruning — drop instead of storing []
      this.windows.delete(key);
    } else {
      this.windows.set(key, timestamps);
    }

    this.maybeSweep(now);

    return {
      allowed,
      current: timestamps.length,
      limit: config.maxRequests,
      retryAfter: allowed
        ? 0
        : Math.ceil(((timestamps[0] ?? now) + windowMs - now) / 1000),
    };
  }

  /**
   * Sweep all tracked keys at most once per {@link SWEEP_INTERVAL_MS}, dropping
   * entries whose timestamps are all older than the largest window seen.
   * This catches keys that are touched once and then never again (the source
   * of unbounded growth).
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;

    const cutoff = now - this.maxWindowMs;
    for (const [key, timestamps] of this.windows) {
      const live = timestamps.filter((t) => t > cutoff);
      if (live.length === 0) {
        this.windows.delete(key);
      } else if (live.length !== timestamps.length) {
        this.windows.set(key, live);
      }
    }
  }
}

/** Singleton in-memory rate limiter */
export const inMemoryRateLimiter = new InMemoryRateLimiter();

// ---------------------------------------------------------------------------
// Default Configurations
// ---------------------------------------------------------------------------

/** Rate limit for team join attempts: 5 per minute per user */
export const TEAM_JOIN_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowSeconds: 60,
};

/** Rate limit for auth code generation: 10 per hour per IP */
export const AUTH_CODE_GENERATE_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowSeconds: 3600, // 1 hour
};

/** Rate limit for auth code verification: 5 per minute per IP */
export const AUTH_CODE_VERIFY_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowSeconds: 60,
};

/** Rate limit for CLI auth callback: 10 per hour per IP */
export const AUTH_CLI_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowSeconds: 3600, // 1 hour
};

/** Rate limit for ingest endpoint: 300 per minute per user (or per IP if unauthenticated) */
export const INGEST_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 300,
  windowSeconds: 60,
};

/** Rate limit for credential registration: 20 per hour per IP */
export const AUTH_REGISTER_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 20,
  windowSeconds: 3600, // 1 hour
};

/** Rate limit for password-reset consumption: 20 per hour per IP */
export const AUTH_RESET_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 20,
  windowSeconds: 3600, // 1 hour
};

// ---------------------------------------------------------------------------
// Client IP extraction
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of the client IP from a Request.
 *
 * Order of precedence:
 * 1. `x-forwarded-for` (LAST entry: the one our own proxy appended. First
 *    entry is client-controlled and, behind a plain `reverse_proxy` front
 *    that appends rather than overwrites, an attacker can inject arbitrary
 *    first entries to get a fresh per-IP bucket per request)
 * 2. `x-real-ip` (overwrite-style headers from the documented proxy config)
 * 3. `cf-connecting-ip` (Cloudflare)
 *
 * Falls back to "unknown" so rate limiting still applies as a global bucket
 * for requests where no proxy header is present.
 */
export function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();

  return "unknown";
}

// ---------------------------------------------------------------------------
// rqlite-Backed Login Rate Limiter (Plan 3 §3.2)
// ---------------------------------------------------------------------------

/**
 * Table-level cleanup horizon: the largest window any consumer of this SHARED
 * table may use, plus margin. Per-process maxWindowMs is wrong here — a peer
 * that has only ever seen the 60s login window would delete rows another
 * consumer is still counting (3600s auth-code windows would vanish).
 */
export const RQLITE_RATE_LIMIT_WINDOW_SECONDS = 3600;

/** IPv6 privacy extensions rotate addresses per connection; collapse to /64. */
export function ipv6PrefixKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  // Expand the compressed form to exactly 8 groups before truncating, so
  // "::1" expands to "0:0:0:0:...:1" rather than collapsing every
  // "::"-leading address into one bucket.
  const head: string[] = [];
  const tail: string[] = [];
  let atTail = false;
  for (const part of ip.split(":")) {
    if (part === "") {
      if (!atTail) {
        atTail = true;
        if (head.length === 0) head.push("0"); // leading "::"
      }
      continue;
    }
    (atTail ? tail : head).push(part);
  }
  if (!atTail) return `${head.slice(0, 4).join(":")}::/64`; // uncompressed form
  const tailCount = 8 - head.length - tail.length;
  const groups = [...head, ...Array(tailCount).fill("0"), ...tail];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * One atomic statement decides allow/deny: the INSERT happens only while the
 * window count is below the cap, so a single leader-side statement is the
 * whole decision (no COUNT-then-INSERT race across replicas). Window math is
 * SQL-side — app-side ISO strings do not compare against SQLite's
 * 'YYYY-MM-DD HH:MM:SS' format (space < 'T', verified).
 */
class RqliteRateLimiter {
  async check(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    try {
      const db = getD1Client();
      // d1.ts query signature: query<T>(sql, params: unknown[]) - params as
      // one array arg, NOT rest args. Same for execute(sql, params).
      const { meta } = await db.query(
        `INSERT INTO rate_limit_hits(key, hit_at)
         SELECT ?, datetime('now')
         WHERE (SELECT COUNT(*) FROM rate_limit_hits
                WHERE key = ? AND hit_at > datetime('now', ?)) < ?`,
        [key, key, `-${config.windowSeconds} seconds`, config.maxRequests]
      );
      if ((meta?.changes ?? 0) === 0) {
        // Over-limit: the DB is healthy, the bucket is full. Not an error.
        return { allowed: false, current: config.maxRequests, limit: config.maxRequests, retryAfter: config.windowSeconds };
      }
      // Mirror the accepted attempt into the in-memory bucket WITHOUT
      // consulting it: when the DB later degrades, the fallback bucket already
      // carries these counts instead of starting fresh — otherwise a partial
      // outage would hand every active key a whole additional allowance
      // exactly when guessing is most attractive. (The mirror's own result is
      // irrelevant here; the DB decided.)
      inMemoryRateLimiter.check(key, config);
      this.maybeCleanup(db);
      return { allowed: true, current: 1, limit: config.maxRequests, retryAfter: 0 };
    } catch (error) {
      // Degraded, not open: the rqlite backend failed (missing 033 migration,
      // leader timeout/election), so fall back to the process-local limiter
      // for this key instead of allowing every attempt. Fail-open turned a
      // partial DB outage into unlimited password guessing with only a
      // console.warn as the signal (verified review 2026-10-21). The
      // in-memory bucket keeps the per-process bound; across replicas it is
      // weaker, but still far better than no limit at all.
      console.warn(`login rate limiter degraded (falling back to in-memory): ${error instanceof Error ? error.message : error}`);
      return inMemoryRateLimiter.check(key, config);
    }
  }

  /** 1/100 sampled DELETE bounded by the table-level constant. */
  private maybeCleanup(db: ReturnType<typeof getD1Client>): void {
    if (Math.random() >= 0.01) return;
    void db.query(
      `DELETE FROM rate_limit_hits WHERE hit_at < datetime('now', ?)`,
      [`-${RQLITE_RATE_LIMIT_WINDOW_SECONDS} seconds`]
    ).catch(() => { /* best effort */ });
  }
}

export const rqliteRateLimiter = new RqliteRateLimiter();
