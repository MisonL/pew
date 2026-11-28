import { describe, expect, it } from "vitest";
import { seasonUpdatedMessage } from "./season-save-message";

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
