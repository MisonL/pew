import { describe, expect, it } from "vitest";
import { buildSeasonPatch, type SeasonEditSeason, type SeasonEditValues } from "./season-edit-payload";

const season: SeasonEditSeason = {
  name: "Season 1",
  start_date: "2026-12-01T00:00:00Z",
  end_date: "2026-12-31T00:00:00Z",
  allow_late_registration: false,
  allow_roster_changes: false,
  allow_late_withdrawal: false,
};

// datetime-local values are local wallclock; build them from local components
// so the round trip is timezone-independent.
const localFor = (utc: string): string => {
  const d = new Date(utc);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function values(overrides: Partial<SeasonEditValues> = {}): SeasonEditValues {
  return {
    name: season.name,
    startDate: localFor(season.start_date),
    endDate: localFor(season.end_date),
    allowLateRegistration: false,
    allowRosterChanges: false,
    allowLateWithdrawal: false,
    ...overrides,
  };
}

describe("buildSeasonPatch", () => {
  it("does not write an untouched toggle whose stale local value differs from a refreshed prop", () => {
    // Another admin enabled roster changes while this form was open; SWR
    // revalidated and the prop is now true while local state is still false.
    const refreshed = { ...season, allow_roster_changes: true };
    const payload = buildSeasonPatch(refreshed, values({ name: "Season 1 renamed" }), new Set(), true);
    expect(payload).toEqual({ name: "Season 1 renamed" });
  });

  it("includes a toggle the operator actually changed", () => {
    const payload = buildSeasonPatch(season, values({ allowLateWithdrawal: true }),
      new Set(["allow_late_withdrawal"] as const), true);
    expect(payload).toEqual({ allow_late_withdrawal: true });
  });

  it("omits a touched toggle that matches the current server value", () => {
    const refreshed = { ...season, allow_roster_changes: true };
    const payload = buildSeasonPatch(refreshed, values({ allowRosterChanges: true }),
      new Set(["allow_roster_changes"] as const), true);
    expect(payload).toEqual({});
  });

  it("keeps the name and upcoming-date diffs", () => {
    const payload = buildSeasonPatch(season,
      values({ name: "  Season 2  ", startDate: "2026-12-02T00:00" }), new Set(), true);
    expect(payload.name).toBe("Season 2");
    expect(payload).toHaveProperty("start_date");
    expect(payload).not.toHaveProperty("end_date");
  });

  it("ignores date edits once the season is not upcoming", () => {
    const payload = buildSeasonPatch(season, values({ startDate: "2026-12-02T00:00" }), new Set(), false);
    expect(payload).toEqual({});
  });
});
