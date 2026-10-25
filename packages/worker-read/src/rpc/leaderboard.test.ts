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
  } as unknown as D1Database & {
    prepare: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
    first: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
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
