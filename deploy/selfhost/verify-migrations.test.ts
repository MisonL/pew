import { describe, it, expect } from "vitest";
import { REVISION_PATTERN, partitionTables, schemaMismatches } from "./verify-migrations";

/**
 * Pure assertion logic behind verify-migrations.ts. The live run needs a
 * throwaway rqlite node, but the comparison and partitioning rules are the
 * parts that silently drift when a migration is added, so they are unit-tested
 * here.
 */
describe("schemaMismatches", () => {
  const expected = { upstreamTables: 22, planTables: 6, indexes: 69, triggers: 12, views: 2 };

  it("returns nothing when every count matches", () => {
    expect(schemaMismatches({ ...expected }, expected)).toEqual([]);
  });

  it("names every divergent field with both values", () => {
    const mismatches = schemaMismatches({ ...expected, planTables: 5, indexes: 70 }, expected);
    expect(mismatches).toEqual(["planTables: got 5, expected 6", "indexes: got 70, expected 69"]);
  });

  it("detects a single-field drift without reporting the matching fields", () => {
    expect(schemaMismatches({ ...expected, views: 1 }, expected)).toEqual([
      "views: got 1, expected 2",
    ]);
  });
});

describe("partitionTables", () => {
  it("splits plan tables out of the upstream census", () => {
    const names = ["users", "usage_records", "kv_cache", "instance_setup", "rate_limit_hits"];
    expect(partitionTables(names)).toEqual({ upstreamTables: 2, planTables: 3 });
  });

  it("counts zero plan tables when none are present", () => {
    expect(partitionTables(["users", "teams"])).toEqual({ upstreamTables: 2, planTables: 0 });
  });

  it("treats every declared plan table as a plan table", () => {
    const planOnly = [
      "_migrations",
      "kv_cache",
      "leaderboard_revision_seq",
      "instance_setup",
      "password_resets",
      "rate_limit_hits",
    ];
    expect(partitionTables(planOnly)).toEqual({ upstreamTables: 0, planTables: 6 });
  });
});

describe("REVISION_PATTERN", () => {
  it("accepts a 32-char lowercase hex revision", () => {
    expect(REVISION_PATTERN.test("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("rejects the wrong length, uppercase, or non-hex values", () => {
    expect(REVISION_PATTERN.test("0123456789abcdef")).toBe(false);
    expect(REVISION_PATTERN.test("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(REVISION_PATTERN.test("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
    expect(REVISION_PATTERN.test("")).toBe(false);
  });
});
