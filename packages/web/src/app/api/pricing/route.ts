/**
 * GET /api/pricing — public pricing map (merged dynamic + admin DB).
 *
 * Returns the full PricingMap that clients use for cost estimation.
 * Authenticated users get the same data — no admin required.
 */

import { getDbRead } from "@/lib/db";
import { loadPricingMap } from "@/lib/load-pricing-map";
import { jsonResponse } from "@/lib/json-response";
import { PRICING_RATE_LIMIT, clientIpKey, inMemoryRateLimiter } from "@/lib/rate-limit";

export async function GET(request: Request) {
  // Public, unauthenticated, and ~0.5 MB per response; an anonymous loop
  // otherwise repeats the serialization with nothing in front of it. Same
  // shape as the public leaderboard's bound, with its own bucket.
  const rateLimited = inMemoryRateLimiter.check(
    `pricing:${clientIpKey(request)}`,
    PRICING_RATE_LIMIT,
  );
  if (!rateLimited.allowed) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please try again later." }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(rateLimited.retryAfter) } },
    );
  }
  const db = await getDbRead();
  const pricingMap = await loadPricingMap(db);
  // A merged catalogue runs ~0.5 MB of JSON; it goes out identity-encoded and
  // the edge compresses it (see lib/json-response.ts for why the origin no
  // longer does it itself).
  return jsonResponse(request, pricingMap, { headers: { "Cache-Control": "public, max-age=60" } });
}
