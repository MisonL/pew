import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createMockDbRead, createMockDbWrite } from "./test-utils";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  getDbRead: vi.fn(),
  getDbWrite: vi.fn(),
}));

import { syncSeasonRosters, syncAllRostersForSeason } from "@/lib/season-roster";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncSeasonRosters", () => {
  let mockDbRead: ReturnType<typeof createMockDbRead>;
  let mockDbWrite: ReturnType<typeof createMockDbWrite>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead = createMockDbRead();
    mockDbWrite = createMockDbWrite();
  });

  it("should no-op when team has no registered active seasons", async () => {
    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce([]);

    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-1");

    // Only the initial query, no further calls
    expect(mockDbRead.listRosterSyncSeasons).toHaveBeenCalledWith("team-1");
    expect(mockDbWrite.execute).not.toHaveBeenCalled();
  });

  it("should no-op when allow_roster_changes=0 (filtered out by query)", async () => {
    // The query filters for allow_roster_changes = 1, so if the season
    // has it disabled, it won't appear in results
    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce([]);

    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-1");

    expect(mockDbRead.listRosterSyncSeasons).toHaveBeenCalledWith("team-1");
    expect(mockDbWrite.execute).not.toHaveBeenCalled();
  });

  it("should add new members when active season allows roster changes", async () => {
    // Active season with roster changes enabled
    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce(["season-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1", "user-2", "user-3"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-1"]);

    mockDbWrite.execute.mockResolvedValue({ changes: 1, duration: 0.01 });

    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-1");

    // Should have 3 queries: active seasons, team members, season members
    expect(mockDbRead.getRosterUserIds).toHaveBeenCalledWith("season-1", "team-1");

    // Should INSERT user-2 and user-3 (not user-1 since already in roster)
    const insertCalls = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("INSERT OR IGNORE"),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]![1]).toContain("user-2");
    expect(insertCalls[1]![1]).toContain("user-3");
  });

  it("should remove departed members when active season allows roster changes", async () => {
    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce(["season-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-1", "user-2"]);

    mockDbWrite.execute.mockResolvedValue({ changes: 1, duration: 0.01 });

    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-1");

    // Should DELETE user-2 (departed from team)
    const deleteCalls = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("DELETE"),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]![1]).toContain("user-2");
  });

  it("should handle INSERT OR IGNORE silently for UNIQUE conflicts", async () => {
    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce(["season-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1", "user-2"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce([]);

    // INSERT OR IGNORE returns changes=0 when UNIQUE constraint fires
    mockDbWrite.execute.mockResolvedValue({ changes: 0, duration: 0.01 });

    // Should not throw
    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-1");

    const insertCalls = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("INSERT OR IGNORE"),
    );
    expect(insertCalls).toHaveLength(2);
  });

  // A user can belong to two teams registered for the same season. The
  // roster UNIQUE(season_id, user_id) lets only one of them hold the user, so
  // joining whichever team loses the race is silently ignored. Nothing
  // revisited that team when the user later left the winning one, so the user
  // ended up on no roster at all and their season usage stopped counting.
  it("adds a user to the roster when they leave the team that held their seat", async () => {
    // team-2 is the team the user just left; team-2's own roster goes down.
    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce(["season-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce([]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-1"]);

    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-2");

    // The freed seat must be offered to the other registered teams whose
    // rosters were denied the user by UNIQUE(season_id, user_id).
    const reassign = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("INSERT OR IGNORE INTO season_team_members") &&
        String(c[0]).includes("NOT EXISTS"),
    );
    expect(reassign.length).toBe(1);
    const [sql, params] = reassign[0] as [string, unknown[]];
    // The re-offer must be scoped to this season, exclude the team that just
    // released the seat, and only apply to rosters that allow changes.
    expect(sql).toContain("st.team_id != ?");
    expect(sql).toContain("allow_roster_changes = 1");
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.slice(1)).toEqual([
      "user-1", // user_id to insert
      "user-1", // team_members join
      "season-1", // season_teams filter
      "team-2", // the team that just released the seat
      "user-1", // ex.* NOT EXISTS guard
    ]);
  });

  it("the re-offer statement runs on real SQLite and moves the seat", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE seasons (id TEXT PRIMARY KEY, start_date TEXT, end_date TEXT, allow_roster_changes INTEGER DEFAULT 0);
      CREATE TABLE teams (id TEXT PRIMARY KEY);
      CREATE TABLE season_teams (id TEXT PRIMARY KEY, season_id TEXT, team_id TEXT);
      CREATE TABLE team_members (team_id TEXT, user_id TEXT, PRIMARY KEY (team_id, user_id));
      CREATE TABLE season_team_members (id TEXT PRIMARY KEY, season_id TEXT, team_id TEXT, user_id TEXT,
        UNIQUE (season_id, user_id));
    `);
    db.exec(`
      INSERT INTO seasons VALUES ('season-1', '2000-01-01T00:00:00Z', '2999-12-31T00:00:00Z', 1);
      INSERT INTO teams VALUES ('team-2'), ('team-3');
      INSERT INTO season_teams VALUES ('st2','season-1','team-2'), ('st3','season-1','team-3');
      INSERT INTO team_members VALUES ('team-2','user-1'), ('team-3','user-1');
      INSERT INTO season_team_members VALUES ('r0','season-1','team-2','user-1');
    `);

    // user-1 leaves team-2: the code deletes their roster row, then re-offers
    // the seat to their other registered team (team-3).
    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce(["season-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce([]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-1"]);
    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-2");

    const calls = mockDbWrite.execute.mock.calls as Array<[string, unknown[]]>;
    for (const [sql, params] of calls) {
      db.prepare(sql).run(...(params as Array<string | number | null>));
    }

    expect(db.prepare("SELECT team_id, user_id FROM season_team_members").all())
      .toEqual([{ team_id: "team-3", user_id: "user-1" }]);
  });

  it("should process multiple active seasons", async () => {    mockDbRead.listRosterSyncSeasons.mockResolvedValueOnce(["season-1", "season-2"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce([]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce([]);

    mockDbWrite.execute.mockResolvedValue({ changes: 1, duration: 0.01 });

    await syncSeasonRosters(mockDbRead as never, mockDbWrite as never, "team-1");

    // 1 (active seasons) + 1 (team members) + 2 (season rosters)
    expect(mockDbRead.getRosterUserIds).toHaveBeenCalledTimes(2);

    // 2 INSERTs (user-1 into each season)
    const insertCalls = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("INSERT OR IGNORE"),
    );
    expect(insertCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// syncAllRostersForSeason
// ---------------------------------------------------------------------------

describe("syncAllRostersForSeason", () => {
  let mockDbRead: ReturnType<typeof createMockDbRead>;
  let mockDbWrite: ReturnType<typeof createMockDbWrite>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead = createMockDbRead();
    mockDbWrite = createMockDbWrite();
  });

  it("should return 0 when no teams are registered", async () => {
    mockDbRead.getRegisteredTeamIds.mockResolvedValueOnce([]);

    const count = await syncAllRostersForSeason(mockDbRead as never, mockDbWrite as never, "season-1");

    expect(count).toBe(0);
    expect(mockDbRead.getRegisteredTeamIds).toHaveBeenCalledWith("season-1");
    expect(mockDbWrite.execute).not.toHaveBeenCalled();
  });

  it("should add missing members for a single team", async () => {
    mockDbRead.getRegisteredTeamIds.mockResolvedValueOnce(["team-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1", "user-2"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-1"]);

    mockDbWrite.execute.mockResolvedValue({ changes: 1, duration: 0.01 });

    const count = await syncAllRostersForSeason(mockDbRead as never, mockDbWrite as never, "season-1");

    expect(count).toBe(1);

    // Should INSERT user-2 only
    const insertCalls = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("INSERT OR IGNORE"),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]![1]).toContain("user-2");
  });

  it("should remove departed members", async () => {
    mockDbRead.getRegisteredTeamIds.mockResolvedValueOnce(["team-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-1", "user-2"]);

    mockDbWrite.execute.mockResolvedValue({ changes: 1, duration: 0.01 });

    const count = await syncAllRostersForSeason(mockDbRead as never, mockDbWrite as never, "season-1");

    expect(count).toBe(1);

    const deleteCalls = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("DELETE"),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]![1]).toContain("user-2");
  });

  it("should handle multiple teams", async () => {
    mockDbRead.getRegisteredTeamIds.mockResolvedValueOnce(["team-1", "team-2"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce([]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-3", "user-4"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-3"]);

    mockDbWrite.execute.mockResolvedValue({ changes: 1, duration: 0.01 });

    const count = await syncAllRostersForSeason(mockDbRead as never, mockDbWrite as never, "season-1");

    expect(count).toBe(2);

    // 1 (season_teams) + 2 (team members) + 2 (season rosters) = 5
    expect(mockDbRead.getRosterUserIds).toHaveBeenCalledTimes(2);

    // 2 INSERTs: user-1 into team-1, user-4 into team-2
    const insertCalls = mockDbWrite.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("INSERT OR IGNORE"),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]![1]).toContain("user-1");
    expect(insertCalls[1]![1]).toContain("user-4");
  });

  it("should no-op when rosters are already in sync", async () => {
    mockDbRead.getRegisteredTeamIds.mockResolvedValueOnce(["team-1"]);
    mockDbRead.getTeamMemberUserIds.mockResolvedValueOnce(["user-1"]);
    mockDbRead.getRosterUserIds.mockResolvedValueOnce(["user-1"]);

    const count = await syncAllRostersForSeason(mockDbRead as never, mockDbWrite as never, "season-1");

    expect(count).toBe(1);
    expect(mockDbWrite.execute).not.toHaveBeenCalled();
  });
});
