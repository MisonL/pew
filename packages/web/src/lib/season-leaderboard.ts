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
