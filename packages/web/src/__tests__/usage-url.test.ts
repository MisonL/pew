import { describe, expect, it } from "vitest";
import { buildUsageUrl } from "../lib/usage-url";
import { trailingLocalDays } from "../lib/date-helpers";

function params(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

describe("buildUsageUrl", () => {
  it("sends an exact instant for the days window, not a bare UTC date", () => {
    // A bare YYYY-MM-DD `from` is read by the API as UTC midnight. The client
    // buckets by local day, so east of UTC the oldest local day loses hours
    // and the WoW/MoM percentage built from it is diluted.
    const url = buildUsageUrl({ days: 14, granularity: "half-hour", tzOffset: -480 });
    const q = params(url);
    const window = trailingLocalDays(14, -480);
    expect(q.get("from")).toBe(window.from);
    expect(q.get("from")).toContain("T");
    expect(q.get("to")).toBe(window.to);
  });

  it("passes an explicit from through unchanged and keeps to unset", () => {
    const url = buildUsageUrl({
      days: 30, from: "2026-03-01", granularity: "day", tzOffset: 0,
    });
    const q = params(url);
    expect(q.get("from")).toBe("2026-03-01");
    expect(q.has("to")).toBe(false);
  });

  it("appends tzOffset only for day granularity", () => {
    const day = params(buildUsageUrl({ days: 7, granularity: "day", tzOffset: -480 }));
    expect(day.get("tzOffset")).toBe("-480");
    const half = params(buildUsageUrl({ days: 7, granularity: "half-hour", tzOffset: -480 }));
    expect(half.has("tzOffset")).toBe(false);
  });

  it("carries the accounting and summary modifiers the pages rely on", () => {
    const q = params(buildUsageUrl({
      days: 7, granularity: "day", tzOffset: 0, source: "claude-code",
      deviceId: "dev-1", includeAccounting: "project", summaryOnly: true,
    }));
    expect(q.get("source")).toBe("claude-code");
    expect(q.get("deviceId")).toBe("dev-1");
    expect(q.get("includeAccounting")).toBe("project");
    expect(q.get("summaryOnly")).toBe("1");
  });
});
