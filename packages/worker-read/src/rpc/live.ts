/**
 * Live domain RPC handlers for worker-read.
 *
 * Handles live/real-time data queries (active sessions, recent activity, live stats).
 */

import type { D1Database } from "@cloudflare/workers-types";

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

interface ActiveSessionRow {
  id: string;
  user_id: string;
  name: string | null;
  source: string;
  started_at: string;
  total_messages: number;
  last_activity_at: string;
}

interface RecentActivityRow {
  user_id: string;
  name: string | null;
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

interface LiveStatsRow {
  active_sessions: number;
  tokens_last_hour: number;
  requests_last_hour: number;
  unique_users_last_hour: number;
}

// ---------------------------------------------------------------------------
// RPC Request Types
// ---------------------------------------------------------------------------

export interface GetActiveSessionsRequest {
  method: "live.getActiveSessions";
  limit?: number;
}

export interface GetRecentActivityRequest {
  method: "live.getRecentActivity";
  userId?: string;
  source?: string;
  limit?: number;
}

export interface GetLiveStatsRequest {
  method: "live.getStats";
}

export interface GetUserLiveStatsRequest {
  method: "live.getUserStats";
  userId: string;
}

interface PingRequest {
  method: "live.ping";
}

export type LiveRpcRequest =
  | GetActiveSessionsRequest
  | GetRecentActivityRequest
  | GetLiveStatsRequest
  | GetUserLiveStatsRequest
  | PingRequest;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetActiveSessions(
  req: GetActiveSessionsRequest,
  db: D1Database
): Promise<Response> {
  // Lower-clamp as well as upper: SQLite reads a negative LIMIT (-1, any
  // negative) as "no limit", so an unclamped limit silently dropped the cap.
  const limit = Math.min(Math.max(req.limit ?? 50, 0), 250);

  // session_records has last_message_at instead of ended_at
  // "Active" sessions are those with recent activity (within 30 min)
  const sql = `
    SELECT
      sr.id,
      sr.user_id,
      u.name,
      sr.source,
      sr.started_at,
      sr.total_messages,
      sr.last_message_at AS last_activity_at
    FROM session_records sr
    JOIN users u ON u.id = sr.user_id
    WHERE julianday(sr.last_message_at) >= julianday('now', '-30 minutes')
    ORDER BY sr.last_message_at DESC
    LIMIT ?
  `;

  const results = await db.prepare(sql).bind(limit).all<ActiveSessionRow>();

  return Response.json({ result: results.results });
}

async function handleGetRecentActivity(
  req: GetRecentActivityRequest,
  db: D1Database
): Promise<Response> {
  const limit = Math.min(Math.max(req.limit ?? 50, 0), 250);
  // julianday() rather than a string compare: pre-canonicalization rows may
  // carry offsets or extra precision, which sort wrong as text. This predicate
  // is not sargable (full scan), but the handler has no caller and the table
  // is small; correctness on legacy rows wins.
  const conditions = ["julianday(hour_start) >= julianday('now', '-1 hour')"];
  const params: unknown[] = [];

  if (req.userId) {
    conditions.push("user_id = ?");
    params.push(req.userId);
  }

  if (req.source) {
    conditions.push("source = ?");
    params.push(req.source);
  }

  // Buckets are the display grain, so the bases are folded to one row per
  // (user, device, source, model, hour) before the join — `usage_totals`
  // would re-materialise the whole view to reach the same rows.
  const sql = `
    WITH recent AS (
      SELECT user_id, device_id, source, model, hour_start,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
      FROM usage_bases
      WHERE (event_id = '' OR total_tokens > 0) AND ${conditions.join(" AND ")}
      GROUP BY user_id, device_id, source, model, hour_start
    )
    SELECT
      ur.user_id,
      u.name,
      ur.source,
      ur.model,
      ur.input_tokens,
      ur.output_tokens,
      ur.hour_start AS created_at
    FROM recent ur
    JOIN users u ON u.id = ur.user_id
    ORDER BY ur.hour_start DESC
    LIMIT ?
  `;

  params.push(limit);

  const results = await db.prepare(sql).bind(...params).all<RecentActivityRow>();

  return Response.json({ result: results.results });
}

async function handleGetLiveStats(db: D1Database): Promise<Response> {
  // session_records uses last_message_at instead of ended_at.
  // tokens_last_hour sums total_tokens (input + cached + output + reasoning),
  // the same definition every other aggregate uses. requests_last_hour counts
  // usage buckets, not individual requests: the bucket grain collapses events,
  // so the value is a lower bound on requests, not an exact count.
  //
  // `recent` folds the last hour at the same bucket grain in one pass. The
  // drei separate references to `usage_totals` would each re-materialise a
  // view that groups the entire history before the predicate applies.
  const sql = `
    WITH recent AS (
      SELECT user_id, device_id, source, model, hour_start, SUM(total_tokens) AS total_tokens
      FROM usage_bases
      WHERE (event_id = '' OR total_tokens > 0)
        AND julianday(hour_start) >= julianday('now', '-1 hour')
      GROUP BY user_id, device_id, source, model, hour_start
    )
    SELECT
      (SELECT COUNT(*) FROM session_records WHERE julianday(last_message_at) >= julianday('now', '-30 minutes')) AS active_sessions,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM recent) AS tokens_last_hour,
      (SELECT COUNT(*) FROM recent) AS requests_last_hour,
      (SELECT COUNT(DISTINCT user_id) FROM recent) AS unique_users_last_hour
  `;

  const result = await db.prepare(sql).first<LiveStatsRow>();

  return Response.json({ result: result });
}

async function handleGetUserLiveStats(
  req: GetUserLiveStatsRequest,
  db: D1Database
): Promise<Response> {
  if (!req.userId) {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  // session_records uses last_message_at instead of ended_at.
  // tokens_last_hour sums total_tokens for the same definition as everywhere
  // else; requests_last_hour counts usage buckets (a lower bound).
  const sql = `
    WITH recent AS (
      SELECT user_id, device_id, source, model, hour_start, SUM(total_tokens) AS total_tokens
      FROM usage_bases
      WHERE user_id = ?
        AND (event_id = '' OR total_tokens > 0)
        AND julianday(hour_start) >= julianday('now', '-1 hour')
      GROUP BY user_id, device_id, source, model, hour_start
    )
    SELECT
      (SELECT COUNT(*) FROM session_records WHERE user_id = ? AND julianday(last_message_at) >= julianday('now', '-30 minutes')) AS active_sessions,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM recent) AS tokens_last_hour,
      (SELECT COUNT(*) FROM recent) AS requests_last_hour
  `;

  const result = await db
    .prepare(sql)
    .bind(req.userId, req.userId)
    .first<{
      active_sessions: number;
      tokens_last_hour: number;
      requests_last_hour: number;
    }>();

  return Response.json({ result: result });
}

async function handlePing(db: D1Database): Promise<Response> {
  await db.prepare("SELECT 1").first();
  return Response.json({ result: { ok: true } });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleLiveRpc(
  request: LiveRpcRequest,
  db: D1Database
): Promise<Response> {
  switch (request.method) {
    case "live.getActiveSessions":
      return handleGetActiveSessions(request, db);
    case "live.getRecentActivity":
      return handleGetRecentActivity(request, db);
    case "live.getStats":
      return handleGetLiveStats(db);
    case "live.getUserStats":
      return handleGetUserLiveStats(request, db);
    case "live.ping":
      return handlePing(db);
    default:
      return Response.json(
        { error: `Unknown live method: ${(request as { method: string }).method}` },
        { status: 400 }
      );
  }
}
