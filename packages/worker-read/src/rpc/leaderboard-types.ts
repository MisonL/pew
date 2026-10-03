import type { LeaderboardFilters } from "@pew/core";

/**
 * Type-only definitions for the leaderboard RPC. Extracted from
 * leaderboard.ts so the handler file stays under the 400-LOC complexity guideline.
 */

// Response Types
// ---------------------------------------------------------------------------

export interface LeaderboardEntryRow {
  user_id: string;
  name: string | null;
  image: string | null;
  total_tokens: number;
  rank: number;
}

export interface TeamLeaderboardEntryRow {
  team_id: string;
  team_name: string;
  logo_url: string | null;
  total_tokens: number;
  rank: number;
}

// ---------------------------------------------------------------------------
// RPC Request Types
// ---------------------------------------------------------------------------

export interface GetUserLeaderboardRequest {
  method: "leaderboard.getUsers";
  seasonId: string;
  limit?: number;
  offset?: number;
}

export interface GetTeamLeaderboardRequest {
  method: "leaderboard.getTeams";
  seasonId: string;
  limit?: number;
  offset?: number;
}

export interface GetUserRankRequest {
  method: "leaderboard.getUserRank";
  seasonId: string;
  userId: string;
}

export interface GetTeamRankRequest {
  method: "leaderboard.getTeamRank";
  seasonId: string;
  teamId: string;
}

export interface GetLeaderboardRevisionRequest {
  method: "leaderboard.getRevision";
}

export interface GetLeaderboardSnapshotRequest extends LeaderboardFilters {
  method: "leaderboard.getSnapshot";
}

export type LeaderboardRpcRequest =
  | GetUserLeaderboardRequest
  | GetTeamLeaderboardRequest
  | GetUserRankRequest
  | GetTeamRankRequest
  | GetLeaderboardRevisionRequest
  | GetLeaderboardSnapshotRequest;
