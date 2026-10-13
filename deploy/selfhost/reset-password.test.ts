import { describe, it, expect, afterEach } from "vitest";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { hashPasswordForReset, parseArg, resolveBasicAuth } from "./reset-password";

/**
 * Re-implements the web app's verifyPassword() against the storage format.
 * Kept local (rather than importing packages/web/src/lib/credentials.ts) so
 * this deploy test does not drag in the web module graph (next-auth, which
 * does not resolve under the vitest bundler here). If the format drifts, the
 * scrypt$N$r$p$ parse below fails.
 */
function verifyLikeWebApp(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

describe("hashPasswordForReset", () => {
  it("produces a hash the web app's verifyPassword accepts", () => {
    const stored = hashPasswordForReset("reset-me-please");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(verifyLikeWebApp("reset-me-please", stored)).toBe(true);
    expect(verifyLikeWebApp("wrong-password", stored)).toBe(false);
  });

  it("uses a fresh salt each time", () => {
    expect(hashPasswordForReset("x")).not.toBe(hashPasswordForReset("x"));
  });
});

describe("parseArg", () => {
  it("parses --flag value and --flag=value", () => {
    expect(parseArg(["--email", "a@b.c"], "--email")).toBe("a@b.c");
    expect(parseArg(["--email=a@b.c"], "--email")).toBe("a@b.c");
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseArg(["--password", "x"], "--email")).toBeUndefined();
    expect(parseArg([], "--email")).toBeUndefined();
  });
});

// Credential selection (Task 3): resolveBasicAuth mirrors the adapter's rule
// — Basic only when both RQLITE_USERNAME and RQLITE_PASSWORD are set, else no
// credentials at all (token "" + no basicAuth ⇒ d1-adapter sends no header).
describe("resolveBasicAuth", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["RQLITE_USERNAME", "RQLITE_PASSWORD", "CF_D1_API_TOKEN"];

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function snapshotEnv() {
    for (const k of KEYS) saved[k] = process.env[k];
  }

  it("sends NO Authorization when no credentials are configured", () => {
    snapshotEnv();
    delete process.env.RQLITE_USERNAME;
    delete process.env.RQLITE_PASSWORD;
    delete process.env.CF_D1_API_TOKEN;
    expect(resolveBasicAuth()).toBeUndefined();
  });

  it("returns credentials only when both username and password are set", () => {
    snapshotEnv();
    delete process.env.RQLITE_PASSWORD;
    process.env.RQLITE_USERNAME = "pew";
    expect(resolveBasicAuth()).toBeUndefined();
    process.env.RQLITE_PASSWORD = "pw";
    expect(resolveBasicAuth()).toEqual({ username: "pew", password: "pw" });
  });
});
