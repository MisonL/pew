/**
 * GET /api/usage — query usage data for the authenticated user.
 *
 * Query params:
 *   from  — ISO date string (default: 30 days ago)
 *   to    — ISO date string (default: now)
 *   source — filter by source (optional)
 *   deviceId — filter by device (optional)
 *   granularity — "half-hour" | "day" (default: "half-hour")
 *
 * Returns { records, summary }.
 */

import { NextResponse } from "next/server";
import { sumCounts, VALID_SOURCES } from "@pew/core";
import { displayCounters } from "@/lib/accounting";
import { resolveUser } from "@/lib/auth-helpers";
import { unauthorizedResponse } from "@/lib/api-responses";
import { jsonResponse } from "@/lib/json-response";
import { parseBoundedInt } from "@/lib/query-params";
import { getDbRead } from "@/lib/db";
import { dateParamToIso, isBareDate, isDateParam } from "@/lib/date-params";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_GRANULARITIES = new Set(["half-hour", "day"]);

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
  const sourceFilter = url.searchParams.get("source");
  const deviceIdFilter = url.searchParams.get("deviceId");
  const granularity = url.searchParams.get("granularity") ?? "half-hour";
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const tzOffsetParam = url.searchParams.get("tzOffset");
  // Per-row accounting annotations are reconciliation evidence and on a large
  // window they dominate the payload (~98% of the body). Pages that only read
  // counters pass includeAccounting=0; the records then come back with their
  // raw counters untouched, so a consumer that ranked raw totals before ranks
  // identically now. The read Worker drops the annotations itself for that
  // mode: the details join, the per-row JSON build and the accounting_json
  // group-by split cost roughly five times the plain aggregation over a
  // two-year window (measured 3384 ms -> 698 ms at half-hour grain, 1751 ms ->
  // 456 ms at day grain), and the web process used to pay all of it to throw
  // the annotations away. Callers whose charts rank by accountedTotal() pass
  // includeAccounting=project instead: the counters come back already
  // projected through displayCounters(), which is what those charts computed
  // locally from the annotations anyway. Default stays true for API
  // compatibility.
  const accountingMode = url.searchParams.get("includeAccounting");
  const includeAccounting = accountingMode !== "0" && accountingMode !== "project";
  const omitAccounting = accountingMode === "0";
  // Some callers only read the summary (e.g. sessions' efficiency stat). The
  // records are the multi-MB part; the summary is computed here either way.
  const summaryOnly = url.searchParams.get("summaryOnly") === "1";
  const tzOffset = parseBoundedInt(tzOffsetParam, {
    min: -840,
    max: 840,
    defaultValue: 0,
  });

  // Validate source filter
  if (sourceFilter && !VALID_SOURCES.has(sourceFilter)) {
    return NextResponse.json(
      { error: "Invalid source parameter" },
      { status: 400 }
    );
  }

  // Validate granularity
  if (!VALID_GRANULARITIES.has(granularity)) {
    return NextResponse.json(
      { error: "Invalid granularity parameter" },
      { status: 400 }
    );
  }

  // Validate tzOffset
  if (tzOffset === "invalid") {
    return NextResponse.json(
      { error: "Invalid tzOffset value" },
      { status: 400 }
    );
  }

  // Validate and compute date range
  let fromDate: string;
  let toDate: string;

  if (fromParam) {
    if (!isDateParam(fromParam)) {
      return NextResponse.json(
        { error: "Invalid from date format" },
        { status: 400 }
      );
    }
    fromDate = dateParamToIso(fromParam);
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 30);
    fromDate = d.toISOString();
  }

  if (toParam) {
    if (!isDateParam(toParam)) {
      return NextResponse.json(
        { error: "Invalid to date format" },
        { status: 400 }
      );
    }
    // When `to` is a bare date like "2026-03-13", treat it as inclusive:
    // bump to next day so that `hour_start < toDate` covers the entire day.
    const toD = new Date(toParam);
    if (isBareDate(toParam)) {
      toD.setUTCDate(toD.getUTCDate() + 1);
    }
    toDate = toD.toISOString();
  } else {
    toDate = new Date().toISOString();
  }

  // 3. Execute query via RPC
  const db = await getDbRead();

  try {
    // A summary-only caller (sessions' efficiency stat) needs five numbers; it
    // used to download every bucket, annotations included, and reduce them
    // here. The read Worker answers the same aggregate in one row.
    if (summaryOnly) {
      const totals = await db.getUsageTotals(userId, fromDate, toDate, {
        ...(sourceFilter && { source: sourceFilter }),
        ...(deviceIdFilter && { deviceId: deviceIdFilter }),
      });
      return jsonResponse(request, {
        records: [],
        summary: totals.evidence_tokens > 0
          ? totals
          : { input_tokens: totals.input_tokens, cached_input_tokens: totals.cached_input_tokens,
              output_tokens: totals.output_tokens, reasoning_output_tokens: totals.reasoning_output_tokens,
              total_tokens: totals.total_tokens },
      });
    }

    const records = await db.getUsageRecords(userId, fromDate, toDate, {
      includeReportedCosts: true,
      ...(omitAccounting && { includeAccounting: false }),
      ...(sourceFilter && { source: sourceFilter }),
      ...(deviceIdFilter && { deviceId: deviceIdFilter }),
      granularity: granularity as "half-hour" | "day",
      tzOffset,
    });

    // Compute summary
    const summary = records.reduce(
      (acc, r) => ({
        input_tokens: sumCounts(acc.input_tokens, r.input_tokens),
        cached_input_tokens:
          sumCounts(acc.cached_input_tokens, r.cached_input_tokens),
        output_tokens: sumCounts(acc.output_tokens, r.output_tokens),
        reasoning_output_tokens:
          sumCounts(acc.reasoning_output_tokens, r.reasoning_output_tokens),
        total_tokens: sumCounts(acc.total_tokens, r.total_tokens),
      }),
      {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      }
    );

    const evidenceTokens = records.reduce((n, r) => sumCounts(n, r.evidence_tokens ?? 0), 0);
    const approximateTokens = records.reduce((n, r) => sumCounts(n, r.approximate_tokens ?? 0), 0);
    // The summary stays the sum of the raw legacy counters regardless of the
    // annotation mode: it is the documented reconciliation basis, not a display
    // aggregate. Plain opt-out records keep their raw counters too — sessions'
    // peak detection ranks by the raw total, so projecting there would move its
    // numbers. "project" is for the display-side consumers whose accountedTotal()
    // ranking the projection reproduces exactly. Mode "0" normally arrives
    // already stripped by the read Worker; a Worker too old to honor
    // includeAccounting still returns the annotations, so drop any that show up.
    const projected = includeAccounting
      ? records
      : accountingMode === "project"
        ? records.map((r) => {
            const { accounting: _accounting, ...row } = r;
            return { ...row, ...displayCounters(r) };
          })
        : records.some((r) => r.accounting !== undefined)
          ? records.map(({ accounting: _accounting, ...row }) => row)
          : records;
    return jsonResponse(request, { records: projected, summary: evidenceTokens > 0
      ? { ...summary, evidence_tokens: evidenceTokens, approximate_tokens: approximateTokens }
      : summary });
  } catch (err) {
    console.error("Failed to query usage:", err);
    return NextResponse.json(
      { error: "Failed to query usage data" },
      { status: 500 }
    );
  }
}
