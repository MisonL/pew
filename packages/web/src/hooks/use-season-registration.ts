"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import type { SeasonStatus } from "@pew/core";
import { throwApiError } from "@/lib/api-error";
import { toErrorMessage } from "@/lib/error-message";
import { fetcher } from "@/lib/fetcher";
import { applySeasonOverrides, registrationErrorMessage } from "@/lib/season-registration";

export interface AvailableSeason {
  id: string;
  name: string;
  slug: string;
  start_date: string;
  end_date: string;
  status: SeasonStatus;
  team_count: number;
  is_registered: boolean;
  allow_late_registration: boolean;
  allow_late_withdrawal: boolean;
}

interface UseSeasonRegistrationOptions {
  teamId: string;
}

/**
 * Result of a register/withdraw call. The error travels with the result
 * because hook state read from the caller's closure right after `await` is
 * always the previous render's value — the caller used to fall back to a
 * generic "Registration failed" even when the server said why.
 */
export type SeasonMutationResult =
  | { ok: true }
  | { ok: false; error: string };

interface UseSeasonRegistrationResult {
  seasons: AvailableSeason[];
  loading: boolean;
  error: string | null;
  register: (seasonId: string) => Promise<SeasonMutationResult>;
  withdraw: (seasonId: string) => Promise<SeasonMutationResult>;
  refetch: () => void;
}

interface SeasonsResponse {
  seasons: Array<{
    id: string;
    name: string;
    slug: string;
    start_date: string;
    end_date: string;
    status: SeasonStatus;
    team_count: number;
    allow_late_registration: boolean;
    allow_late_withdrawal: boolean;
  }>;
}

interface TeamResponse {
  registered_season_ids?: string[];
}

export function useSeasonRegistration(
  options: UseSeasonRegistrationOptions,
): UseSeasonRegistrationResult {
  const { teamId } = options;

  const {
    data: seasonsData,
    error: seasonsError,
    isLoading: seasonsLoading,
    mutate: mutateSeasons,
  } = useSWR<SeasonsResponse>("/api/seasons", fetcher);

  const {
    data: teamData,
    error: teamError,
    isLoading: teamLoading,
    mutate: mutateTeam,
  } = useSWR<TeamResponse>(`/api/teams/${teamId}`, fetcher);

  // Override = the result of the last successful action, per season. See
  // lib/season-registration.ts for why a fixed ±1 delta drifted.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [mutationError, setMutationError] = useState<string | null>(null);

  const seasons = useMemo<AvailableSeason[]>(() => {
    if (!seasonsData) return [];
    const registeredIds = new Set(teamData?.registered_season_ids ?? []);
    const visible = seasonsData.seasons.filter(
      (s) => s.status === "upcoming" || s.status === "active",
    );
    return applySeasonOverrides(visible, registeredIds, overrides);
  }, [seasonsData, teamData, overrides]);

  const refetch = useCallback(() => {
    setOverrides(new Map());
    void mutateSeasons();
    void mutateTeam();
  }, [mutateSeasons, mutateTeam]);

  const register = useCallback(
    async (seasonId: string): Promise<SeasonMutationResult> => {
      setMutationError(null);
      try {
        const res = await fetch(`/api/seasons/${seasonId}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ team_id: teamId }),
        });
        if (!res.ok) await throwApiError(res);
        setOverrides((prev) => new Map(prev).set(seasonId, true));
        return { ok: true };
      } catch (err) {
        const message = toErrorMessage(err, "Registration failed");
        setMutationError(message);
        return { ok: false, error: message };
      }
    },
    [teamId],
  );

  const withdraw = useCallback(
    async (seasonId: string): Promise<SeasonMutationResult> => {
      setMutationError(null);
      try {
        const res = await fetch(`/api/seasons/${seasonId}/register`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ team_id: teamId }),
        });
        if (!res.ok) await throwApiError(res);
        setOverrides((prev) => new Map(prev).set(seasonId, false));
        return { ok: true };
      } catch (err) {
        const message = toErrorMessage(err, "Withdrawal failed");
        setMutationError(message);
        return { ok: false, error: message };
      }
    },
    [teamId],
  );

  // A failed team fetch leaves `teamData` undefined, so every season renders
  // as "not registered" — the wrong answer, presented confidently. Surface it
  // instead of the empty state: the caller's banner already shows `error`.
  const loadError = seasonsError ?? teamError ?? null;

  return {
    seasons,
    loading: seasonsLoading || teamLoading,
    error: registrationErrorMessage(mutationError, loadError),
    register,
    withdraw,
    refetch,
  };
}
