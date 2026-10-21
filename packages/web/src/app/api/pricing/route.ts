/**
 * GET /api/pricing — public pricing map (merged dynamic + admin DB).
 *
 * Returns the full PricingMap that clients use for cost estimation.
 * Authenticated users get the same data — no admin required.
 */

import { getDbRead } from "@/lib/db";
import { loadPricingMap } from "@/lib/load-pricing-map";
import { jsonResponse } from "@/lib/json-response";

export async function GET(request: Request) {
  const db = await getDbRead();
  const pricingMap = await loadPricingMap(db);
  // A merged catalogue runs ~0.5 MB of JSON; Next's built-in compression does
  // not cover route-handler bodies, so gzip it like the other read endpoints.
  return jsonResponse(request, pricingMap, { headers: { "Cache-Control": "public, max-age=60" } });
}
