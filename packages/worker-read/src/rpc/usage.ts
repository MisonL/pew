/**
 * Usage domain RPC handlers for worker-read.
 *
 * Handles all usage-related read queries with typed interfaces.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { ACCOUNTED_USAGE_SQL } from "./accounting";
import { mergeUsageRows } from "./usage-aggregation";

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

interface UsageRow {
  accounting_json?: string;
  source: string;
  model: string;
  hour_start: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  evidence_tokens?: number;
  approximate_tokens?: number;
}

interface DeviceSummaryRow {
  accounting_json?: string;
  device_id: string;
  alias: string | null;
  first_seen: string;
  last_seen: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  sources: string;
  models: string;
}

interface CostDetailRow {
  accounting_json?: string;
  device_id: string;
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
}

interface TimelineRow {
  accounting_json?: string;
  date: string;
  device_id: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
}

// ---------------------------------------------------------------------------

export interface GetUsageRequest {
  includeReportedCosts?: boolean;
  /**
   * Default true. `false` skips the usage_details join and the
   * accounting_json column entirely — callers that only chart counters were
   * paying for the join, the JSON build, and the group-by split on every row
   * (measured at ~5x the plain aggregation over a two-year window) and then
   * discarding the annotations in the web process.
   */
  includeAccounting?: boolean;
  method: "usage.get";
  userId: string;
  fromDate: string;
  toDate: string;
  source?: string;
  deviceId?: string;
  granularity?: "half-hour" | "day";
  tzOffset?: number;
}

export interface GetDeviceSummaryRequest {
  method: "usage.getDeviceSummary";
  userId: string;
  fromDate: string;
  toDate: string;
}

/**
 * The counters-only aggregate behind `/api/usage?summaryOnly=1`: pages that
 * render a handful of totals were downloading the whole per-bucket record set
 * (annotations included) to reduce it to five numbers.
 */
export interface GetUsageTotalsRequest {
  method: "usage.getTotals";
  userId: string;
  fromDate: string;
  toDate: string;
  source?: string;
  deviceId?: string;
}

export interface UsageTotals {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  evidence_tokens: number;
  approximate_tokens: number;
}

export interface GetDeviceCostDetailsRequest {
  method: "usage.getDeviceCostDetails";
  userId: string;
  fromDate: string;
  toDate: string;
}

export interface GetDeviceTimelineRequest {
  method: "usage.getDeviceTimeline";
  userId: string;
  fromDate: string;
  toDate: string;
  granularity?: "half-hour" | "day";
  tzOffset?: number;
}

