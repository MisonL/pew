import { describe, it, expect } from "vitest";
import { resolveBasicAuth, resolveReadBasicAuth } from "./basic-auth";

describe("resolveBasicAuth (full credentials)", () => {
  it("returns the pair when both are non-empty", () => {
    expect(resolveBasicAuth("pew", "pw")).toEqual({ username: "pew", password: "pw" });
  });

  it("returns undefined when either side is empty or missing", () => {
    expect(resolveBasicAuth("pew", "")).toBeUndefined();
    expect(resolveBasicAuth("", "pw")).toBeUndefined();
    expect(resolveBasicAuth(undefined, undefined)).toBeUndefined();
    expect(resolveBasicAuth("pew", undefined)).toBeUndefined();
  });
});

describe("resolveReadBasicAuth (read-only with full fallback)", () => {
  it("prefers the read-only pair when set", () => {
    expect(
      resolveReadBasicAuth("pew-ro", "ro-pw", "pew", "full-pw")
    ).toEqual({ username: "pew-ro", password: "ro-pw" });
  });

  it("falls back to the full pair when READ_* are empty or missing", () => {
    // compose injects EMPTY STRINGS for unset ${VAR:-} defaults, so the
    // empty-string case is the realistic fallback path (spec Plan 3 §3.1.2).
    expect(resolveReadBasicAuth("", "", "pew", "full-pw")).toEqual({
      username: "pew",
      password: "full-pw",
    });
    expect(resolveReadBasicAuth(undefined, undefined, "pew", "full-pw")).toEqual({
      username: "pew",
      password: "full-pw",
    });
  });

  it("returns undefined when nothing is configured (auth disabled)", () => {
    expect(resolveReadBasicAuth("", "", "", "")).toBeUndefined();
  });

  it("falls back as a PAIR: one READ_* var alone never mixes users", () => {
    // READ username without READ password must not produce pew-ro with the
    // full password; the whole pair falls back to the full credentials.
    expect(resolveReadBasicAuth("pew-ro", "", "pew", "full-pw")).toEqual({
      username: "pew",
      password: "full-pw",
    });
  });
});
