/**
 * Leaderboard domain RPC handlers for worker-read.
 *
 * Handles leaderboard-related read queries.
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import type { LeaderboardFilters } from "@pew/core";
import { getLeaderboardRevision, getLeaderboardSnapshot } from "../leaderboard-snapshot";
import { isValidOptionalFilter, isWindowDate } from "./filters";
import type { LeaderboardRpcRequest } from "./leaderboard-types";
export type * from "./leaderboard-types";

// ---------------------------------------------------------------------------
// Filter extraction
// ---------------------------------------------------------------------------

/**
 * Pick only the five known filters off the request. An extra key must not
 * reach the snapshot builder — its validation runs over every own property,
 * so a stray non-string field (a client sending `traceId: 42`, a future
 * scalar the builder does not model) turned a perfectly readable leaderboard
 * into a thrown "Invalid leaderboard filter" and a 500.
 */
function extractFilters(request: Record<string, unknown>): LeaderboardFilters | null {
  const picked = {
    fromDate: request.fromDate,
    teamId: request.teamId,
    orgId: request.orgId,
    source: request.source,
    model: request.model,
  };
  if (picked.fromDate !== undefined && !isWindowDate(picked.fromDate)) return null;
  if (
    !isValidOptionalFilter(picked.teamId) ||
    !isValidOptionalFilter(picked.orgId) ||
    !isValidOptionalFilter(picked.source) ||
    !isValidOptionalFilter(picked.model)
  ) return null;
  const filters: LeaderboardFilters = {};
  if (picked.fromDate !== undefined) filters.fromDate = picked.fromDate as string;
  for (const key of ["teamId", "orgId", "source", "model"] as const) {
    const value = picked[key];
    // Empty strings would enter the cache key and the WHERE clause as a
    // never-matching filter; treat them as absent, as the web routes do.
    if (typeof value === "string" && value !== "") filters[key] = value;
  }
  return filters;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleLeaderboardRpc(
  request: LeaderboardRpcRequest,
  db: D1Database,
  kv: KVNamespace
): Promise<Response> {
  switch (request.method) {
    case "leaderboard.getRevision":
      return Response.json({ result: await getLeaderboardRevision(db) });
    case "leaderboard.getSnapshot": {
      const filters = extractFilters(request as unknown as Record<string, unknown>);
      if (filters === null) {
        return Response.json({ error: "Invalid leaderboard filter" }, { status: 400 });
      }
      return Response.json({ result: await getLeaderboardSnapshot(filters, db, kv) });
    }
    default:
      return Response.json(
        { error: `Unknown leaderboard method: ${(request as { method: string }).method}` },
        { status: 400 }
      );
  }
}
