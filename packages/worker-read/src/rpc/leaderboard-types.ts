import type { LeaderboardFilters } from "@pew/core";

/**
 * Type-only definitions for the leaderboard RPC. Extracted from
 * leaderboard.ts so the handler file stays under the 400-LOC complexity guideline.
 */

export interface GetLeaderboardRevisionRequest {
  method: "leaderboard.getRevision";
}

export interface GetLeaderboardSnapshotRequest extends LeaderboardFilters {
  method: "leaderboard.getSnapshot";
}

export type LeaderboardRpcRequest =
  | GetLeaderboardRevisionRequest
  | GetLeaderboardSnapshotRequest;
