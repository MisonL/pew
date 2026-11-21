/**
 * GET /api/live -- surety standard health check endpoint.
 *
 * No authentication required. No caching.
 * Verifies core dependency connectivity (D1 database).
 * Error messages are sanitized to prevent monitor false-positives.
 */

import { getDbRead } from "@/lib/db";
import { clientIpKey, inMemoryRateLimiter, LIVE_RATE_LIMIT } from "@/lib/rate-limit";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/** Timeout in ms for the DB health-check ping. */
const DB_PING_TIMEOUT_MS = 3_000;

export async function GET(request: Request) {
  // Public and unauthenticated: each call opens a DB read client and waits on
  // a ping. Without a per-IP cap one client can keep the single web process
  // busy from outside the login wall.
  const rateLimited = inMemoryRateLimiter.check(
    `live:${clientIpKey(request)}`,
    LIVE_RATE_LIMIT,
  );
  if (!rateLimited.allowed) {
    return Response.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimited.retryAfter),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const timestamp = new Date().toISOString();
  const uptime = Math.floor(process.uptime());
  let database: { connected: boolean; error?: string };

  // The timeout aborts the underlying RPC fetch as well as the wait: the
  // old Promise.race returned at 3 s but left the ping running, and a
  // client that hung up left it running too.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_PING_TIMEOUT_MS);
  request.signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const db = await getDbRead();
    await Promise.race([
      db.ping(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("DB ping timed out")),
          { once: true },
        );
      }),
    ]);
    database = { connected: true };
  } catch (err) {
    // Public endpoint: never echo the driver error text. It names internal
    // topology (rqlite URLs, table/column names) and the old single-word
    // `ok` scrub left everything else intact. Log server-side instead.
    console.error("live health check failed:", err instanceof Error ? err.message : err);
    database = { connected: false, error: "database unavailable" };
  } finally {
    clearTimeout(timer);
  }

  const healthy = database.connected;

  return Response.json(
    { status: healthy ? "ok" : "error", version: APP_VERSION, component: "dashboard", timestamp, uptime, database },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
