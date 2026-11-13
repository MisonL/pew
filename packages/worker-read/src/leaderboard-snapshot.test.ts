import { describe, it, expect, vi } from "vitest";
import { invalidateLeaderboard, getLeaderboardRevision } from "./leaderboard-snapshot";

/**
 * The revision must move through the counter that every replica evaluates to
 * the same value. `randomblob()` is the one construct migration 030 removed
 * for exactly this reason: rqlite replays statements per replica and each one
 * re-evaluates the random value, so replicas disagree and the cached key
 * `lb:v1:{revision}:{key}` stops hitting on most of them.
 */

describe("invalidateLeaderboard", () => {
  function mockDb() {
    const batch = vi.fn(async (_stmts: unknown[]) => [] as unknown[]);
    const prepare = vi.fn((_sql: string) => ({ run: vi.fn(), first: vi.fn() }));
    return { db: { prepare, batch } as never, prepare, batch };
  }

  it("advances the deterministic counter instead of generating a random blob", async () => {
    const { db, prepare } = mockDb();
    await invalidateLeaderboard(db);

    const sql = prepare.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).not.toMatch(/randomblob/i);
    expect(sql).toMatch(/leaderboard_revision_seq\s+SET\s+n\s*=\s*n\s*\+\s*1/i);
    expect(sql).toMatch(/printf\('%032x'/i);
  });

  it("commits both statements in one batch so the pair cannot split", async () => {
    // A seq row that moved without the revision (or the reverse) would let the
    // next trigger emit a value lower than a cache key already in use.
    const { db, batch } = mockDb();
    await invalidateLeaderboard(db);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
  });
});

describe("getLeaderboardRevision", () => {
  it("rejects a revision that is not 32 lowercase hex characters", async () => {
    const db = {
      prepare: vi.fn(() => ({
        first: vi.fn().mockResolvedValue({ revision: "not-hex" }),
      })),
    };
    await expect(getLeaderboardRevision(db as never)).rejects.toThrow(
      "Leaderboard revision unavailable",
    );
  });
});
