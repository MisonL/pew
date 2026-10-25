/**
 * Leaderboard domain RPC handlers for worker-read.
 *
 * Handles leaderboard-related read queries.
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { getLeaderboardRevision, getLeaderboardSnapshot } from "../leaderboard-snapshot";
import type { LeaderboardRpcRequest } from "./leaderboard-types";
export type * from "./leaderboard-types";

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
    case "leaderboard.getSnapshot":
      return Response.json({ result: await getLeaderboardSnapshot(request, db, kv) });
    default:
      return Response.json(
        { error: `Unknown leaderboard method: ${(request as { method: string }).method}` },
        { status: 400 }
      );
  }
}
