/**
 * GET /api/auth/login-options — server-derived flags for the login page.
 *
 * Public (falls under /api/auth/*). Read at request time so operators can flip
 * these with a compose `environment:` change, without rebuilding the image —
 * unlike NEXT_PUBLIC_* values, which Next inlines at build time.
 *
 * Returns:
 *   setupNeeded   — no users yet, so the /setup wizard is still available
 *   googleEnabled — an OAuth client is configured (show the Google button)
 */

import { NextResponse } from "next/server";
import { getD1Client } from "@/lib/d1";

export async function GET() {
  const googleEnabled = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
  );

  let setupNeeded = false;
  try {
    const { results } = await getD1Client().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users"
    );
    setupNeeded = (results[0]?.n ?? 0) === 0;
  } catch (err) {
    console.error("Failed to read login options:", err);
    // Default to "already set up": a DB error must not advertise a bootstrap
    // endpoint, and the Google flag is independent of this read.
  }

  return NextResponse.json(
    { setupNeeded, googleEnabled },
    { headers: { "Cache-Control": "no-store" } }
  );
}
