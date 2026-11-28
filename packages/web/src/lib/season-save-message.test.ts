import { describe, expect, it } from "vitest";
import { seasonCreatedMessage, seasonUpdatedMessage } from "./season-save-message";

describe("seasonUpdatedMessage", () => {
  it("reports plain success when the backfill had no warning", () => {
    expect(seasonUpdatedMessage("Spring", undefined)).toEqual({
      type: "success",
      text: 'Season "Spring" updated.',
    });
  });

  it("surfaces a roster-backfill warning instead of claiming plain success", () => {
    const warning = "Roster backfill failed; run Sync Rosters to retry";
    expect(seasonUpdatedMessage("Spring", warning)).toEqual({
      type: "warning",
      text: `Season "Spring" updated. ${warning}`,
    });
  });

  it("ignores a non-string or empty warning field", () => {
    expect(seasonUpdatedMessage("Spring", null).type).toBe("success");
    expect(seasonUpdatedMessage("Spring", "").type).toBe("success");
    expect(seasonUpdatedMessage("Spring", 42).type).toBe("success");
  });
});

describe("seasonCreatedMessage", () => {
  it("reports plain creation when auto-registration ran", () => {
    expect(seasonCreatedMessage("Spring", undefined)).toEqual({
      type: "success",
      text: 'Season "Spring" created.',
    });
  });

  it("surfaces a failed auto-registration instead of claiming a full roster", () => {
    // The route creates the season and only warns when the best-effort
    // auto-registration threw; a bare "created" implied the teams were in.
    // `auto_registered_teams` is not part of the signal: a pool of zero
    // opted-in teams legitimately registers nothing.
    const warning = "Season created, but automatic team registration failed.";
    expect(seasonCreatedMessage("Spring", warning)).toEqual({
      type: "warning",
      text: `Season "Spring" created. ${warning}`,
    });
  });
});
