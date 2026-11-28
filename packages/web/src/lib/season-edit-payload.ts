import { localDatetimeValueToUtc } from "./date-helpers";

/** The season fields the inline edit form can change. */
export interface SeasonEditSeason {
  name: string;
  start_date: string;
  end_date: string;
  allow_late_registration: boolean;
  allow_roster_changes: boolean;
  allow_late_withdrawal: boolean;
}

/** What the form currently holds, in the same shapes the inputs use. */
export interface SeasonEditValues {
  name: string;
  /** datetime-local value (local wallclock). */
  startDate: string;
  endDate: string;
  allowLateRegistration: boolean;
  allowRosterChanges: boolean;
  allowLateWithdrawal: boolean;
}

export type SeasonToggleField =
  | "allow_late_registration"
  | "allow_roster_changes"
  | "allow_late_withdrawal";

const TOGGLES: ReadonlyArray<[SeasonToggleField, (v: SeasonEditValues) => boolean]> = [
  ["allow_late_registration", (v) => v.allowLateRegistration],
  ["allow_roster_changes", (v) => v.allowRosterChanges],
  ["allow_late_withdrawal", (v) => v.allowLateWithdrawal],
];

/**
 * Diff the edit form against the season it was opened from.
 *
 * Toggles are included only when the operator actually touched them. The
 * season prop updates whenever SWR revalidates (a reconnect, another admin's
 * save), while the form's local toggle state is initialized once — diffing
 * against the moving prop turned every stale local value into a "change" and
 * an operator who only retyped the name silently reverted another admin's
 * toggle. Name and dates stay value-diffs: they are single inputs whose local
 * state tracks its own edits, and a stale name would be visibly wrong.
 */
export function buildSeasonPatch(
  season: SeasonEditSeason,
  values: SeasonEditValues,
  touched: ReadonlySet<SeasonToggleField>,
  isUpcoming: boolean,
): Record<string, string | boolean> {
  const payload: Record<string, string | boolean> = {};
  if (values.name.trim() !== season.name) payload.name = values.name.trim();
  if (isUpcoming && localDatetimeValueToUtc(values.startDate) !== season.start_date) {
    payload.start_date = localDatetimeValueToUtc(values.startDate);
  }
  if (isUpcoming && localDatetimeValueToUtc(values.endDate) !== season.end_date) {
    payload.end_date = localDatetimeValueToUtc(values.endDate);
  }
  for (const [field, read] of TOGGLES) {
    const value = read(values);
    if (touched.has(field) && value !== season[field]) payload[field] = value;
  }
  return payload;
}
