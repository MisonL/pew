import { describe, it, expect, afterEach } from "vitest";
import { resolveBasicAuth, resolveEnvBasicAuth, resolveReadBasicAuth } from "./basic-auth";

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

// Credential selection over the process environment: Basic only when both
// RQLITE_USERNAME and RQLITE_PASSWORD are set, else no credentials at all
// (token "" + no basicAuth ⇒ d1-adapter sends no header).
describe("resolveEnvBasicAuth", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["RQLITE_USERNAME", "RQLITE_PASSWORD"];

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function snapshotEnv() {
    for (const k of KEYS) saved[k] = process.env[k];
  }

  it("resolves NO credentials when none are configured", () => {
    snapshotEnv();
    delete process.env.RQLITE_USERNAME;
    delete process.env.RQLITE_PASSWORD;
    expect(resolveEnvBasicAuth()).toBeUndefined();
  });

  it("returns credentials only when both username and password are set", () => {
    snapshotEnv();
    delete process.env.RQLITE_PASSWORD;
    process.env.RQLITE_USERNAME = "pew";
    expect(resolveEnvBasicAuth()).toBeUndefined();
    process.env.RQLITE_PASSWORD = "pw";
    expect(resolveEnvBasicAuth()).toEqual({ username: "pew", password: "pw" });
  });
});
