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

  it("sends includeAccounting=0 when annotations are switched off", () => {
    const q = params(buildUsageUrl({
      days: 7, granularity: "day", tzOffset: 0, includeAccounting: false,
    }));
    expect(q.get("includeAccounting")).toBe("0");
    // The default (undefined) must not send the flag at all: the API
    // treats an absent param as "full annotations".
    const plain = params(buildUsageUrl({ days: 7, granularity: "day", tzOffset: 0 }));
    expect(plain.has("includeAccounting")).toBe(false);
  });

  it("keeps an explicit to over the days window", () => {
    // manage-devices passes only days; dashboard's yearData passes
    // from+to; a to without from must still win over the computed end.
    const q = params(buildUsageUrl({
      days: 14, granularity: "half-hour", tzOffset: -480, to: "2026-11-01T00:00:00Z",
    }));
    expect(q.get("to")).toBe("2026-11-01T00:00:00Z");
    expect(q.get("from")).toContain("T");
  });
});
