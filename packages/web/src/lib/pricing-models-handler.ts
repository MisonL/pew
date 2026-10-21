/**
 * Shared handler for the dynamic-pricing read endpoints.
 *
 * Backs both:
 *   - GET /api/pricing/models        (any authenticated user)
 *   - GET /api/admin/pricing/models  (admin-only — kept for compatibility)
 *
 * Strictly read-only: pulls from worker-read's KV-backed
 * `pricing.getDynamicPricing` / `pricing.getDynamicPricingMeta` RPCs.
 */

import { NextResponse } from "next/server";
import { getDbRead } from "@/lib/db";
import { jsonResponse } from "@/lib/json-response";

export async function fetchDynamicPricingPayload(request: Request): Promise<Response> {
  try {
    const dbRead = await getDbRead();
    const [dyn, meta] = await Promise.all([
      dbRead.getDynamicPricing(),
      dbRead.getDynamicPricingMeta(),
    ]);

    // A full pricing catalogue is a few hundred KB; gzip it like the other
    // read endpoints rather than shipping raw JSON from the route handler.
    return jsonResponse(request, {
      entries: dyn.entries,
      servedFrom: dyn.servedFrom,
      meta,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("Failed to load dynamic pricing:", err);
    return NextResponse.json(
      {
        error: "Failed to load dynamic pricing",
        fallback: { entries: [], meta: null },
      },
      { status: 503 },
    );
  }
}
