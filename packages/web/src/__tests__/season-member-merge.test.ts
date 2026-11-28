import { describe, expect, it } from "vitest";
import { mergeSeasonMembers, readTeamMembers, shouldAutoLoadMembers } from "@/lib/season-leaderboard";

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

describe("readTeamMembers", () => {
  it("returns the member list for the requested team", () => {
    const json = {
      entries: [
        { team: { id: "t1" }, members: [{ user_id: "u1" }] },
        { team: { id: "t2" }, members: [{ user_id: "u2" }] },
      ],
    };
    expect(readTeamMembers(json, "t2")).toEqual([{ user_id: "u2" }]);
  });

  it("keeps a genuinely empty member list distinct from a missing one", () => {
    // An empty array is the API's answer for a team with no public members;
    // rendering "No members to display" for it is correct.
    const json = { entries: [{ team: { id: "t1" }, members: [] }] };
    expect(readTeamMembers(json, "t1")).toEqual([]);
  });

  it("returns null when the team is absent from the response", () => {
    // A 200 whose entries no longer include the team (dropped from the
    // standings between page load and expand) says nothing about its members.
    const json = { entries: [{ team: { id: "t9" }, members: [] }] };
    expect(readTeamMembers(json, "t1")).toBeNull();
  });

  it("returns null when the entry carries no members field", () => {
    // expand=members was lost somewhere upstream; the response is not an
    // answer to "who is on this team".
    const json = { entries: [{ team: { id: "t1" } }] };
    expect(readTeamMembers(json, "t1")).toBeNull();
  });
});


describe("shouldAutoLoadMembers", () => {
  const base = { expanded: true, hasMembers: false, loading: false, failed: false, loaded: false };

  it("loads an expanded row whose members were never fetched for this season", () => {
    // The row stayed expanded across a season switch; the hook cleared the
    // member cache, so without this the row claims "No members to display".
    expect(shouldAutoLoadMembers(base)).toBe(true);
  });

  it("does not refetch a loaded-but-empty team in a loop", () => {
    expect(shouldAutoLoadMembers({ ...base, loaded: true })).toBe(false);
  });

  it("does not load while loading, after a failure, when collapsed, or with members present", () => {
    expect(shouldAutoLoadMembers({ ...base, loading: true })).toBe(false);
    expect(shouldAutoLoadMembers({ ...base, failed: true })).toBe(false);
    expect(shouldAutoLoadMembers({ ...base, expanded: false })).toBe(false);
    expect(shouldAutoLoadMembers({ ...base, hasMembers: true })).toBe(false);
  });
});
