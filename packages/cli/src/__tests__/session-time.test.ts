import { describe, expect, it } from "vitest";
import {
  canonicalInstant,
  durationSeconds,
  type InstantBounds,
  trackInstant,
} from "../utils/session-time.js";

describe("canonicalInstant", () => {
  it("normalizes every accepted ISO spelling to toISOString()", () => {
    expect(canonicalInstant("2026-03-07T10:15:30Z")).toBe("2026-03-07T10:15:30.000Z");
    expect(canonicalInstant("2026-03-07T18:15:30+08:00")).toBe("2026-03-07T10:15:30.000Z");
    // Grok writes microseconds; the contract stores milliseconds.
    expect(canonicalInstant("2026-07-10T00:37:48.494738Z")).toBe("2026-07-10T00:37:48.494Z");
  });

  it("rejects values that are not instants", () => {
    expect(canonicalInstant(undefined)).toBeNull();
    expect(canonicalInstant(null)).toBeNull();
    expect(canonicalInstant(1772780000000)).toBeNull();
    expect(canonicalInstant("garbage")).toBeNull();
    expect(canonicalInstant("March 7, 2026")).toBeNull();
    // Offset-less local time: Date.parse would invent the machine timezone.
    expect(canonicalInstant("2026-03-07T10:15:30")).toBeNull();
    expect(canonicalInstant("2026-03-07")).toBeNull();
  });
});

describe("trackInstant", () => {
  it("keeps the earliest and latest instant by chronology, not by string order", () => {
    const bounds: InstantBounds = { min: null, max: null };
    // Lexicographically "2026-03-07T18:00:00+08:00" sorts after "…11:00:00Z"
    // although it is five hours earlier; the bounds must follow the instant.
    trackInstant(bounds, "2026-03-07T18:00:00+08:00");
    trackInstant(bounds, "2026-03-07T11:00:00Z");
    expect(bounds).toEqual({
      min: "2026-03-07T10:00:00.000Z",
      max: "2026-03-07T11:00:00.000Z",
    });
  });

  it("ignores unparseable values instead of poisoning the bounds", () => {
    const bounds: InstantBounds = { min: null, max: null };
    trackInstant(bounds, "not a timestamp");
    expect(bounds).toEqual({ min: null, max: null });
    trackInstant(bounds, "2026-03-07T10:00:00Z");
    trackInstant(bounds, "garbage");
    expect(bounds).toEqual({
      min: "2026-03-07T10:00:00.000Z",
      max: "2026-03-07T10:00:00.000Z",
    });
  });
});

describe("durationSeconds", () => {
  it("returns whole seconds between two canonical instants", () => {
    expect(durationSeconds("2026-03-07T10:00:00.000Z", "2026-03-07T10:30:00.000Z")).toBe(1800);
  });

  it("returns 0 for an inverted or unparseable pair", () => {
    expect(durationSeconds("2026-03-07T10:30:00.000Z", "2026-03-07T10:00:00.000Z")).toBe(0);
    expect(durationSeconds("garbage", "2026-03-07T10:00:00.000Z")).toBe(0);
  });

  it("clamps to the ingest contract cap", () => {
    // A log whose first line is year 1 and last is 9999 would otherwise emit
    // a duration the server rejects, wedging the session queue.
    expect(durationSeconds("0001-01-01T00:00:00.000Z", "9999-12-31T00:00:00.000Z")).toBe(
      315_576_000,
    );
  });
});
