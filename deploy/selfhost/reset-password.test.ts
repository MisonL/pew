import { describe, it, expect } from "vitest";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { applyPasswordReset, hashPasswordForReset, parseArg, resolvePassword } from "./reset-password";

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

describe("applyPasswordReset revokes the CLI credential", () => {
  function recordingDb(changes = 1) {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    return {
      calls,
      prepare(sql: string) {
        return {
          bind: (...values: unknown[]) => ({
            run: async () => {
              calls.push({ sql, values });
              return { success: true, results: [], meta: { changes, duration: 0 } };
            },
          }),
        };
      },
    };
  }

  it("nulls api_key and invalidates outstanding auth codes", async () => {
    // Same contract as the web reset path: a one-time CLI login code stays
    // usable for five minutes and mints a fresh key when the user has none,
    // so the reset has to burn them too.
    const db = recordingDb();
    await applyPasswordReset(db, "user-1", "a-long-enough-password");
    expect(db.calls).toHaveLength(2);
    const codes = db.calls[0]!;
    expect(codes.sql).toBe("UPDATE auth_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL");
    expect(codes.values).toEqual(["user-1"]);
    const users = db.calls[1]!;
    expect(users.sql).toContain("api_key = NULL");
    expect(users.values[1]).toBe("user-1");
    // The stored hash still verifies, so the revocation is not accidental.
    expect(verifyLikeWebApp("a-long-enough-password", String(users.values[0]))).toBe(true);
  });

  it("fails when the UPDATE matched no user instead of reporting success", async () => {
    // The preceding SELECT and this UPDATE are two round trips; the row can
    // disappear in between (account deleted, id no longer that user). The
    // script printed "password updated" either way.
    const db = recordingDb(0);
    await expect(applyPasswordReset(db, "user-gone", "a-long-enough-password"))
      .rejects.toThrow(/matched no user/);
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


describe("resolvePassword source priority", () => {
  const noStdin = () => Promise.resolve("");

  it("prefers RQLITE_RESET_PW over every other channel", async () => {
    const pw = await resolvePassword(["--password", "argv-pw"], { RQLITE_RESET_PW: "env-pw" }, () => Promise.resolve("stdin-pw"));
    expect(pw).toBe("env-pw");
  });

  it("reads --password-stdin and trims the trailing newline", async () => {
    const pw = await resolvePassword(["--password-stdin"], {}, () => Promise.resolve("from-stdin\n"));
    expect(pw).toBe("from-stdin");
  });

  it("falls back to the legacy --password argv channel", async () => {
    expect(await resolvePassword(["--password", "argv-pw"], {}, noStdin)).toBe("argv-pw");
    expect(await resolvePassword(["--password=argv-pw"], {}, noStdin)).toBe("argv-pw");
  });

  it("returns undefined when no channel provides a password", async () => {
    expect(await resolvePassword([], {}, noStdin)).toBeUndefined();
    // An empty env value must not shadow the remaining channels.
    expect(await resolvePassword(["--password", "argv-pw"], { RQLITE_RESET_PW: "" }, noStdin)).toBe("argv-pw");
  });
});
