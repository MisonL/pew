import { describe, it, expect, vi, beforeEach } from "vitest";
import { canBypassPublic } from "@/lib/profile-access";
import { createMockDbRead } from "./test-utils";
import * as adminModule from "@/lib/admin";

vi.mock("@/lib/admin", () => ({
  isAdmin: vi.fn(),
  isAdminInDb: vi.fn(),
}));

const SESSION = { userId: "viewer", email: "viewer@example.com", via: "session" as const };
const BEARER = { userId: "viewer", email: "viewer@example.com", via: "bearer" as const };

describe("canBypassPublic", () => {
  let db: ReturnType<typeof createMockDbRead>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDbRead();
    vi.mocked(adminModule.isAdmin).mockReturnValue(false);
    vi.mocked(adminModule.isAdminInDb).mockResolvedValue(false);
    db.checkSharedTeam.mockResolvedValue(false);
    db.checkSharedSeason.mockResolvedValue(false);
  });

  it("admits an env-configured admin holding a session", async () => {
    vi.mocked(adminModule.isAdmin).mockReturnValue(true);
    await expect(canBypassPublic(SESSION, db, "target")).resolves.toBe(true);
  });

  it("admits a database-configured admin holding a session", async () => {
    vi.mocked(adminModule.isAdminInDb).mockResolvedValue(true);
    await expect(canBypassPublic(SESSION, db, "target")).resolves.toBe(true);
  });

  it("never treats a Bearer api_key as an admin", async () => {
    // A leaked CLI key must not read private profiles; it is only revoked by a
    // password reset.
    vi.mocked(adminModule.isAdmin).mockReturnValue(true);
    await expect(canBypassPublic(BEARER, db, "target")).resolves.toBe(false);
    expect(adminModule.isAdminInDb).not.toHaveBeenCalled();
  });

  it("admits a teammate", async () => {
    db.checkSharedTeam.mockResolvedValue(true);
    await expect(canBypassPublic(SESSION, db, "target")).resolves.toBe(true);
  });

  it("admits a participant in the same season", async () => {
    db.checkSharedSeason.mockResolvedValue(true);
    await expect(canBypassPublic(SESSION, db, "target")).resolves.toBe(true);
  });

  it("falls through when the team table does not exist", async () => {
    db.checkSharedTeam.mockRejectedValue(new Error("no such table: team_members"));
    db.checkSharedSeason.mockResolvedValue(true);
    await expect(canBypassPublic(SESSION, db, "target")).resolves.toBe(true);
  });

  it("refuses when neither table exists and nothing else matches", async () => {
    db.checkSharedTeam.mockRejectedValue(new Error("no such table: team_members"));
    db.checkSharedSeason.mockRejectedValue(new Error("no such table: season_teams"));
    await expect(canBypassPublic(SESSION, db, "target")).resolves.toBe(false);
  });

  it("reports a read failure as inconclusive instead of denying", async () => {
    // Swallowing every error told a real teammate the private profile did not
    // exist (404) whenever the read worker hiccupped. Only a missing table is
    // a legitimate "fall through"; anything else propagates so the caller can
    // answer 503 and the viewer can retry.
    db.checkSharedTeam.mockRejectedValue(new Error("read worker unavailable"));
    await expect(canBypassPublic(SESSION, db, "target")).rejects.toThrow(/inconclusive/i);
  });

  it("uses the later check's denial only after the earlier one said no", async () => {
    db.checkSharedTeam.mockResolvedValue(false);
    db.checkSharedSeason.mockRejectedValue(new TypeError("fetch failed"));
    await expect(canBypassPublic(SESSION, db, "target")).rejects.toThrow(/inconclusive/i);
  });
});
