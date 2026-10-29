import { describe, it, expect } from "vitest";
import { appendAll, maxOf } from "../utils/append.js";

// 125k is the smallest argument-list length that overflows V8's stack on the
// Node runtime the published CLI ships with; the old spellings
// (`push(...items)` / `Math.max(acc, ...items)`) threw RangeError here.
const OVERFLOW_LENGTH = 130_000;

describe("appendAll", () => {
  it("appends every item in order", () => {
    const target = [1, 2];
    appendAll(target, [3, 4, 5]);
    expect(target).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns the same array instance", () => {
    const target: number[] = [];
    expect(appendAll(target, [1])).toBe(target);
  });

  it("handles an empty source", () => {
    const target = ["a"];
    appendAll(target, []);
    expect(target).toEqual(["a"]);
  });

  it(`appends ${OVERFLOW_LENGTH} items without overflowing the call stack`, () => {
    const items = Array.from({ length: OVERFLOW_LENGTH }, (_, i) => i);
    const target: number[] = [];
    appendAll(target, items);
    expect(target).toHaveLength(OVERFLOW_LENGTH);
    expect(target[OVERFLOW_LENGTH - 1]).toBe(OVERFLOW_LENGTH - 1);
  });
});

describe("maxOf", () => {
  it("returns the initial value for an empty list", () => {
    expect(maxOf([], 7)).toBe(7);
  });

  it("returns the largest value above the initial value", () => {
    expect(maxOf([3, 9, 4], 0)).toBe(9);
  });

  it("keeps the initial value when every value is smaller", () => {
    expect(maxOf([1, 2], 5)).toBe(5);
  });

  it(`scans ${OVERFLOW_LENGTH} values without overflowing the call stack`, () => {
    const values = Array.from({ length: OVERFLOW_LENGTH }, (_, i) => i);
    expect(maxOf(values, 0)).toBe(OVERFLOW_LENGTH - 1);
  });
});
