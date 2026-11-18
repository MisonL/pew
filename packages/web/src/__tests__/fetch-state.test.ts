import { describe, expect, it } from "vitest";
import { failedToLoad } from "@/lib/fetch-state";

describe("failedToLoad", () => {
  it("is true only when there is no data and an error", () => {
    expect(failedToLoad(undefined, new Error("boom"))).toBe(true);
    // Data survived a revalidation error — keep showing it.
    expect(failedToLoad({ teams: [] }, new Error("boom"))).toBe(false);
    // Still loading: neither branch should claim failure or emptiness.
    expect(failedToLoad(undefined, undefined)).toBe(false);
    expect(failedToLoad(undefined, null)).toBe(false);
  });
});
