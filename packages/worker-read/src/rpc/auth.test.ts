import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAuthRpc,
  type GetInviteCodeRequest,
  type CheckInviteCodeRequest,
  type GetInviteCodeByIdRequest,
  type ListInviteCodesRequest,
  type GetCodeRequest,
  type UserHasUnusedInviteRequest,
} from "./auth";
import type { D1Database } from "@cloudflare/workers-types";

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

describe("auth RPC handlers", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  // -------------------------------------------------------------------------
  // auth.getInviteCode
  // -------------------------------------------------------------------------

  describe("auth.getInviteCode", () => {
    it("should return invite code when found", async () => {
      const mockCode = {
        id: "i1",
        code: "ABC123",
        used_by: null,
        used_at: null,
        created_at: "2026-01-01T00:00:00Z",
      };
      db.first.mockResolvedValue(mockCode);

      const request: GetInviteCodeRequest = {
        method: "auth.getInviteCode",
        code: "ABC123",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: mockCode });
    });

    it("should return null when not found", async () => {
      db.first.mockResolvedValue(null);

      const request: GetInviteCodeRequest = {
        method: "auth.getInviteCode",
        code: "INVALID",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: null });
    });

    it("should return 400 when code missing", async () => {
      const request = {
        method: "auth.getInviteCode",
        code: "",
      } as GetInviteCodeRequest;
      const response = await handleAuthRpc(request, db);

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // auth.checkInviteCode
  // -------------------------------------------------------------------------

  describe("auth.checkInviteCode", () => {
    it("should return id and used_by when code exists and unused", async () => {
      db.first.mockResolvedValue({ id: 1, used_by: null });

      const request: CheckInviteCodeRequest = {
        method: "auth.checkInviteCode",
        code: "ABC123",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: { id: 1, used_by: null } });
    });

    it("should return id and used_by when code exists and used", async () => {
      db.first.mockResolvedValue({ id: 1, used_by: "u1" });

      const request: CheckInviteCodeRequest = {
        method: "auth.checkInviteCode",
        code: "ABC123",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: { id: 1, used_by: "u1" } });
    });

    it("should return null when code not found", async () => {
      db.first.mockResolvedValue(null);

      const request: CheckInviteCodeRequest = {
        method: "auth.checkInviteCode",
        code: "INVALID",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: null });
    });

    it("should return 400 when code missing", async () => {
      const request = {
        method: "auth.checkInviteCode",
        code: "",
      } as CheckInviteCodeRequest;
      const response = await handleAuthRpc(request, db);

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // auth.getInviteCodeById
  // -------------------------------------------------------------------------

  describe("auth.getInviteCodeById", () => {
    it("should return invite code when found", async () => {
      const mockCode = { id: 1, code: "ABC123", used_by: null };
      db.first.mockResolvedValue(mockCode);

      const request: GetInviteCodeByIdRequest = {
        method: "auth.getInviteCodeById",
        id: 1,
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: mockCode });
    });

    it("should return null when not found", async () => {
      db.first.mockResolvedValue(null);

      const request: GetInviteCodeByIdRequest = {
        method: "auth.getInviteCodeById",
        id: 999,
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: null });
    });

    it("returns 400 when id is missing/undefined", async () => {
      const request = {
        method: "auth.getInviteCodeById",
      } as unknown as GetInviteCodeByIdRequest;
      const response = await handleAuthRpc(request, db);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("id is required");
    });
  });

  // -------------------------------------------------------------------------
  // auth.listInviteCodes
  // -------------------------------------------------------------------------

  describe("auth.listInviteCodes", () => {
    it("should return list of invite codes", async () => {
      const mockCodes = [
        { id: "i1", code: "ABC123", used_by: null, used_at: null, created_at: "2026-01-01T00:00:00Z" },
        { id: "i2", code: "DEF456", used_by: "u1", used_at: "2026-01-02T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
      ];
      db.all.mockResolvedValue({ results: mockCodes });

      const request: ListInviteCodesRequest = {
        method: "auth.listInviteCodes",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: mockCodes });
    });

    it("should filter unused codes when specified", async () => {
      db.all.mockResolvedValue({ results: [] });

      const request: ListInviteCodesRequest = {
        method: "auth.listInviteCodes",
        unused: true,
      };
      await handleAuthRpc(request, db);

      expect(db.prepare).toHaveBeenCalled();
    });

    it("paginates on a stable key so pages cannot repeat or skip rows", async () => {
      // created_at has second precision and is not unique; without the id
      // tiebreaker the order of tied rows is unspecified across OFFSET pages.
      db.all.mockResolvedValue({ results: [] });
      await handleAuthRpc({ method: "auth.listInviteCodes" }, db);

      const sql = db.prepare.mock.calls[0]![0] as string;
      expect(sql).toContain("ORDER BY ic.created_at DESC, ic.id DESC");
    });

    it("clamps a negative limit instead of returning everything", async () => {
      // SQLite reads LIMIT -1 as "no limit".
      db.all.mockResolvedValue({ results: [] });
      await handleAuthRpc({ method: "auth.listInviteCodes", limit: -1 }, db);

      expect(db.bind.mock.calls[0]![0]).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // auth.getCode
  // -------------------------------------------------------------------------

  describe("auth.getCode", () => {
    it("should return auth code when found", async () => {
      const mockCode = {
        code: "XYZ789",
        user_id: "u1",
        expires_at: "2026-01-01T01:00:00Z",
        used_at: null,
        failed_attempts: 0,
      };
      db.first.mockResolvedValue(mockCode);

      const request: GetCodeRequest = {
        method: "auth.getCode",
        code: "XYZ789",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: mockCode });
    });

    it("should return null when not found", async () => {
      db.first.mockResolvedValue(null);

      const request: GetCodeRequest = {
        method: "auth.getCode",
        code: "INVALID",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: null });
    });

    it("should return 400 when code missing", async () => {
      const request = {
        method: "auth.getCode",
        code: "",
      } as GetCodeRequest;
      const response = await handleAuthRpc(request, db);

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // auth.userHasUnusedInvite
  // -------------------------------------------------------------------------

  describe("auth.userHasUnusedInvite", () => {
    it("should return hasUnused: true when user has unused invite", async () => {
      db.first.mockResolvedValue({ id: 1 });

      const request: UserHasUnusedInviteRequest = {
        method: "auth.userHasUnusedInvite",
        userId: "u1",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: { hasUnused: true } });
    });

    it("should return hasUnused: false when no unused invites", async () => {
      db.first.mockResolvedValue(null);

      const request: UserHasUnusedInviteRequest = {
        method: "auth.userHasUnusedInvite",
        userId: "u1",
      };
      const response = await handleAuthRpc(request, db);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ result: { hasUnused: false } });
    });

    it("should return 400 when userId missing", async () => {
      const request = {
        method: "auth.userHasUnusedInvite",
        userId: "",
      } as UserHasUnusedInviteRequest;
      const response = await handleAuthRpc(request, db);

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown method
  // -------------------------------------------------------------------------

  describe("unknown method", () => {
    it("should return 400 for unknown method", async () => {
      const request = { method: "auth.unknown" } as unknown as GetInviteCodeRequest;
      const response = await handleAuthRpc(request, db);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Unknown auth method");
    });
  });
});
