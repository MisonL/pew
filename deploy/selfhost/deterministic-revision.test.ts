import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// vitest runs ESM here, so __dirname is not defined.
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/migrations/030-deterministic-leaderboard-revision.sql"
);

describe("030-deterministic-leaderboard-revision.sql", () => {
  let sql: string;

  beforeAll(async () => {
    sql = await readFile(MIGRATION, "utf8");
  });

  it("adds a monotonic counter table", () => {
    expect(sql).toMatch(/CREATE TABLE[^;]*leaderboard_revision_seq/i);
  });

  it("replaces every upstream trigger that used randomblob", () => {
    const names = [
      "leaderboard_user_insert",
      "leaderboard_user_delete",
      "leaderboard_user_update",
      "leaderboard_team_insert",
      "leaderboard_team_delete",
      "leaderboard_team_update",
      "leaderboard_team_member_insert",
      "leaderboard_team_member_delete",
      "leaderboard_team_member_update",
      "leaderboard_org_member_insert",
      "leaderboard_org_member_delete",
      "leaderboard_org_member_update",
    ];
    for (const name of names) {
      expect(sql, `missing DROP for ${name}`).toMatch(
        new RegExp(`DROP TRIGGER IF EXISTS\\s+${name}\\b`, "i")
      );
      expect(sql, `missing CREATE for ${name}`).toMatch(
        new RegExp(`CREATE TRIGGER\\s+${name}\\b`, "i")
      );
    }
  });

  it("contains no non-deterministic functions in trigger bodies", () => {
    const bodies = sql.split(/CREATE TRIGGER/i).slice(1);
    expect(bodies.length).toBeGreaterThanOrEqual(12);
    for (const body of bodies) {
      expect(body).not.toMatch(/randomblob\s*\(/i);
      expect(body).not.toMatch(/datetime\s*\(\s*'now'/i);
    }
  });

  it("formats the revision as 32 lowercase hex digits", () => {
    expect(sql).toMatch(/printf\(\s*'%032x'/i);
  });
});
