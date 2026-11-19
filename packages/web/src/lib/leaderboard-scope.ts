// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/** Scope selection: global, or org/team with ID */
export interface ScopeSelection {
  type: "global" | "org" | "team";
  id?: string;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

export const SCOPE_STORAGE_KEY = "pew:leaderboard:scope";

export function loadScopeFromStorage(): ScopeSelection | null {
  try {
    const stored = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as ScopeSelection;
    if (parsed.type === "global" || ((parsed.type === "org" || parsed.type === "team") && parsed.id)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveScopeToStorage(scope: ScopeSelection): void {
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(scope));
  } catch {
    // Silently fail
  }
}

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

/**
 * Resolve the stored scope against the memberships that actually loaded.
 *
 * The org/team lists are the evidence for "this scope is still valid". When
 * the memberships request FAILS both lists are empty, and an empty list cannot
 * tell "you left that team" from "we could not ask" — validating against it
 * silently downgraded a team-scoped board to the global one, and the scope
 * dropdown vanished because it renders nothing for two empty lists. The caller
 * passes `unavailable` (the membership request failed) so the scope is left
 * as stored and the caller can say why, instead of pretending the selection
 * was revoked.
 */
export interface ResolvedScope {
  scope: ScopeSelection;
  /**
   * True when the stored scope was kept because memberships could not be
   * loaded. The scope is unverified, not invalid; callers surface this.
   */
  unverified: boolean;
}

export function resolveScope(
  rawScope: ScopeSelection,
  organizations: readonly { id: string }[],
  teams: readonly { id: string }[],
  membershipsUnavailable: boolean,
): ResolvedScope {
  if (rawScope.type === "global") return { scope: rawScope, unverified: false };
  if (membershipsUnavailable) return { scope: rawScope, unverified: true };
  if (rawScope.type === "org" && rawScope.id) {
    return organizations.some((o) => o.id === rawScope.id)
      ? { scope: rawScope, unverified: false }
      : { scope: { type: "global" }, unverified: false };
  }
  if (rawScope.type === "team" && rawScope.id) {
    return teams.some((t) => t.id === rawScope.id)
      ? { scope: rawScope, unverified: false }
      : { scope: { type: "global" }, unverified: false };
  }
  return { scope: rawScope, unverified: false };
}
