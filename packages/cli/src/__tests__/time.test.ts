import { describe, expect, it } from "vitest";
import { coerceEpochMs } from "../utils/time.js";

describe("coerceEpochMs", () => {
  it("reads seconds and milliseconds", () => {
    expect(coerceEpochMs(1_772_780_000)).toBe(1_772_780_000_000);
    expect(coerceEpochMs(1_772_780_000_000)).toBe(1_772_780_000_000);
    expect(coerceEpochMs("1772780000000")).toBe(1_772_780_000_000);
  });

  it("returns 0 for values that cannot be a Date", () => {
    expect(coerceEpochMs(0)).toBe(0);
    expect(coerceEpochMs(-1)).toBe(0);
    expect(coerceEpochMs("nope")).toBe(0);
    // new Date(1e20).toISOString() throws RangeError; the caller would crash
    // the whole source collector on one corrupt row.
    expect(coerceEpochMs(1e20)).toBe(0);
  });
});