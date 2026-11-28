/**
 * Merge lazily fetched season-leaderboard member lists into team entries.
 *
 * The main leaderboard response only carries members under
 * `expand=members`, so any revalidation (window focus, refetch) replaces
 * every entry with a member-less row. Keeping the fetched members outside
 * the SWR payload and re-applying them here means expanded teams survive
 * those revalidations instead of disappearing until a full page reload.
 */
export function mergeSeasonMembers<T extends { team: { id: string }; members?: M[] }, M>(
  entries: readonly T[],
  membersByTeam: ReadonlyMap<string, M[]>,
): T[] {
  if (membersByTeam.size === 0) return entries as T[];
  return entries.map((entry) => {
    const members = membersByTeam.get(entry.team.id);
    return members ? { ...entry, members } : entry;
  });
}

/**
 * Read one team's member list out of a members-expanded leaderboard response.
 *
 * Returns `null` when the response answers nothing about that team: the team
 * is missing from `entries` (dropped from the standings between page load and
 * expand) or the entry carries no `members` field (expand=members was lost
 * upstream). A `[]` is kept distinct — that is the API's answer for a team
 * with no public members, and "No members to display" is the correct claim
 * for it. The caller must not render an empty list for `null`; that would
 * turn "could not verify" into "there are none".
 */
export function readTeamMembers<M>(
  json: { entries: ReadonlyArray<{ team: { id: string }; members?: M[] }> },
  teamId: string,
): M[] | null {
  const entry = json.entries.find((e) => e.team.id === teamId);
  return entry?.members ?? null;
}

/**
 * Whether an expanded team row should (re)load its members.
 *
 * A row keeps its `expanded` state across a season switch (the key is the
 * team id), but the hook clears the member cache for the new season, so the
 * expanded row had no members, was not loading and was not failed — it
 * rendered "No members to display" for a team whose members were simply
 * never fetched for this season, and nothing would fetch them until the user
 * collapsed and re-expanded. `loaded` marks a team whose fetch answered
 * (including an empty answer), so an actually empty team does not refetch in
 * a loop.
 */
export function shouldAutoLoadMembers(state: {
  expanded: boolean;
  hasMembers: boolean;
  loading: boolean;
  failed: boolean;
  loaded: boolean;
}): boolean {
  return state.expanded && !state.hasMembers && !state.loading && !state.failed && !state.loaded;
}