export type UsageRpcRequest =
  | GetUsageRequest
  | GetUsageTotalsRequest
  | GetDeviceSummaryRequest
  | GetDeviceCostDetailsRequest
  | GetDeviceTimelineRequest;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetUsage(
  req: GetUsageRequest,
  db: D1Database
): Promise<Response> {
  if (!req.userId || !req.fromDate || !req.toDate) {
    return Response.json(
      { error: "userId, fromDate, and toDate are required" },
      { status: 400 }
    );
  }

  const granularity = req.granularity ?? "half-hour";
  const rawTz = req.tzOffset ?? 0;
  const tzOffset =
    Number.isInteger(rawTz) && Math.abs(rawTz) <= 840 ? rawTz : 0;

  let timeColumn: string;
  let groupBy: string;
  const prependParams: unknown[] = [];

  if (granularity === "day") {
    if (tzOffset !== 0) {
      const offsetStr = String(-tzOffset);
      // Note: GROUP BY doesn't support parameterized ?, so we inline the offset
      // The offset is validated (integer, abs <= 840) so this is safe
      timeColumn =
        "date(datetime(hour_start, ? || ' minutes')) AS hour_start";
      groupBy =
        `date(datetime(hour_start, '${offsetStr} minutes')), source, model`;
      prependParams.push(offsetStr);
    } else {
      timeColumn = "date(hour_start) AS hour_start";
      groupBy = "date(hour_start), source, model";
    }
  } else {
    timeColumn = "hour_start";
    groupBy = "hour_start, source, model";
  }

  const conditions: string[] = [];
  const params: unknown[] = [req.userId, req.fromDate, req.toDate];

  if (req.source) {
    conditions.push("source = ?");
    params.push(req.source);
  }

  if (req.deviceId) {
    conditions.push("device_id = ?");
    params.push(req.deviceId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Two shapes over the same filtered bases. With annotations, rows are split
  // by accounting_json and merged back in JS; without them the aggregation is
  // a single grouped pass over usage_bases with no details join at all. Both
  // produce the same counters at the same grain — the split only exists to
  // carry the annotations.
  const sql = req.includeAccounting === false
    ? `
    SELECT
      source,
      model,
      ${timeColumn},
      SUM(input_tokens) AS input_tokens,
      SUM(cached_input_tokens) AS cached_input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(reasoning_output_tokens) AS reasoning_output_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(evidence_tokens) AS evidence_tokens,
      SUM(approximate_tokens) AS approximate_tokens
    FROM usage_bases
    WHERE user_id = ? AND hour_start >= ? AND hour_start < ?
      AND (event_id = '' OR total_tokens > 0)
      ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
    GROUP BY ${groupBy}
    ORDER BY hour_start ASC, source, model
  `
    : `
    SELECT
      source,
      model,
      ${timeColumn},
      SUM(input_tokens) AS input_tokens,
      SUM(cached_input_tokens) AS cached_input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(reasoning_output_tokens) AS reasoning_output_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(evidence_tokens) AS evidence_tokens,
      SUM(approximate_tokens) AS approximate_tokens,
      accounting_json, COUNT(*) AS accounting_count
    FROM (${ACCOUNTED_USAGE_SQL})
    ${where}
    GROUP BY ${groupBy}, accounting_json
    ORDER BY hour_start ASC, source, model
  `;

  const stmt = db.prepare(sql);
  const results = await stmt
    .bind(...prependParams, ...params)
    .all<UsageRow>();

  return Response.json({
    result: req.includeAccounting === false
      ? results.results
      : mergeUsageRows(results.results, ["hour_start", "source", "model"], req.includeReportedCosts === true),
  });
}

async function handleGetUsageTotals(
  req: GetUsageTotalsRequest,
  db: D1Database
): Promise<Response> {
  if (!req.userId || !req.fromDate || !req.toDate) {
    return Response.json(
      { error: "userId, fromDate, and toDate are required" },
      { status: 400 }
    );
  }

  const conditions: string[] = [];
  const params: unknown[] = [req.userId, req.fromDate, req.toDate];

  if (req.source) {
    conditions.push("source = ?");
    params.push(req.source);
  }

  if (req.deviceId) {
    conditions.push("device_id = ?");
    params.push(req.deviceId);
  }

  // Same filter the record query applies, so a totals-only caller sees the
  // counters it would have summed itself.
  const sql = `
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(evidence_tokens), 0) AS evidence_tokens,
      COALESCE(SUM(approximate_tokens), 0) AS approximate_tokens
    FROM usage_bases
    WHERE user_id = ? AND hour_start >= ? AND hour_start < ?
      AND (event_id = '' OR total_tokens > 0)
      ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
  `;

  const row = await db.prepare(sql).bind(...params).first<UsageTotals>();
  return Response.json({
    result: row ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
      total_tokens: 0, evidence_tokens: 0, approximate_tokens: 0 },
  });
}

async function handleGetDeviceSummary(
  req: GetDeviceSummaryRequest,
  db: D1Database
): Promise<Response> {
  if (!req.userId || !req.fromDate || !req.toDate) {
    return Response.json(
      { error: "userId, fromDate, and toDate are required" },
      { status: 400 }
    );
  }

  const results = await db
    .prepare(
      `SELECT
        ur.device_id,
        da.alias,
        MIN(ur.hour_start) AS first_seen,
        MAX(ur.hour_start) AS last_seen,
        SUM(ur.total_tokens) AS total_tokens,
        SUM(ur.input_tokens) AS input_tokens,
        SUM(ur.output_tokens) AS output_tokens,
        SUM(ur.cached_input_tokens) AS cached_input_tokens,
        SUM(ur.reasoning_output_tokens) AS reasoning_output_tokens,
        ur.accounting_json, COUNT(*) AS accounting_count,
        GROUP_CONCAT(DISTINCT ur.source) AS sources,
        GROUP_CONCAT(DISTINCT ur.model) AS models
      FROM (${ACCOUNTED_USAGE_SQL}) ur
      LEFT JOIN device_aliases da
        ON da.user_id = ur.user_id AND da.device_id = ur.device_id
      GROUP BY ur.device_id, ur.accounting_json
      ORDER BY total_tokens DESC`
    )
    .bind(req.userId, req.fromDate, req.toDate)
    .all<DeviceSummaryRow>();

  const rows = mergeUsageRows(results.results, ["device_id"]);
  return Response.json({ result: rows.sort((a, b) => b.total_tokens - a.total_tokens) });
}

async function handleGetDeviceCostDetails(
  req: GetDeviceCostDetailsRequest,
  db: D1Database
): Promise<Response> {
  if (!req.userId || !req.fromDate || !req.toDate) {
    return Response.json(
      { error: "userId, fromDate, and toDate are required" },
      { status: 400 }
    );
  }

  const results = await db
    .prepare(
      `SELECT
        ur.device_id,
        ur.source,
        ur.model,
        SUM(ur.input_tokens) AS input_tokens,
        SUM(ur.output_tokens) AS output_tokens,
        SUM(ur.cached_input_tokens) AS cached_input_tokens,
        SUM(ur.reasoning_output_tokens) AS reasoning_output_tokens,
        ur.accounting_json, COUNT(*) AS accounting_count
      FROM (${ACCOUNTED_USAGE_SQL}) ur
      GROUP BY ur.device_id, ur.source, ur.model, ur.accounting_json`
    )
    .bind(req.userId, req.fromDate, req.toDate)
    .all<CostDetailRow>();

  return Response.json({ result: mergeUsageRows(results.results, ["device_id", "source", "model"]) });
}

async function handleGetDeviceTimeline(
  req: GetDeviceTimelineRequest,
  db: D1Database
): Promise<Response> {
  if (!req.userId || !req.fromDate || !req.toDate) {
    return Response.json(
      { error: "userId, fromDate, and toDate are required" },
      { status: 400 }
    );
  }

  const granularity = req.granularity ?? "day";
  const rawTz = req.tzOffset ?? 0;
  const tzOffset =
    Number.isInteger(rawTz) && Math.abs(rawTz) <= 840 ? rawTz : 0;

  let dateExpr: string;
  let groupBy: string;
  const tzParams: unknown[] = [];

  if (granularity === "day") {
    if (tzOffset !== 0) {
      const offsetStr = String(-tzOffset);
      // Note: GROUP BY doesn't support parameterized ?, so we inline the offset
      // The offset is validated (integer, abs <= 840) so this is safe
      dateExpr = "date(datetime(ur.hour_start, ? || ' minutes'))";
      groupBy = `date(datetime(ur.hour_start, '${offsetStr} minutes')), ur.device_id`;
      tzParams.push(offsetStr);
    } else {
      dateExpr = "date(ur.hour_start)";
      groupBy = "date(ur.hour_start), ur.device_id";
    }
  } else {
    dateExpr = "ur.hour_start";
    groupBy = "ur.hour_start, ur.device_id";
  }

  const sql = `
    SELECT
      ${dateExpr} AS date,
      ur.device_id,
      SUM(ur.total_tokens) AS total_tokens,
      SUM(ur.input_tokens) AS input_tokens,
      SUM(ur.output_tokens) AS output_tokens,
      SUM(ur.cached_input_tokens) AS cached_input_tokens,
      SUM(ur.reasoning_output_tokens) AS reasoning_output_tokens,
      ur.accounting_json, COUNT(*) AS accounting_count
    FROM (${ACCOUNTED_USAGE_SQL}) ur
    GROUP BY ${groupBy}, ur.accounting_json
    ORDER BY date ASC
  `;

  const results = await db
    .prepare(sql)
    .bind(...tzParams, req.userId, req.fromDate, req.toDate)
    .all<TimelineRow>();

  const rows = mergeUsageRows(results.results, ["date", "device_id"]);
  return Response.json({ result: rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)) });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleUsageRpc(
  request: UsageRpcRequest,
  db: D1Database
): Promise<Response> {
  switch (request.method) {
    case "usage.get":
      return handleGetUsage(request, db);
    case "usage.getTotals":
      return handleGetUsageTotals(request, db);
    case "usage.getDeviceSummary":
      return handleGetDeviceSummary(request, db);
    case "usage.getDeviceCostDetails":
      return handleGetDeviceCostDetails(request, db);
    case "usage.getDeviceTimeline":
      return handleGetDeviceTimeline(request, db);
    default:
      return Response.json(
        { error: `Unknown usage method: ${(request as { method: string }).method}` },
        { status: 400 }
      );
  }
}
