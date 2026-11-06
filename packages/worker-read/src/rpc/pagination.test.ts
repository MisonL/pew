import { describe, it, expect } from "vitest";
import { clampedLimit, clampedOffset } from "./pagination";

describe("clampedLimit", () => {
  it("keeps an integer inside the range", () => {
    expect(clampedLimit(10, 50, 250)).toBe(10);
    expect(clampedLimit(250, 50, 250)).toBe(250);
  });

  it("falls back when the caller sent nothing", () => {
    expect(clampedLimit(undefined, 50, 250)).toBe(50);
    expect(clampedLimit(null, 50, 250)).toBe(50);
  });

  it("truncates a fractional limit instead of binding it to LIMIT", () => {
    // SQLite answers "datatype mismatch" when LIMIT is bound to 1.9, which
    // surfaced as a 500 on a request the caller could construct with plain JSON.
    expect(clampedLimit(1.9, 50, 250)).toBe(1);
    expect(clampedLimit(-0.5, 50, 250)).toBe(0);
  });

  it("does not clamp negative limits to SQLite's 'no limit'", () => {
    expect(clampedLimit(-1, 50, 250)).toBe(0);
    expect(clampedLimit(-1000, 50, 250)).toBe(0);
  });

  it("caps above the maximum", () => {
    expect(clampedLimit(10_000, 50, 250)).toBe(250);
  });

  it("falls back for non-finite and non-numeric values", () => {
    expect(clampedLimit(Number.NaN, 50, 250)).toBe(50);
    expect(clampedLimit(Number.POSITIVE_INFINITY, 50, 250)).toBe(50);
    expect(clampedLimit("10" as unknown, 50, 250)).toBe(50);
    expect(clampedLimit({} as unknown, 50, 250)).toBe(50);
  });
});

describe("clampedOffset", () => {
  it("keeps a non-negative integer", () => {
    expect(clampedOffset(20)).toBe(20);
    expect(clampedOffset(0)).toBe(0);
  });

  it("defaults to zero when absent", () => {
    expect(clampedOffset(undefined)).toBe(0);
    expect(clampedOffset(null)).toBe(0);
  });

  it("truncates a fractional offset", () => {
    expect(clampedOffset(1.5)).toBe(1);
  });

  it("floors a negative or non-finite offset at zero", () => {
    expect(clampedOffset(-10)).toBe(0);
    expect(clampedOffset(Number.NaN)).toBe(0);
    expect(clampedOffset(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
