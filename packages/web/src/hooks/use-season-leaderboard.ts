"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { SeasonStatus } from "@pew/core";
import { fetcher } from "@/lib/fetcher";
import { mergeSeasonMembers } from "@/lib/season-leaderboard";

export interface SeasonTeamEntry {
  rank: number;
  team: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
  };
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  session_count: number;
  total_duration_seconds: number;
  members?: SeasonMember[];
}

export interface SeasonMember {
  user_id: string;
  slug: string | null;
  name: string;
  image: string | null;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  session_count: number;
  total_duration_seconds: number;
}

interface SeasonLeaderboardData {
  season: {
    id: string;
    name: string;
    slug: string;
    start_date: string;
    end_date: string;
    status: SeasonStatus;
    is_snapshot: boolean;
  };
  entries: SeasonTeamEntry[];
}

interface UseSeasonLeaderboardResult {
  data: SeasonLeaderboardData | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
  /** Load members for a specific team (lazy, on-demand) */
  loadTeamMembers: (teamId: string) => Promise<void>;
  /** Set of team IDs currently loading members */
  loadingTeamIds: Set<string>;
}

export function useSeasonLeaderboard(
  seasonIdOrSlug: string | null,
): UseSeasonLeaderboardResult {
  const key = seasonIdOrSlug ? `/api/seasons/${seasonIdOrSlug}/leaderboard` : null;
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<SeasonLeaderboardData>(key, fetcher);

  // Lazily fetched member lists live here, NOT in the SWR payload: the main
  // key revalidates on window focus and its response never contains members
  // (the API only adds them under expand=members), so storing them in `data`
  // meant a focus revalidation wiped every expanded team and the old
  // fetched-teams ref then refused to load them again until a page reload.
  const [membersByTeam, setMembersByTeam] = useState<Map<string, SeasonMember[]>>(
    new Map(),
  );
  const loadingTeamIdsRef = useRef<Set<string>>(new Set());
  const [loadingTeamIds, setLoadingTeamIds] = useState<Set<string>>(new Set());

  // Reset the lazy-member cache when the season changes: team IDs fetched in
  // season A must not satisfy season B (and must not pin A's member data).
  useEffect(() => {
    setMembersByTeam(new Map());
    loadingTeamIdsRef.current = new Set();
    setLoadingTeamIds(new Set());
    // The season key is the reset trigger; it is intentionally not read in
    // the body, so reference it to keep the dependency honest.
    void seasonIdOrSlug;
  }, [seasonIdOrSlug]);

  const loadTeamMembers = useCallback(
    async (teamId: string) => {
      if (!seasonIdOrSlug) return;
      if (membersByTeam.has(teamId) || loadingTeamIdsRef.current.has(teamId)) {
        return;
      }

      loadingTeamIdsRef.current.add(teamId);
      setLoadingTeamIds((prev) => new Set(prev).add(teamId));

      try {
        const res = await fetch(
          `/api/seasons/${seasonIdOrSlug}/leaderboard?expand=members&team=${teamId}`,
        );

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const json = (await res.json()) as SeasonLeaderboardData;
        const teamWithMembers = json.entries.find((e) => e.team.id === teamId);

        if (teamWithMembers?.members) {
          const members = teamWithMembers.members;
          setMembersByTeam((prev) => new Map(prev).set(teamId, members));
        }
      } catch {
        // Silently fail — user can retry by collapsing/expanding again
      } finally {
        loadingTeamIdsRef.current.delete(teamId);
        setLoadingTeamIds((prev) => {
          const next = new Set(prev);
          next.delete(teamId);
          return next;
        });
      }
    },
    [seasonIdOrSlug, membersByTeam],
  );

  // Merge the lazily fetched members into every response — including the
  // member-less ones a focus revalidation produces.
  const mergedData = useMemo(() => {
    if (!data) return null;
    return {
      ...data,
      entries: mergeSeasonMembers(data.entries, membersByTeam),
    };
  }, [data, membersByTeam]);

  return {
    data: mergedData,
    loading: isLoading,
    refreshing: isValidating && !isLoading,
    error: error ? (error instanceof Error ? error.message : String(error)) : null,
    refetch: () => {
      setMembersByTeam(new Map());
      void mutate();
    },
    loadTeamMembers,
    loadingTeamIds,
  };
}
