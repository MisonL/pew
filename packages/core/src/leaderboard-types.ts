export interface LeaderboardFilters {
  fromDate?: string;
  teamId?: string;
  orgId?: string;
  source?: string;
  model?: string;
}

export interface LeaderboardSnapshotRow {
  user_id: string;
  name: string | null;
  nickname: string | null;
  image: string | null;
  slug: string | null;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  teams: { id: string; name: string; logoUrl: string | null }[];
  session_count: number | null;
  total_duration_seconds: number | null;
}

export interface LeaderboardSnapshot {
  key: string;
  revision: string;
  id: string;
  generatedAt: number;
  expiresAt: number;
  rows: LeaderboardSnapshotRow[];
}
