/**
 * GET /api/live -- surety standard health check endpoint.
 *
 * No authentication required. No caching.
 * Verifies core dependency connectivity (D1 database).
 * Error messages are sanitized to prevent monitor false-positives.
 */

import { getDbRead } from "@/lib/db";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/** Timeout in ms for the DB health-check ping. */
const DB_PING_TIMEOUT_MS = 3_000;

export async function GET() {
  const timestamp = new Date().toISOString();
  const uptime = Math.floor(process.uptime());
  let database: { connected: boolean; error?: string };

  try {
    const db = await getDbRead();
    await Promise.race([
      db.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DB ping timed out")), DB_PING_TIMEOUT_MS),
      ),
    ]);
    database = { connected: true };
  } catch (err) {
    // Public endpoint: never echo the driver's error text. It names internal
    // topology (rqlite URLs, table/column names) and the old single-word
    // `ok` scrub left everything else intact. Log server-side instead.
    console.error("live health check failed:", err instanceof Error ? err.message : err);
    database = { connected: false, error: "database unavailable" };
  }

  const healthy = database.connected;

  return Response.json(
    { status: healthy ? "ok" : "error", version: APP_VERSION, component: "dashboard", timestamp, uptime, database },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
