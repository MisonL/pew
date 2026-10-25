import { describe, expect, it } from "vitest";
import { dateParamToIso, isBareDate, isDateParam } from "../date-params.js";

describe("date query parameter validation", () => {
  it("accepts a bare date and a full ISO instant", () => {
    expect(isDateParam("2026-03-13")).toBe(true);
    expect(isDateParam("2026-03-13T00:00:00.000Z")).toBe(true);
    expect(isDateParam("2026-03-13T05:30:00+08:00")).toBe(true);
  });

  it.each(["2026-03-99", "2026-13-45", "2026-03-13garbage", "2026-3-13", "", "  "])(
    "rejects %j, which used to pass the unanchored regex and then throw a 500",
    (value) => {
      expect(isDateParam(value)).toBe(false);
    },
  );

  it("rejects calendar days that do not exist, which Date.parse would roll over", () => {
    expect(isDateParam("2026-02-30")).toBe(false);
    expect(isDateParam("2026-04-31")).toBe(false);
    expect(isDateParam("2026-02-29")).toBe(false);
    expect(isDateParam("2024-02-29")).toBe(true);
  });

  it("converts accepted values to UTC ISO", () => {
    expect(dateParamToIso("2026-03-13")).toBe("2026-03-13T00:00:00.000Z");
    expect(dateParamToIso("2026-03-13T05:30:00+08:00")).toBe("2026-03-12T21:30:00.000Z");
  });

  it("recognizes a bare date as the inclusive form", () => {
    expect(isBareDate("2026-03-13")).toBe(true);
    expect(isBareDate("2026-03-13T00:00:00.000Z")).toBe(false);
  });
});
