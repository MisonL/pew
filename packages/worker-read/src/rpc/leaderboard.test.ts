import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleLeaderboardRpc } from "./leaderboard";
import type { LeaderboardRpcRequest } from "./leaderboard-types";
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

// ---------------------------------------------------------------------------
// Mock D1Database
// ---------------------------------------------------------------------------

function createMockDb() {
  return {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    // getLeaderboardSnapshot builds through one batch: revision, totals, team
    // membership, session counts. The first statement's row must match what
    // `first` reports for the revision, or the build is retried and thrown.
    batch: vi.fn(async (statements: unknown[]) =>
      statements.map((_s, i) => ({ success: true, results: i === 0 ? [{ revision: "a".repeat(32) }] : [] }))),
  } as unknown as D1Database & {
    prepare: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
    first: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
    batch: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Mock KVNamespace
// ---------------------------------------------------------------------------

function createMockKv() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace & {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
}

describe("leaderboard RPC handlers", () => {
  let db: ReturnType<typeof createMockDb>;
  let kv: ReturnType<typeof createMockKv>;

  beforeEach(() => {
    db = createMockDb();
    kv = createMockKv();
  });

  it("returns the current authoritative revision", async () => {
    db.first.mockResolvedValue({ revision: "a".repeat(32) });
    const res = await handleLeaderboardRpc({ method: "leaderboard.getRevision" }, db, kv);
    expect(await res.json()).toEqual({ result: "a".repeat(32) });
  });

  // -------------------------------------------------------------------------
  // Filter validation
  // -------------------------------------------------------------------------

  it("answers 400, not 500, when a known filter is not a string", async () => {
    // getLeaderboardSnapshot threw on any non-string value, which surfaced as
    // a 500 through the RPC router — a bad request is the caller's input
    // error, not a server fault.
    const res = await handleLeaderboardRpc(
      { method: "leaderboard.getSnapshot", source: 123 } as unknown as LeaderboardRpcRequest,
      db,
      kv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/filter/i) });
  });

  it("ignores extra request keys instead of failing the snapshot", async () => {
    // Only the five known filters shape the query and the cache key; an extra
    // scalar from a newer/older client (or a junk field) must not turn a
    // readable leaderboard into an error.
    db.first.mockResolvedValue({ revision: "a".repeat(32) });
    db.all.mockResolvedValue({ results: [] });
    const res = await handleLeaderboardRpc(
      {
        method: "leaderboard.getSnapshot",
        fromDate: "2026-04-01T00:00:00.000Z",
        traceId: 42,
      } as unknown as LeaderboardRpcRequest,
      db,
      kv,
    );
    expect(res.status).toBe(200);
  });

  it("accepts a bare YYYY-MM-DD fromDate as a day boundary", async () => {
    db.first.mockResolvedValue({ revision: "a".repeat(32) });
    db.all.mockResolvedValue({ results: [] });
    const res = await handleLeaderboardRpc(
      { method: "leaderboard.getSnapshot", fromDate: "2026-04-01" },
      db,
      kv,
    );
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Unknown method
  // -------------------------------------------------------------------------

  describe("unknown method", () => {
    it("should return 400 for unknown method", async () => {
      const request = { method: "leaderboard.unknown" } as unknown as LeaderboardRpcRequest;
      const response = await handleLeaderboardRpc(request, db, kv);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Unknown leaderboard method");
    });
  });
});
