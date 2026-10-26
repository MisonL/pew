import { describe, expect, it } from "vitest";
import { applySeasonOverrides } from "@/lib/season-registration";

interface Season {
  id: string;
  team_count: number;
}

const REGISTERED = new Set(["s-registered"]);

describe("applySeasonOverrides", () => {
  it("leaves server state untouched without an override", () => {
    const seasons: Season[] = [
      { id: "s-open", team_count: 3 },
      { id: "s-registered", team_count: 5 },
    ];
    const out = applySeasonOverrides(seasons, REGISTERED, new Map());
    expect(out.map((s) => [s.id, s.is_registered, s.team_count])).toEqual([
      ["s-open", false, 3],
      ["s-registered", true, 5],
    ]);
  });

  it("registers optimistically: flag flips and the count moves by one", () => {
    const out = applySeasonOverrides(
      [{ id: "s-open", team_count: 3 }],
      REGISTERED,
      new Map([["s-open", true]]),
    );
    expect(out[0]!.is_registered).toBe(true);
    expect(out[0]!.team_count).toBe(4);
  });

  it("register → withdraw leaves the server count untouched", () => {
    // The stored override is the last action's result, not an accumulated
    // delta: after withdrawing, the season is back to its unregistered
    // server state and the count must not read base − 1.
    const out = applySeasonOverrides(
      [{ id: "s-open", team_count: 3 }],
      REGISTERED,
      new Map([["s-open", false]]),
    );
    expect(out[0]!.is_registered).toBe(false);
    expect(out[0]!.team_count).toBe(3);
  });

  it("does not double-count after a revalidation already includes the registration", () => {
    // Focus revalidation refreshed team_count to 4 and the registered ids, so
    // the override now agrees with the server: no further adjustment.
    const out = applySeasonOverrides(
      [{ id: "s-registered", team_count: 4 }],
      REGISTERED,
      new Map([["s-registered", true]]),
    );
    expect(out[0]!.is_registered).toBe(true);
    expect(out[0]!.team_count).toBe(4);
  });

  it("withdraws optimistically from a registered season", () => {
    const out = applySeasonOverrides(
      [{ id: "s-registered", team_count: 5 }],
      REGISTERED,
      new Map([["s-registered", false]]),
    );
    expect(out[0]!.is_registered).toBe(false);
    expect(out[0]!.team_count).toBe(4);
  });
});
