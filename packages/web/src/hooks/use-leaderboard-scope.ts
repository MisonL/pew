"use client";

import { useCallback, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  loadScopeFromStorage,
  saveScopeToStorage,
  resolveScope,
  type ScopeSelection,
  type Organization,
  type Team,
  type ResolvedScope,
} from "@/lib/leaderboard-scope";

export interface UseLeaderboardScopeReturn {
  /** Current scope selection */
  scope: ScopeSelection;
  /** Update scope and persist to localStorage */
  setScope: (scope: ScopeSelection) => void;
  /** User's organizations */
  organizations: Organization[];
  /** User's teams */
  teams: Team[];
  /** Whether scope initialization is complete (ready to fetch leaderboard) */
  scopeInitialized: boolean;
  /** Whether orgs/teams have been loaded */
  orgsLoaded: boolean;
  /** Whether session is still loading */
  isSessionLoading: boolean;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Computed teamId for useLeaderboard */
  teamId: string | null;
  /** Computed orgId for useLeaderboard */
  orgId: string | null;
  /**
   * True when the stored org/team scope is still selected but the membership
   * lists that would validate it failed to load. The board is showing that
   * scope unverified; callers surface it rather than silently showing global.
   */
  scopeUnverified: boolean;
}

interface OrgsResponse {
  organizations?: Organization[];
}

interface TeamsResponse {
  teams?: Team[];
}

export function useLeaderboardScope(): UseLeaderboardScopeReturn {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const isSessionLoading = status === "loading";

  // Lazy initializer reads localStorage once on mount — no effect needed.
  const [rawScope, setRawScope] = useState<ScopeSelection>(() => {
    if (typeof window === "undefined") return { type: "global" };
    return loadScopeFromStorage() ?? { type: "global" };
  });

  const orgsKey = isAuthenticated ? "/api/organizations/mine" : null;
  const teamsKey = isAuthenticated ? "/api/teams" : null;

  const { data: orgsData, isLoading: orgsLoading, error: orgsError } =
    useSWR<OrgsResponse>(orgsKey, fetcher);
  const { data: teamsData, isLoading: teamsLoading, error: teamsError } =
    useSWR<TeamsResponse>(teamsKey, fetcher);

  const organizations = useMemo(() => orgsData?.organizations ?? [], [orgsData]);
  const teams = useMemo(() => teamsData?.teams ?? [], [teamsData]);

  // A failed membership request makes both lists empty, which is not evidence
  // that the stored org/team scope is gone. Without this flag the validation
  // below downgraded the board to global and the scope dropdown disappeared —
  // a failure indistinguishable from "you are in no teams".
  const membershipsFailed = isAuthenticated && (Boolean(orgsError) || Boolean(teamsError));

  // orgsLoaded: authenticated → orgs + teams fetch settled (success or error); unauthenticated → immediately true
  const orgsLoaded = isAuthenticated
    ? (!orgsLoading && !teamsLoading) || Boolean(orgsError) || Boolean(teamsError)
    : !isSessionLoading;

  const scopeInitialized = isSessionLoading ? false : isAuthenticated ? orgsLoaded : true;

  // Derived, validated scope: drops back to global when stored id is no longer valid.
  // When unauthenticated, always force global — localStorage may contain stale org/team scope.
  const resolved = useMemo<ResolvedScope>(() => {
    if (!isAuthenticated) return { scope: { type: "global" }, unverified: false };
    if (!scopeInitialized) return { scope: rawScope, unverified: false };
    return resolveScope(rawScope, organizations, teams, membershipsFailed);
  }, [rawScope, scopeInitialized, isAuthenticated, organizations, teams, membershipsFailed]);
  const scope = resolved.scope;

  const setScope = useCallback((newScope: ScopeSelection) => {
    setRawScope(newScope);
    saveScopeToStorage(newScope);
  }, []);

  const teamId = scope.type === "team" ? scope.id ?? null : null;
  const orgId = scope.type === "org" ? scope.id ?? null : null;

  return {
    scope,
    setScope,
    organizations,
    teams,
    scopeInitialized,
    orgsLoaded,
    isSessionLoading,
    isAuthenticated,
    teamId,
    orgId,
    scopeUnverified: resolved.unverified,
  };
}
