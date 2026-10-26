/**
 * Optimistic season-registration state.
 *
 * The hook keeps a per-season override of the *result* (registered or not),
 * never a fixed ±1 delta: a delta drifted whenever the server state moved
 * underneath it — register → withdraw left the count at base − 1, and a focus
 * revalidation that already included the registration counted it twice. The
 * displayed count is derived by comparing the override with the server's
 * current registration state, so it converges as soon as the two agree.
 */

export type SeasonOverrideState = ReadonlyMap<string, boolean>;

export function applySeasonOverrides<T extends { id: string; team_count: number }>(
  seasons: readonly T[],
  registeredIds: ReadonlySet<string>,
  overrides: SeasonOverrideState,
): Array<T & { is_registered: boolean }> {
  return seasons.map((season) => {
    const baseRegistered = registeredIds.has(season.id);
    const is_registered = overrides.get(season.id) ?? baseRegistered;
    const delta = is_registered === baseRegistered ? 0 : is_registered ? 1 : -1;
    return { ...season, is_registered, team_count: season.team_count + delta };
  });
}
