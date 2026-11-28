"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { SeasonStatus } from "@pew/core";
import { fetcher } from "@/lib/fetcher";
import { mergeSeasonMembers, readTeamMembers } from "@/lib/season-leaderboard";

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
  /** Teams whose member fetch failed; "no members" and "load failed" differ */
  failedTeamIds: Set<string>;
  /** Teams whose member fetch answered (including an empty list) */
  loadedTeamIds: Set<string>;
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
  const [failedTeamIds, setFailedTeamIds] = useState<Set<string>>(new Set());

  // Reset the lazy-member cache when the season changes: team IDs fetched in
  // season A must not satisfy season B (and must not pin A's member data).
  // Failures reset with it — a team row keeps its expanded state across the
  // slug change (same key), so a stale "could not load" would outlive the
  // season whose request produced it.
  useEffect(() => {
    setMembersByTeam(new Map());
    loadingTeamIdsRef.current = new Set();
    setLoadingTeamIds(new Set());
    setFailedTeamIds(new Set());
    // The season key is the reset trigger; it is intentionally not read in
    // the body, so reference it to keep the dependency honest.
    void seasonIdOrSlug;
  }, [seasonIdOrSlug]);

  // Guards against a stale response: user expands a team in season A, then
  // switches to season B before A's members fetch lands. The reset effect
  // clears membersByTeam on season change, but the stale A response writes
  // back after the clear, corrupting B's roster for that team.
  const requestedSeasonRef = useRef<string | null>(null);
  useEffect(() => {
    requestedSeasonRef.current = seasonIdOrSlug;
  }, [seasonIdOrSlug]);

  const loadTeamMembers = useCallback(
    async (teamId: string) => {
      if (!seasonIdOrSlug) return;
      const requestedSeason = seasonIdOrSlug;
      if (membersByTeam.has(teamId) || loadingTeamIdsRef.current.has(teamId)) {
        return;
      }

      loadingTeamIdsRef.current.add(teamId);
      setLoadingTeamIds((prev) => new Set(prev).add(teamId));

      try {
        const res = await fetch(
          `/api/seasons/${requestedSeason}/leaderboard?expand=members&team=${teamId}`,
        );

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const json = (await res.json()) as SeasonLeaderboardData;

        if (requestedSeasonRef.current === requestedSeason) {
          const members = readTeamMembers(json, teamId);
          if (members) {
            setMembersByTeam((prev) => new Map(prev).set(teamId, members));
            setFailedTeamIds((prev) => {
              if (!prev.has(teamId)) return prev;
              const next = new Set(prev);
              next.delete(teamId);
              return next;
            });
          } else {
            // A 200 that says nothing about this team's members (team no
            // longer in the standings, expand=members lost upstream) is not
            // "the team has no members". Leaving it neither loaded nor failed
            // made the row claim "No members to display" for a question the
            // server never answered; mark it failed so the row says so and
            // offers a retry.
            setFailedTeamIds((prev) => new Set(prev).add(teamId));
          }
        }
      } catch {
        // Remember the failure: rendering "No members to display" for a team
        // whose member request 500'd is a lie the user cannot tell apart from
        // an actually empty team. The row offers a retry instead.
        setFailedTeamIds((prev) => new Set(prev).add(teamId));
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

  const loadedTeamIds = useMemo(() => new Set(membersByTeam.keys()), [membersByTeam]);

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
    failedTeamIds,
    loadedTeamIds,
  };
}
