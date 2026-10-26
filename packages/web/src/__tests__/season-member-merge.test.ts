import { describe, expect, it } from "vitest";
import { mergeSeasonMembers } from "@/lib/season-leaderboard";

interface Entry {
  rank: number;
  team: { id: string; name: string };
  total_tokens: number;
  members?: Array<{ user_id: string }>;
}

describe("mergeSeasonMembers", () => {
  it("merges cached members into matching entries", () => {
    const entries: Entry[] = [
      { rank: 1, team: { id: "t1", name: "Alpha" }, total_tokens: 100 },
    ];
    const members = new Map([["t1", [{ user_id: "u1" }]]]);

    const out = mergeSeasonMembers(entries, members);

    expect(out[0]!.members).toEqual([{ user_id: "u1" }]);
    // Everything else is preserved.
    expect(out[0]!.total_tokens).toBe(100);
  });

  it("restores members wiped by a member-less revalidation", () => {
    // The leaderboard API only includes members under expand=members, so a
    // focus revalidation replaces every entry with a member-less row. The
    // cached members must come back.
    const entries: Entry[] = [
      { rank: 1, team: { id: "t1", name: "Alpha" }, total_tokens: 100 },
      { rank: 2, team: { id: "t2", name: "Beta" }, total_tokens: 50 },
    ];
    const members = new Map([["t1", [{ user_id: "u1" }]]]);

    const out = mergeSeasonMembers(entries, members);

    expect(out[0]!.members).toEqual([{ user_id: "u1" }]);
    expect(out[1]!.members).toBeUndefined();
  });

  it("returns the input untouched when nothing is cached", () => {
    const entries: Entry[] = [
      { rank: 1, team: { id: "t1", name: "Alpha" }, total_tokens: 100 },
    ];
    expect(mergeSeasonMembers(entries, new Map())).toBe(entries);
  });
});
