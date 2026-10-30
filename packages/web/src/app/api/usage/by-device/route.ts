/**
 * GET /api/usage/by-device — per-device usage analytics.
 *
 * Query params:
 *   from — ISO date string (default: 30 days ago)
 *   to   — ISO date string (default: now)
 *   granularity — "half-hour" | "day" (default: "day") for timeline
 *
 * Returns { devices, timeline } where:
 *   - devices: aggregated stats per device with estimated_cost
 *   - timeline: token counts per device for charting (day or half-hour granularity)
 */

import { estimateUsageCost, displayCounters } from "@/lib/accounting";
import { NextResponse } from "next/server";
import { sumCounts } from "@pew/core";
import { resolveUser } from "@/lib/auth-helpers";
import { unauthorizedResponse } from "@/lib/api-responses";
import { jsonResponse } from "@/lib/json-response";
import { parseBoundedInt } from "@/lib/query-params";
import { getDbRead } from "@/lib/db";
import { loadPricingMap } from "@/lib/load-pricing-map";
import { dateParamToIso, isBareDate, isDateParam } from "@/lib/date-params";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDateRange(fromParam: string | null, toParam: string | null) {
  let fromDate: string;
  let toDate: string;

  if (fromParam) {
    if (!isDateParam(fromParam)) return null;
    fromDate = dateParamToIso(fromParam);
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 30);
    fromDate = d.toISOString();
  }

  if (toParam) {
    if (!isDateParam(toParam)) return null;
    // Bare date "YYYY-MM-DD" → inclusive: bump +1 UTC day for `< toDate`
    const toD = new Date(toParam);
    if (isBareDate(toParam)) {
      toD.setUTCDate(toD.getUTCDate() + 1);
    }
    toDate = toD.toISOString();
  } else {
    toDate = new Date().toISOString();
  }

  return { fromDate, toDate };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  // 1. Authenticate
  const authResult = await resolveUser(request);
  if (!authResult) {
    return unauthorizedResponse();
  }
  const userId = authResult.userId;

  // 2. Parse query params
  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const granularityParam = url.searchParams.get("granularity");
  const tzOffsetParam = url.searchParams.get("tzOffset");
  // The drill-down detail rows are ~1/3 of this response and only two pages
  // read them (/devices, /hourly-usage). Default stays true for API
  // compatibility; the dashboard's breakdown charts — which use `devices` and
  // `timeline` only — pass includeDetails=0. Measured: 15.6 MB -> 10.4 MB for
  // an all-time window before compression.
  const includeDetails = url.searchParams.get("includeDetails") !== "0";
  // The accounting annotations are reconciliation evidence: accounting for the
  // split between billed and legacy counters. On a large all-time window they
  // ARE the payload — a single device's annotation is 5.4 MB and the timeline's
  // another 5.4 MB, against 6 KB of actual counters. Three modes:
  //   (default)  annotations everywhere — /devices' UsageInformation needs the
  //              per-(device,source,model) ones for its coverage notes
  //   "details"  only on deviceDetails: devices and timeline lose the 10.8 MB
  //              nobody reads (labels and totals are all that's consumed)
  //   "0"        none; the counters come back already projected through
  //              displayCounters() so a client that skips them still charts the
  //              same split — /dashboard's breakdown charts pass this
  // The two modes that drop the per-device annotations have the read Worker
  // project them, so the evidence never leaves the Worker either (measured:
  // 140.8 MB of a by-device timeline against a few KB of counters).
  const accountingMode = url.searchParams.get("includeAccounting");
  const includeDeviceAccounting = accountingMode !== "0" && accountingMode !== "details";
  const includeDetailAccounting = accountingMode !== "0";
  const tzOffset = parseBoundedInt(tzOffsetParam, {
    min: -840,
    max: 840,
    defaultValue: 0,
  });

  // Validate granularity. A value the route does not implement must be a 400,
  // not a silent downgrade to "day": /api/usage already rejects it, and a
  // caller that asked for hourly buckets would otherwise get a 200 carrying
  // daily ones.
  if (granularityParam !== null && granularityParam !== "half-hour" && granularityParam !== "day") {
    return NextResponse.json(
      { error: "Invalid granularity parameter" },
      { status: 400 }
    );
  }
  const granularity: "half-hour" | "day" = granularityParam === "half-hour" ? "half-hour" : "day";

  const dateRange = parseDateRange(fromParam, toParam);
  if (!dateRange) {
    return NextResponse.json(
      { error: "Invalid date format" },
      { status: 400 }
    );
  }

  if (tzOffset === "invalid") {
    return NextResponse.json(
      { error: "Invalid tzOffset value" },
      { status: 400 }
    );
  }
  const { fromDate, toDate } = dateRange;

  // 3. Execute queries via RPC
  const db = await getDbRead();

  try {
    // Four independent reads. Awaiting them in sequence costs four round
    // trips where one does, and this route backs the heaviest pages. The
    // modes that drop the per-device annotations ask the read Worker to
    // project them: the same function, but the ~11 MB of reconciliation
    // evidence for an all-time window never leaves the Worker.
    const projectDeviceAccounting = !includeDeviceAccounting;
    const [summaryRows, costRows, timelineRows, pricingMap] = await Promise.all([
      db.getDeviceSummary(userId, fromDate, toDate, { projectAccounting: projectDeviceAccounting }),
      db.getDeviceCostDetails(userId, fromDate, toDate),
      db.getDeviceTimeline(userId, fromDate, toDate, { granularity, tzOffset, projectAccounting: projectDeviceAccounting }),
      loadPricingMap(db),
    ]);

    // 5. Compute estimated_cost per device from cost detail rows
    const costByDevice = new Map<string, { total: number; complete: boolean }>();

    for (const row of costRows) {
      const cost = estimateUsageCost(row, pricingMap);
      const previous = costByDevice.get(row.device_id);
      costByDevice.set(row.device_id, { total: (previous?.total ?? 0) + cost.totalCost,
        complete: (previous?.complete ?? true) && cost.complete });
    }

    // 6. Assemble response. In the modes that drop an annotation the counters
    // are returned already projected through displayCounters(), so a client
    // that skips the annotations still charts the same split billed-vs-legacy
    // partition it would have derived locally — displayCounters() is idempotent
    // on its own output (a row without annotations projects to itself), so
    // clients that run it unconditionally are unaffected.
    const devices = summaryRows.map((row) => {
      const counters = includeDeviceAccounting ? row : displayCounters(row);
      return {
        device_id: row.device_id,
        alias: row.alias,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        total_tokens: counters.total_tokens,
        input_tokens: counters.input_tokens,
        output_tokens: counters.output_tokens,
        cached_input_tokens: counters.cached_input_tokens,
        reasoning_output_tokens: counters.reasoning_output_tokens,
        estimated_cost: costByDevice.get(row.device_id)?.total ?? 0,
        estimated_cost_complete: costByDevice.get(row.device_id)?.complete ?? row.total_tokens === 0,
        ...(row.accounting && includeDeviceAccounting ? { accounting: row.accounting } : {}),
        sources: row.sources ? row.sources.split(",") : [],
        models: row.models ? row.models.split(",") : [],
      };
    });

    const timeline = timelineRows.map((row) => {
      const counters = includeDeviceAccounting ? row : displayCounters(row);
      return {
        date: row.date,
        device_id: row.device_id,
        total_tokens: counters.total_tokens,
        input_tokens: counters.input_tokens,
        output_tokens: counters.output_tokens,
        cached_input_tokens: counters.cached_input_tokens,
        reasoning_output_tokens: counters.reasoning_output_tokens ?? 0,
        ...(row.accounting && includeDeviceAccounting ? { accounting: row.accounting } : {}),
      };
    });

    // 7. Map cost detail rows for client-side drill-down charts. When the
    // annotations are dropped the counters must be projected like `devices`
    // and `timeline` above, or a client that sums the drill-down rows gets the
    // raw legacy split and disagrees with the device row it drilled from.
    const deviceDetails = includeDetails ? costRows.map((row) => {
      const counters = includeDetailAccounting ? row : displayCounters(row);
      const reasoning = counters.reasoning_output_tokens ?? 0;
      return {
        device_id: row.device_id,
        source: row.source,
        model: row.model,
        total_tokens:
          sumCounts(counters.input_tokens, counters.output_tokens, counters.cached_input_tokens, reasoning),
        input_tokens: counters.input_tokens,
        output_tokens: counters.output_tokens,
        cached_input_tokens: counters.cached_input_tokens,
        reasoning_output_tokens: reasoning,
        ...(row.accounting && includeDetailAccounting ? { accounting: row.accounting } : {}),
      };
    }) : [];

    return jsonResponse(request, { devices, timeline, deviceDetails });
  } catch (err) {
    console.error("Failed to query by-device usage:", err);
    return NextResponse.json(
      { error: "Failed to query by-device usage data" },
      { status: 500 }
    );
  }
}
