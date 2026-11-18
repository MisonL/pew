/**
 * "The list failed to load" is not "the list is empty".
 *
 * Several pages derive their list as `data?.rows ?? []` and then branch on
 * `length === 0` to show an empty state. When the request fails, that branch
 * renders "You're not in any teams yet" / "No members yet" for a user or an
 * organization that has them — the failure is invisible and indistinguishable
 * from real absence. Callers ask this instead of guessing from `length`.
 */
export function failedToLoad(data: unknown, error: unknown): boolean {
  return data === undefined && error !== undefined && error !== null;
}
